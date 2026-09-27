import { describe, expect, it, vi } from "vitest";

/**
 * The dashboard SSE stream (PRD v2 §5.9, §12 row 13; FR-22; R-5 G-2).
 *
 * Extracted from its route precisely so it can be driven without a socket: the module
 * takes its intervals as numbers and its timers as functions, so a test can fire "2
 * seconds passed" synchronously and assert on the exact bytes that come out.
 *
 * The properties worth proving, in rough order of how badly they hurt when broken:
 *
 *   - the chunks are **bytes**. A stream of strings is a `BodyInit` of the wrong type
 *     that only appears to work until a runtime checks it, so this is asserted first.
 *   - the first frame is `dashboard.snapshot` and later ones `dashboard.update`, so a
 *     client opening the page can render immediately.
 *   - an unchanged aggregate pushes **nothing**. The alternative is one identical payload
 *     every two seconds for an entire evening.
 *   - a *failed* read ends the stream rather than repeating the failure, and the client
 *     can fall back to `GET /dashboard`.
 *   - the read that finishes **last** is not the one that gets published, so the
 *     dashboard cannot move backwards.
 *   - aborting stops the timers, so a disconnected client does not keep the aggregate
 *     being queried.
 */

import type { EventRecord } from "@/domain/events/event";
import type { EventDashboardRecord } from "@/domain/operations/operations";
import type { OperationsService } from "@/domain/operations/operations.service";
import { toEventDashboardDTO } from "@/domain/operations/operations.dto";
import {
  DASHBOARD_KEEPALIVE_INTERVAL_MS,
  DASHBOARD_POLL_INTERVAL_MS,
  DASHBOARD_SNAPSHOT_EVENT,
  DASHBOARD_UPDATE_EVENT,
  openDashboardStream,
} from "@/server/dashboard/dashboard-stream";

const EVENT: EventRecord = {
  id: "22222222-2222-2222-2222-222222222222",
  organiserId: "11111111-1111-1111-1111-111111111111",
  name: "Jazz Night",
  slug: "jazz-night",
  description: "Two sets of improvised jazz.",
  startsAt: new Date("2026-10-01T18:00:00Z"),
  endsAt: new Date("2026-10-01T22:00:00Z"),
  venue: "Riverside Hall",
  status: "published",
  createdAt: new Date("2026-09-26T12:00:00Z"),
  updatedAt: new Date("2026-09-26T13:00:00Z"),
  deletedAt: null,
};

interface StreamHarness {
  readonly stream: ReadableStream<Uint8Array>;
  /** Fire every callback registered for `ms`, as a real timer would. */
  readonly advance: (ms: number) => Promise<void>;
  /** Fire the poll callback and wait for the read it starts to settle. */
  readonly poll: () => Promise<void>;
  readonly keepalive: () => Promise<void>;
  readonly scheduled: ReadonlyArray<readonly [number, () => void]>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly chunks: () => string[];
  readonly frames: () => Array<{ event: string; data: unknown }>;
  readonly closed: () => boolean;
  readonly errored: () => boolean;
  readonly error: () => unknown;
  /** Simulate the client hanging up, which is what a browser does on a closed tab. */
  readonly disconnect: () => Promise<void>;
}

function harness(
  service: Partial<OperationsService>,
  options: { readonly signal?: AbortSignal } = {},
): StreamHarness {
  const scheduled: Array<[number, () => void]> = [];
  const cancel = vi.fn();
  const controller = new AbortController();

  // Each scheduled callback's in-flight promise is tracked so a test can await the work
  // a tick started, which is what makes "the later read must not win" testable without
  // sleeping.
  const inflight = new Set<Promise<unknown>>();

  const schedule = (callback: () => void, ms: number): unknown => {
    const handle = { ms };
    scheduled.push([ms, () => {
      const result = callback() as unknown;
      if (result instanceof Promise) {
        inflight.add(result);
        void result.finally(() => inflight.delete(result));
      }
    }]);
    return handle;
  };

  const drain = async (): Promise<void> => {
    // Two passes: a read can itself schedule nothing, but a `read` that publishes
    // synchronously after an `await` needs one more turn of the microtask queue.
    for (let pass = 0; pass < 3 && inflight.size > 0; pass += 1) {
      await Promise.all([...inflight]);
    }
  };

  const stream = openDashboardStream({
    event: EVENT,
    service: service as OperationsService,
    signal: options.signal ?? controller.signal,
    schedule,
    cancel,
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const received: string[] = [];
  let closed = false;
  let errored = false;
  let failure: unknown;

  // Draining in the background: the stream stays open for the whole test, and an
  // unconsumed stream's queue is exactly where a `enqueue` after close would show up.
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          return;
        }
        received.push(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      errored = true;
      failure = error;
    }
  })();

  return {
    stream,
    scheduled,
    cancel,
    chunks: () => [...received],
    frames: () =>
      received
        .join("")
        .split("\n\n")
        .filter((chunk) => chunk.trim() !== "" && !chunk.startsWith(":"))
        .map((chunk) => {
          const lines = chunk.split("\n");
          const name = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
          const payload = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
          return { event: name, data: JSON.parse(payload) as unknown };
        }),
    closed: () => closed,
    errored: () => errored,
    error: () => failure,
    // `reader.cancel()`, not `stream.cancel()`: the harness holds a reader, and a
    // `ReadableStream` with an active reader is locked — cancelling it directly throws
    // `ERR_INVALID_STATE`, which would test the harness rather than the module.
    disconnect: () => reader.cancel().then(() => undefined),
    async advance(ms) {
      for (const [interval, callback] of scheduled) {
        if (interval === ms) {
          callback();
        }
      }
      await drain();
    },
    async poll() {
      await this.advance(DASHBOARD_POLL_INTERVAL_MS);
    },
    async keepalive() {
      await this.advance(DASHBOARD_KEEPALIVE_INTERVAL_MS);
    },
  };
}

