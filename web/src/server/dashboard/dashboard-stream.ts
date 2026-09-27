/**
 * Server-sent events for the organiser dashboard (PRD v2 §5.9, §12 row 13, §17; FR-22;
 * R-5 G-2; the dashboard skill's step 4).
 *
 * ## SSE, not WebSockets
 *
 * The product decision is made (R-5 G-2): "**SSE only, no WebSockets**". The data flow
 * justifies it — the server *pushes*, the client only reads, and every update is a full
 * aggregate that `GET /dashboard` could have produced — so there is nothing for a
 * bidirectional protocol to carry. SSE also rides ordinary HTTP: the same auth cookie,
 * the same status codes, and a `curl` can watch the stream.
 *
 * Public event availability is a different decision and is unchanged: §17 keeps it as
 * "5–10 second polling" on the public page, with no push. This module is organiser-side
 * only, and the availability counters the organiser sees here are the internal ones the
 * public DTO deliberately withholds (§13).
 *
 * ## The 5-second promise, and how a 2-second poll meets it
 *
 * FR-22 requires a check-in to appear on an organiser's dashboard "within 5 seconds". A
 * push from the write path would be faster, and is deliberately not used: it would couple
 * the check-in transaction (rule 07's guarded write, inside an advisory lock) to an
 * open socket, and a client that disconnects mid-broadcast would either block the write or
 * need a retry queue. Polling every 2 seconds puts a hard ceiling of 2s + query time on
 * the propagation, keeps the write path untouched, and costs one indexed aggregate read
 * per dashboard — which is why the aggregate is a `REPEATABLE READ` snapshot rather than
 * four loose queries.
 *
 * ## Why this is a module and not inline route code
 *
 * A route handler that owns a `setInterval`, a `ReadableStream`, an abort listener and a
 * keepalive timer is a route handler that cannot be tested without a real socket. Here the
 * whole lifecycle is a function that takes a signal, a clock, and two intervals, and returns
 * a `ReadableStream<Uint8Array>`. The test drives it with millisecond intervals and a fake
 * clock; the route adds `Response` headers and nothing else.
 *
 * The chunks are **bytes**, not strings, and that is not a preference: `Response`'s
 * `BodyInit` accepts a `ReadableStream<Uint8Array>`, and a stream of strings is a
 * body of the wrong type that only appears to work. Every message is therefore encoded
 * through the single {@link encode} below, so the framing is written once.
 *
 * ## Authorisation happens once, in the route
 *
 * The caller must have already passed the ownership check (via
 * `OperationsService.authoriseEvent`) before calling {@link openDashboardStream}. The
 * stream does not re-resolve a session per tick, and that is a decision rather than an
 * omission: re-authenticating every two seconds would close a dashboard that has been left
 * open all evening, and it protects nothing — the stream is scoped to an event this
 * session already proved it owns, so every tick can only ever re-read that event.
 */

import "server-only";

import type { EventRecord } from "@/domain/events/event";
import { toEventDashboardDTO, type EventDashboardDTO } from "@/domain/operations/operations.dto";
import type { OperationsService } from "@/domain/operations/operations.service";

/**
 * How often the aggregate is re-read.
 *
 * 2 seconds against FR-22's 5-second ceiling, leaving room for the query itself and for
 * a client that spends a moment reconnecting. Not 5: that would put the promise at exactly
 * its limit, so one slow read would break it.
 */
export const DASHBOARD_POLL_INTERVAL_MS = 2_000;

/**
 * How often a bare comment is written when nothing changed.
 *
 * Proxies and load balancers close an idle connection, and a dashboard left open on a
 * quiet event produces no events at all. A comment line (`:`) is the SSE idiom for "still
 * here" — it keeps the socket warm without firing an event in the client.
 */
export const DASHBOARD_KEEPALIVE_INTERVAL_MS = 10_000;

