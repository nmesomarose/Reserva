import { getOperationsService } from "@/server/db/container";
import { organiserContextResolver } from "@/server/auth/organiser-context";
import { openDashboardStream } from "@/server/dashboard/dashboard-stream";
import { toErrorResponse } from "@/server/http/error-response";
import { requirePathUuid } from "@/server/validation/validation";

/**
 * `GET /api/v1/events/{id}/dashboard/stream` — live check-in updates for an organiser
 * (PRD v2 §5.9, §12 row 13; auth: **Organiser, event owner**; FR-22; R-5 G-2, "SSE only,
 * no WebSockets").
 *
 * ## The order of the first three lines is the security property
 *
 *   1. resolve the session,
 *   2. check that this session owns `{identifier}`,
 *   3. *then* open the socket.
 *
 * An ownership failure must be an ordinary `403`/`404` **response**, and that is only
 * possible while nothing has been streamed yet: once `200 OK` with
 * `Content-Type: text/event-stream` is on the wire, a later failure can only be an event
 * inside the stream, and the client has already been told it is authorised. So the check
 * is not merely "done first" — it is done before the first byte, and the route returns
 * through `toErrorResponse` like any other if it fails.
 *
 * After that the stream does **not** re-authorise per tick. This is the deliberate
 * position `dashboard-stream.ts` argues in full: a dashboard left open for an evening
 * would be closed by a session re-check every two seconds, and nothing is gained, because
 * the tick can only re-read the event this session already proved it owns.
 *
 * ## The headers
 *
 * `text/event-stream` is the point of the endpoint. `Cache-Control: no-cache` and
 * `Connection: keep-alive` are what stop an intermediary from buffering a stream that is
 * *meant* to be current — a proxy that buffers turns a 2-second update into a 30-second
 * one and breaks FR-22 while every header looks correct. `X-Accel-Buffering: no` disables
 * nginx's own buffering, which is the single most common way a working SSE endpoint
 * arrives at a browser delayed and is diagnosed as a bug in the app.
 *
 * `runtime = "nodejs"` and `dynamic = "force-dynamic"`: this is a long-lived streaming
 * handler on a real socket, not a static or edge function, and the route must never be
 * cached or prerendered.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ identifier: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    // Ownership is settled here, before the response exists, so a non-owner's request
    // gets a real status code rather than an error event inside a stream it was never
    // entitled to open. The path segment is validated first for the same reason the
    // other organiser routes do it: the ownership read casts it to `uuid`, so a typo
    // would otherwise be a `500` rather than a `400` - and on this route a `500` after
    // `200 OK` is not even available, so the check has to happen while a status code can
    // still be sent.
    const event = await getOperationsService().authoriseEvent(
      organiser.organiserId,
      requirePathUuid(identifier, "identifier"),
    );

    return new Response(openDashboardStream({ event, service: getOperationsService(), signal: request.signal }), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