/**
 * The service returns an `EventDashboardRecord` — camelCase, with real `Date`s — and the
 * module maps it through the real `toEventDashboardDTO` before framing. The fixture is
 * therefore built as a record and compared against the module's own DTO, so a change to
 * either side is visible here instead of being papered over by a hand-written payload.
 */
const recordWith = (checkedIn: number, overrides = 0): EventDashboardRecord => ({
  event: {
    id: EVENT.id,
    name: EVENT.name,
    slug: EVENT.slug,
    status: EVENT.status,
    startsAt: EVENT.startsAt,
    endsAt: EVENT.endsAt,
    venue: EVENT.venue,
  },
  registrations: {
    total: 10,
    byStatus: {
      pending_payment: 1,
      confirmed: 7,
      checked_in: checkedIn,
      cancelled: 1,
      refunded: 0,
    },
  },
  payments: {
    attempts: 9,
    byStatus: { initiated: 0, processing: 0, success: 8, failed: 1, pending: 0 },
    requiresReconciliation: 0,
  },
  ticketTypes: [
    {
      ticketTypeId: "33333333-3333-3333-3333-333333333333",
      name: "General Admission",
      priceMinorUnits: 2500,
      currency: "USD",
      quantityTotal: 100,
      quantityConfirmed: 7,
      quantityHeld: 1,
      // BR-3: `available` is derived by the repository as `total - confirmed - held`,
      // not stored, and `soldOut` is `available <= 0` in the public page's own terms.
      available: 92,
      soldOut: false,
    },
  ],
  checkIns: { registrationsCheckedIn: checkedIn, entries: checkedIn, overrides },
  generatedAt: new Date("2026-10-01T18:30:00.000Z"),
});

const serviceReturning = (...records: EventDashboardRecord[]): Partial<OperationsService> => {
  let call = 0;

  return {
    readDashboardForEvent: vi.fn(() => {
      const next = records[Math.min(call, records.length - 1)];
      call += 1;
      return Promise.resolve(next);
    }),
  } as Partial<OperationsService>;
};