export interface DashboardStreamOptions {
  /** The event whose aggregate is pushed. Already authorised by the caller. */
  readonly event: EventRecord;
  readonly service: OperationsService;
  /** Aborted when the client disconnects; stops the polling and closes the stream. */
  readonly signal: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly keepaliveMs?: number;
  /** Injected for tests; defaults to the real timer. */
  readonly schedule?: (callback: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

/** The event name the first message carries, per the skill's step 4. */
export const DASHBOARD_SNAPSHOT_EVENT = "dashboard.snapshot";

/** The event name every later message carries. */
export const DASHBOARD_UPDATE_EVENT = "dashboard.update";

/**
 * The one place a message becomes bytes.
 *
 * `Response` takes a `ReadableStream<Uint8Array>`, so the stream enqueues encoded frames
 * rather than strings. `TextEncoder` is a global in every runtime this project targets
 * (Node 18+, Edge, browsers), and instantiating it once keeps the encode out of the hot
 * path.
 */
const encoder = new TextEncoder();

function encode(message: string): Uint8Array {
  return encoder.encode(message);
}

/**
 * Open the organiser's dashboard stream.
 *
 * Yields exactly three kinds of message:
 *
 *   - `event: dashboard.snapshot` — the aggregate as it stands at connect time, so a
 *     client that has just opened the page does not need a separate `GET /dashboard` to
 *     render anything, and cannot render a stale first frame from a different instant;
 *   - `event: dashboard.update` — the full aggregate again, **only when it differs**. A
 *     full payload per change (rather than a diff) is deliberate: §17's zero-discrepancy
 *     requirement is about a number matching the rows behind it, and a diff would need its
 *     own reconciliation rules to stay honest;
 *   - `: keepalive` — a comment, never delivered to `addEventListener`.
 *
 * The aggregate is compared by a fingerprint of everything **except** `generated_at`,
 * which changes on every read by definition. Including it would make every poll look like
 * a change and turn a quiet event into a stream of identical payloads.
 */
export function openDashboardStream(options: DashboardStreamOptions): ReadableStream<Uint8Array> {
  const {
    event,
    service,
    signal,
    pollIntervalMs = DASHBOARD_POLL_INTERVAL_MS,
    keepaliveMs = DASHBOARD_KEEPALIVE_INTERVAL_MS,
    schedule = (callback, ms) => setInterval(callback, ms),
    cancel = (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  } = options;

  let previousFingerprint: string | null = null;
  let stopped = false;
  let reading = false;
  const timers: unknown[] = [];

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const stop = (): void => {
        if (stopped) {
          return;
        }

        stopped = true;

        for (const handle of timers) {
          cancel(handle);
        }

        try {
          controller.close();
        } catch {
          // Already closed by a client that disconnected first. Nothing to do: the
          // `stopped` guard above already made this idempotent.
        }
      };

      // An already-aborted signal must not produce one first read: a client that
      // disconnected during the auth check should cost nothing.
      if (signal.aborted) {
        stop();
        return;
      }

      signal.addEventListener("abort", stop, { once: true });

      const publish = (eventName: string, dashboard: EventDashboardDTO): void => {
        controller.enqueue(encode(`event: ${eventName}\ndata: ${JSON.stringify(dashboard)}\n\n`));
      };

      const read = async (): Promise<void> => {
        if (stopped) {
          return;
        }

        // A tick that arrives while the previous aggregate read is still in flight is
        // skipped rather than queued. Overlapping reads would let a *slower* query
        // publish after a faster one, so the dashboard could move backwards; and the next
        // tick is only `pollIntervalMs` away, so nothing is lost by waiting for it.
        if (reading) {
          return;
        }

        reading = true;

        try {
          const dashboard = toEventDashboardDTO(await service.readDashboardForEvent(event));
          const fingerprint = fingerprintOf(dashboard);

          if (fingerprint === previousFingerprint) {
            return;
          }

          // The first read is the snapshot whatever else is true: the client has just
          // connected and has nothing to render, so it is given the whole aggregate
          // rather than a delta against nothing.
          publish(
            previousFingerprint === null ? DASHBOARD_SNAPSHOT_EVENT : DASHBOARD_UPDATE_EVENT,
            dashboard,
          );
          previousFingerprint = fingerprint;
        } catch (error) {
          // A failed poll ends the stream rather than repeating a failure every two
          // seconds. §17's zero-discrepancy promise is better served by stopping than by
          // pushing numbers the server could not assemble: the client falls back to
          // `GET /dashboard`, which reports the failure properly.
          stopped = true;

          for (const handle of timers) {
            cancel(handle);
          }

          controller.error(error);
        } finally {
          reading = false;
        }
      };

      // The first read is immediate, so a client that has just connected sees the
      // snapshot without waiting out a full interval.
      await read();

      if (stopped) {
        return;
      }

      timers.push(schedule(() => void read(), pollIntervalMs));
      timers.push(
        schedule(() => {
          if (!stopped) {
            controller.enqueue(encode(": keepalive\n\n"));
          }
        }, keepaliveMs),
      );
    },

    cancel() {
      stopped = true;

      for (const handle of timers) {
        cancel(handle);
      }
    },
  });
}

/**
 * The part of a dashboard that decides whether anything changed.
 *
 * `generated_at` and `event` are excluded: the first changes on every read, and the second
 * is fixed for the life of an event. Everything an organiser can act on is included, so a
 * change in any of them pushes a new payload and a change in none of them pushes nothing.
 */
function fingerprintOf(dashboard: EventDashboardDTO): string {
  return JSON.stringify({
    registrations: dashboard.registrations,
    payments: dashboard.payments,
    ticket_types: dashboard.ticket_types,
    check_ins: dashboard.check_ins,
  });
}
