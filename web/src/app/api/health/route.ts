import { NextResponse } from "next/server";

import { getServerEnvReport } from "@/server/env";

/**
 * Health-check endpoint.
 *
 * Infrastructure only. It is NOT one of the PRD v2 §12 `/api/v1` product
 * endpoints, so it is deliberately mounted at `/api/health` and versioned
 * separately: inventing an `/api/v1/...` path here would pollute a contract
 * that is fixed by the PRD.
 *
 * It reports presence-only configuration status. It never returns an
 * environment variable's value (AGENTS.md §14).
 */
export const dynamic = "force-dynamic";

export function GET() {
  const env = getServerEnvReport();

  return NextResponse.json(
    {
      status: "ok",
      service: "web",
      config: {
        ok: env.ok,
        missing: env.missing,
      },
    },
    {
      // Config problems are reported in the body with a 200 so the endpoint
      // stays useful as a liveness probe; `config.ok` carries the signal.
      status: 200,
    },
  );
}