describe("the dashboard stream", () => {
  it("polls every 2 seconds and keepalives every 10, well inside FR-22's 5 seconds", () => {
    // The numbers are the promise: 2s + query time is the ceiling on how long a
    // check-in takes to appear, against a 5-second requirement.
    expect(DASHBOARD_POLL_INTERVAL_MS).toBe(2_000);
    expect(DASHBOARD_KEEPALIVE_INTERVAL_MS).toBe(10_000);
    expect(DASHBOARD_POLL_INTERVAL_MS).toBeLessThan(5_000);
  });

  it("enqueues bytes, not strings", async () => {
    // `Response`'s `BodyInit` takes `ReadableStream<Uint8Array>`. A string body is the
    // wrong type and fails at runtime rather than at compile time, so the chunk type is
    // asserted rather than assumed from the generic.
    const stream = openDashboardStream({
      event: EVENT,
      service: serviceReturning(recordWith(0)) as OperationsService,
      signal: new AbortController().signal,
      schedule: (callback) => {
        void callback;
        return 0;
      },
    });

    const chunk = await stream.getReader().read();

    expect(chunk.done).toBe(false);
    expect(chunk.value).toBeInstanceOf(Uint8Array);
  });

  it("sends a snapshot immediately, without waiting out an interval", async () => {
    // A client that has just opened the page has nothing to render, so the first frame
    // is the whole aggregate rather than a delta against nothing.
    const service = serviceReturning(recordWith(2));

    const h = harness(service);
    await Promise.resolve();
    await Promise.resolve();

    expect(service.readDashboardForEvent).toHaveBeenCalledTimes(1);
    expect(h.frames()).toHaveLength(1);
    expect(h.frames()[0]?.event).toBe(DASHBOARD_SNAPSHOT_EVENT);
    // The authorised event is what the read is scoped to, on every tick.
    expect(service.readDashboardForEvent).toHaveBeenCalledWith(EVENT);
  });

  it("sends a full payload in the snapshot, not just the counters that changed", async () => {
    const h = harness(serviceReturning(recordWith(2)));
    await Promise.resolve();
    await Promise.resolve();

    // A client that has just connected must be able to render the whole dashboard from
    // this one frame, so the aggregate is complete — byte-for-byte what
    // `GET /dashboard` would have returned, because it is the same service and the same
    // mapping.
    expect(h.frames()[0]?.data).toEqual(toEventDashboardDTO(recordWith(2)));
  });

  it("sends dashboard.update for a later change", async () => {
    const h = harness(serviceReturning(recordWith(2), recordWith(5)));
    await Promise.resolve();
    await Promise.resolve();

    await h.poll();

    expect(h.frames().map((frame) => frame.event)).toEqual([
      DASHBOARD_SNAPSHOT_EVENT,
      DASHBOARD_UPDATE_EVENT,
    ]);
    expect(h.frames()[1]?.data).toEqual(toEventDashboardDTO(recordWith(5)));
  });

  it("sends nothing when the aggregate has not changed", async () => {
    // `generatedAt` changes on every read by definition; including it in the comparison
    // would make every poll look like a change and turn a quiet event into a stream of
    // identical payloads for an entire evening.
    const h = harness(serviceReturning(recordWith(2), recordWith(2), recordWith(2)));
    await Promise.resolve();
    await Promise.resolve();

    await h.poll();
    await h.poll();

    expect(h.frames()).toHaveLength(1);
  });

  it("treats a changed generated_at alone as no change", async () => {
    const second: EventDashboardRecord = {
      ...recordWith(2),
      generatedAt: new Date("2026-10-01T18:35:00.000Z"),
    };

    const h = harness(serviceReturning(recordWith(2), second));
    await Promise.resolve();
    await Promise.resolve();

    await h.poll();

    expect(h.frames()).toHaveLength(1);
  });

  it("treats a changed registration count as a change", async () => {
    // The complement of the previous test: if the fingerprint excluded too much, this
    // would publish nothing and the dashboard would silently go stale — the failure the
    // keepalive comment exists to disguise.
    // `recordWith(2)` has seven confirmed registrations, so this moves the number rather
    // than restating it — an accidental no-op would make the test pass for the wrong
    // reason and hide a fingerprint that had stopped noticing check-ins altogether.
    const changed: EventDashboardRecord = {
      ...recordWith(2),
      registrations: {
        ...recordWith(2).registrations,
        byStatus: { ...recordWith(2).registrations.byStatus, confirmed: 8 },
      },
    };

    const h = harness(serviceReturning(recordWith(2), changed));
    await Promise.resolve();
    await Promise.resolve();

    await h.poll();

    expect(h.frames()).toHaveLength(2);
  });

  it("writes a comment, not an event, for a keepalive", async () => {
    const h = harness(serviceReturning(recordWith(2)));
    await Promise.resolve();
    await Promise.resolve();

    await h.keepalive();

    // A keepalive that arrived as a named event would wake every listener on the page
    // for no reason.
    expect(h.chunks().join("")).toContain(": keepalive");
    expect(h.frames()).toHaveLength(1);
  });

  it("keeps the socket open with keepalives while nothing changes", async () => {
    // Proxies close idle connections, and a quiet event produces no events at all.
    const h = harness(serviceReturning(recordWith(2), recordWith(2), recordWith(2)));
    await Promise.resolve();
    await Promise.resolve();

    await h.keepalive();
    await h.keepalive();

    expect(h.closed()).toBe(false);
    expect(h.errored()).toBe(false);
  });

  it("ends the stream when a read fails, rather than repeating the failure", async () => {
    const failure = new Error("The dashboard aggregate could not be read.");
    const service = {
      readDashboardForEvent: vi
        .fn()
        .mockResolvedValueOnce(recordWith(2))
        .mockRejectedValue(failure),
    };

    const h = harness(service as Partial<OperationsService>);
    await Promise.resolve();
    await Promise.resolve();

    await h.poll();

    // Pushing numbers the server could not assemble would violate §17's zero-discrepancy
    // promise; the client falls back to `GET /dashboard`, which reports it properly.
    expect(h.errored()).toBe(true);
    expect(h.error()).toBe(failure);
    expect(h.cancel).toHaveBeenCalled();
  });

  it("stops polling after a failure instead of repeating it every two seconds", async () => {
    const service = {
      readDashboardForEvent: vi.fn().mockRejectedValue(new Error("read failed")),
    };

    const h = harness(service as Partial<OperationsService>);
    await Promise.resolve();
    await Promise.resolve();

    const callsAfterFirst = (service.readDashboardForEvent as ReturnType<typeof vi.fn>).mock.calls.length;

    await h.poll();

    expect((service.readDashboardForEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterFirst,
    );
  });

  it("skips a poll that arrives while the previous read is still in flight", async () => {
    // The overlap guard, and the reason it exists.
    //
    // Without it, a slow read for state `7` and a fast read for state `99` that started
    // two seconds later would both publish, and the dashboard would go 7 → 99 → 7: a
    // number the organiser watched climb would fall back, which is a lie the rows behind
    // it do not support. With it, the second read is dropped and only `7` is published;
    // the next tick re-reads and delivers `99`. The cost is at most one interval of
    // staleness, and the price of not paying it is a dashboard that moves backwards.
    const older = recordWith(7);
    const newer = recordWith(99);

    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolveGate) => {
      releaseSlow = resolveGate;
    });

    let call = 0;
    const read = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(recordWith(2));
      }
      return call === 2 ? slowGate.then(() => older) : Promise.resolve(newer);
    });

    const h = harness({ readDashboardForEvent: read } as Partial<OperationsService>);
    await Promise.resolve();
    await Promise.resolve();

    // The snapshot, then a slow tick, then a tick that lands while the slow one is open.
    h.scheduled.find(([ms]) => ms === DASHBOARD_POLL_INTERVAL_MS)?.[1]();
    await Promise.resolve();
    h.scheduled.find(([ms]) => ms === DASHBOARD_POLL_INTERVAL_MS)?.[1]();
    await Promise.resolve();

    // The third read was never started: the guard returns before calling the service.
    expect(read).toHaveBeenCalledTimes(2);

    releaseSlow?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.frames().map((frame) => frame.event)).toEqual([
      DASHBOARD_SNAPSHOT_EVENT,
      DASHBOARD_UPDATE_EVENT,
    ]);
    expect(h.frames()[1]?.data).toEqual(toEventDashboardDTO(older));

    // And the stream is not left stuck on the stale value: the next tick delivers `99`.
    await h.poll();

    expect(h.frames()).toHaveLength(3);
    expect(h.frames()[2]?.data).toEqual(toEventDashboardDTO(newer));
  });

  it("stops the timers when the client disconnects", async () => {
    const h = harness(serviceReturning(recordWith(2)));
    await Promise.resolve();
    await Promise.resolve();

    await h.disconnect();

    // A disconnected dashboard that kept polling would query the aggregate for an
    // organiser who is not looking at it, for as long as the process lives.
    expect(h.cancel).toHaveBeenCalled();
  });

  it("does no work at all for a signal that was already aborted", async () => {
    // A client that disconnected during the ownership check should cost nothing — and
    // certainly should not receive a snapshot.
    const controller = new AbortController();
    controller.abort();
    const service = serviceReturning(recordWith(2));

    const h = harness(service, { signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();

    expect(service.readDashboardForEvent).not.toHaveBeenCalled();
    expect(h.closed()).toBe(true);
  });

  it("closes the stream when the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const h = harness(serviceReturning(recordWith(2), recordWith(3)), {
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.cancel).toHaveBeenCalled();
    expect(h.closed() || h.errored()).toBe(true);
  });

  it("frames every message with a blank line, so a client can find the end", async () => {
    // SSE's framing rule: a message ends at a blank line. A missing one makes a client
    // wait forever for the rest of a frame it has already been sent.
    const h = harness(serviceReturning(recordWith(2)));
    await Promise.resolve();
    await Promise.resolve();

    await h.keepalive();

    for (const chunk of h.chunks()) {
      expect(chunk.endsWith("\n\n")).toBe(true);
    }
  });

  it("names the event before the data, as the SSE grammar requires", async () => {
    const h = harness(serviceReturning(recordWith(2)));
    await Promise.resolve();
    await Promise.resolve();

    const chunk = h.chunks()[0] ?? "";

    expect(chunk.indexOf("event: ")).toBeLessThan(chunk.indexOf("data: "));
  });
});
