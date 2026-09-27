/**
 * Domain error taxonomy.
 *
 * Framework- and database-agnostic (PRD v2 §15, AGENTS.md §4). Route handlers
 * translate these into HTTP responses in one place (`src/server/http`), so the
 * domain never knows what a status code is.
 *
 * Every error carries a stable machine-readable `code`. That code is part of the
 * API contract and must not be reworded casually — a client branches on it.
 */

export type DomainErrorCode =
  | "validation_failed"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "unauthenticated";

/** Field-level detail for a rejected request, keyed by request field name. */
export type FieldIssues = Readonly<Record<string, readonly string[]>>;

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

/**
 * A request was understood but is not acceptable. Carries field-level detail so
 * the `400` body can point at the offending field (PRD v2 §12).
 */
export class ValidationError extends DomainError {
  readonly issues: FieldIssues;

  constructor(message: string, issues: FieldIssues) {
    super("validation_failed", message);
    this.issues = issues;
  }
}

/**
 * The resource does not exist, or exists but is not visible to this caller.
 *
 * The two cases are deliberately the *same* error: a public event read must not
 * reveal that a draft or soft-deleted event exists, so "no such event" and "not
 * published" are indistinguishable to the client.
 */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super("not_found", message);
  }
}

/** The request collides with existing state (e.g. a unique constraint). */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super("conflict", message);
  }
}

/**
 * The caller is authenticated but not permitted to touch this resource.
 *
 * Kept distinct from `NotFoundError` on purpose: `.agents/rules/06` assigns
 * `403` to "access-control failure" and `404` to "genuinely does not exist", so
 * a cross-owner read must not be dressed up as a missing resource. The service
 * reaches that distinction by loading the row and comparing its owner.
 */
export class ForbiddenError extends DomainError {
  constructor(message: string) {
    super("forbidden", message);
  }
}

/**
 * The requested state change is not legal from the resource's current state
 * (`.agents/rules/03`).
 *
 * Rendered as `409`, not `400`: the request was well-formed, but it collides
 * with the state the resource is in — the same reason a sold-out tier is a `409`.
 */
export class IllegalTransitionError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = "IllegalTransitionError";
  }
}

/**
 * The request carried no valid organiser session.
 *
 * WHY `403` AND NOT `401`, which is the unusual part of this class:
 *
 *   PRD v2 §15 L421 assigns `403` to access-control failure and never mentions
 *   `401`; `.agents/rules/06` repeats that and does not list `401` either. The
 *   only access-control code in the source of truth is `403`, and the
 *   product-owner decision for auth (2026-09-26) was to apply the documented
 *   convention rather than invent a status code the contract does not define.
 *   The convention is also the fail-closed one: an unauthenticated caller is
 *   refused, never treated as an anonymous principal.
 *
 * A separate class with its own `code` even though both render as `403`, because
 * they mean different things to a client: this one is fixed by signing in,
 * `ForbiddenError` is not fixed by signing in. Collapsing them would leave a
 * client unable to decide whether to show a login prompt or a permission error.
 */
export class UnauthenticatedError extends DomainError {
  constructor(message: string) {
    super("unauthenticated", message);
  }
}
