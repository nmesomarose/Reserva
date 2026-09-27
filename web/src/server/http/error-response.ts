/**
 * The single HTTP error renderer (PRD v2 §15, `.agents/rules/06`).
 *
 * Every `/api/v1` route funnels failures through `toErrorResponse`, which is
 * what makes "one consistent error shape across all endpoints" true by
 * construction rather than by convention.
 *
 * Body shape:
 *
 *   { "error": { "code": "...", "message": "...", "fields": { "<field>": ["..."] } } }
 *
 * `fields` is present only for `validation_failed`.
 *
 * Two things are deliberately absent from every response: stack traces and
 * database/provider internals. An unrecognised error becomes a generic `500`
 * with a fixed message; the detail stays in the server log, because leaking SQL
 * or a driver error to a client discloses schema and infrastructure (AGENTS.md
 * §14).
 */

import { NextResponse } from "next/server";

import {
  DomainError,
  NotFoundError,
  ValidationError,
  type DomainErrorCode,
} from "@/domain/errors";

/** PRD §12/§15 status codes. */
const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  // `unauthenticated` is `403` and not `401` because the source of truth defines
  // no `401`: PRD §15 L421 and `.agents/rules/06` both assign `403` to
  // access-control failure, and the auth decision (2026-09-26) was to apply the
  // documented convention rather than introduce a code the contract does not
  // contain. See `UnauthenticatedError` for why it is still a distinct `code`.
  unauthenticated: 403,
};

const GENERIC_INTERNAL_MESSAGE = "An unexpected error occurred.";

function errorBody(
  code: string,
  message: string,
  fields?: Record<string, readonly string[]>,
): { error: { code: string; message: string; fields?: Record<string, readonly string[]> } } {
  return fields === undefined
    ? { error: { code, message } }
    : { error: { code, message, fields } };
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ValidationError) {
    return json(
      errorBody(error.code, error.message, { ...error.issues }),
      STATUS_BY_CODE[error.code],
    );
  }

  if (error instanceof NotFoundError) {
    return json(errorBody(error.code, error.message), STATUS_BY_CODE.not_found);
  }

  if (error instanceof DomainError) {
    return json(errorBody(error.code, error.message), STATUS_BY_CODE[error.code]);
  }

  return json(errorBody("internal_error", GENERIC_INTERNAL_MESSAGE), 500);
}
