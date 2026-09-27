/**
 * Caching policy for responses that carry per-attendee or per-organiser state.
 *
 * A `200` is cacheable by default, and `dynamic = "force-dynamic"` does not change
 * that: it tells Next not to prerender or to keep the *route* in its own data cache, and
 * says nothing about a browser, a CDN, or a corporate proxy storing the response and
 * handing it to the next person who asks. For a body containing an attendee's email
 * address, an organiser's payment state, or a raw provider payload, that is precisely the
 * disclosure this product's premise forbids — the same reasoning that put `no-store` on
 * `GET /payments/verify`, generalised here so the policy is stated once.
 *
 * Deliberately *not* applied to the SSE route: a stream is uncacheable by the nature of
 * being a stream, and it sets `no-cache, no-transform` plus `X-Accel-Buffering: no`
 * because there the requirement is not storage but buffering, which is a different
 * failure with a different header.
 *
 * `no-store` is stronger than `no-cache`: it forbids storing the response at all, rather
 * than allowing storage and requiring revalidation, which is what is wanted when the
 * stored copy is itself the problem.
 */
export const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;
