import "server-only";

/**
 * Centralised, validated access to server-side environment configuration.
 *
 * Rules that apply here:
 *  - `.agents/rules/06-api-contract-and-validation.md` requires validation to be
 *    centralised, not scattered per endpoint. Environment access is the same
 *    concern: one place reads process.env, validates it, and fails clearly.
 *  - `AGENTS.md §14`: secrets are never logged. This module reports *names* of
 *    missing variables, never their values.
 *  - `import "server-only"` makes it a build error for any Client Component to
 *    reach this module, so database credentials and provider secrets cannot
 *    accidentally enter the client bundle.
 *
 * Only variables the application itself needs are declared. The Flutterwave
 * variables are read by a *separate* accessor, {@link getPaymentEnv}, rather than
 * being folded into `getServerEnv`, and the reason is a layering one: the payment
 * integration is not required for the event slice, so making its secrets a startup
 * requirement would make a working deployment fail because an optional feature is
 * unconfigured — and would make every database-backed test depend on payment
 * credentials. Instead the payment endpoints fail loudly, by name, the first time
 * one is actually used.
 *
 * ## Why `FLUTTERWAVE_REDIRECT_BASE_URL` is optional and validated as a URL
 *
 * `POST /payments` takes a `redirect_url`, and the port models it as nullable
 * because a deployment may have no public origin configured — in which case payment
 * completes by webhook alone, which PRD §8.6 makes the governing channel anyway. So
 * absent is a supported state, not a misconfiguration, and it must not fail startup.
 * *Present but not an absolute http(s) URL* is a different thing: it is a value that
 * would be sent to the provider and then fail at the attendee, after a hold had been
 * taken. That is rejected at read time instead.
 *
 * There is no session secret: sessions are opaque random tokens stored as a SHA-256
 * hash and matched by lookup, so no signing key exists to configure.
 */

const REQUIRED_SERVER_ENV = ["DATABASE_URL"] as const;

/** Secrets needed before any payment-adjacent endpoint can answer. */
const REQUIRED_PAYMENT_ENV = [
  "FLUTTERWAVE_SECRET_KEY",
  "FLUTTERWAVE_WEBHOOK_SECRET",
] as const;

/** The live API base, overridable so a test can point the adapter at a stub. */
const DEFAULT_FLUTTERWAVE_API_BASE_URL = "https://api.flutterwave.com/v3";

export type ServerEnv = {
  /** PostgreSQL connection string. Used by the Prisma CLI and the pg driver adapter. */
  readonly DATABASE_URL: string;
};

export type PaymentEnv = {
  readonly FLUTTERWAVE_SECRET_KEY: string;
  readonly FLUTTERWAVE_WEBHOOK_SECRET: string;
  readonly FLUTTERWAVE_API_BASE_URL: string;
  /** `null` when no public origin is configured — the payment still completes. */
  readonly FLUTTERWAVE_REDIRECT_BASE_URL: string | null;
};

export class MissingEnvironmentError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Missing required server environment ${
        missing.length === 1 ? "variable" : "variables"
      }: ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill it in.`,
    );
    this.name = "MissingEnvironmentError";
    this.missing = missing;
  }
}

/**
 * An absolute `http(s)` URL, or `null`.
 *
 * Rejects protocol-relative and relative values, which `new URL` alone accepts when
 * given a base — a relative `redirect_url` would be resolved against nothing here and
 * then sent to the provider as-is.
 */
function readAbsoluteUrl(name: string): string | null {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return null;
  }

  const value = raw.trim();

  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new MissingEnvironmentError([`${name} (must be an absolute http(s) URL)`]);
    }
  } catch (error) {
    if (error instanceof MissingEnvironmentError) {
      throw error;
    }

    throw new MissingEnvironmentError([`${name} (must be an absolute http(s) URL)`]);
  }

  return value;
}

function readRequiredEnv(): ServerEnv {
  const missing = REQUIRED_SERVER_ENV.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new MissingEnvironmentError(missing);
  }

  // Safe: the filter above guarantees each name is present and non-empty.
  return { DATABASE_URL: process.env.DATABASE_URL as string };
}

/**
 * Read and validate the payment-provider environment.
 *
 * Split from {@link getServerEnv} so the payment integration is a *use-time*
 * requirement rather than a *startup* one — see the module header. Throws
 * {@link MissingEnvironmentError} naming every absent secret, never their values.
 */
export function getPaymentEnv(): PaymentEnv {
  const missing = REQUIRED_PAYMENT_ENV.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new MissingEnvironmentError(missing);
  }

  return {
    FLUTTERWAVE_SECRET_KEY: process.env.FLUTTERWAVE_SECRET_KEY as string,
    FLUTTERWAVE_WEBHOOK_SECRET: process.env.FLUTTERWAVE_WEBHOOK_SECRET as string,
    FLUTTERWAVE_API_BASE_URL:
      process.env.FLUTTERWAVE_API_BASE_URL?.trim() || DEFAULT_FLUTTERWAVE_API_BASE_URL,
    FLUTTERWAVE_REDIRECT_BASE_URL: readAbsoluteUrl("FLUTTERWAVE_REDIRECT_BASE_URL"),
  };
}

/**
 * Read and validate the server environment.
 * Throws {@link MissingEnvironmentError} listing every missing variable by name.
 */
export function getServerEnv(): ServerEnv {
  return readRequiredEnv();
}

/**
 * Non-throwing environment status, for health checks and diagnostics.
 * Reports only whether each variable is present — never any value.
 *
 * Scoped to the database only, deliberately: the payment integration is a use-time
 * requirement (see {@link getPaymentEnv}), so folding its secrets in here would make
 * a health check report a database-only application as broken. The payment
 * integration reports its own absence, by name, at the point of use.
 */
export function getServerEnvReport(): {
  readonly ok: boolean;
  readonly missing: readonly string[];
} {
  const missing = REQUIRED_SERVER_ENV.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "";
  });

  return { ok: missing.length === 0, missing };
}
