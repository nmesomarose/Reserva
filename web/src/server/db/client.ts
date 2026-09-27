import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getServerEnv } from "@/server/env";

/**
 * Persistence layer — database client only.
 *
 * This module owns *how* the application reaches PostgreSQL. It deliberately
 * owns nothing else:
 *  - no product queries, no repositories, no business rules (those belong to
 *    `src/domain`, which must stay framework- and database-agnostic);
 *  - no schema. The Prisma schema in `prisma/schema.prisma` currently contains
 *    NO models on purpose — product entities arrive with the product schema
 *    (PRD v2 §7), not with the scaffold.
 *
 * `import "server-only"` is a build error if any Client Component imports this
 * module, so the database connection string can never reach the browser bundle
 * (AGENTS.md §4, §14).
 *
 * Prisma 7 note: `datasource.url` no longer lives in schema.prisma. The CLI
 * reads it from `prisma.config.ts`; the runtime client receives a driver adapter
 * here, constructed from the same `DATABASE_URL`.
 */

function createPrismaClient(): PrismaClient {
  const { DATABASE_URL } = getServerEnv();
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });
  return new PrismaClient({ adapter });
}

/**
 * A single client instance per process.
 *
 * Cached on `globalThis` in development so hot reloads do not open a new
 * connection pool on every edit.
 */
const globalForPrisma = globalThis as unknown as {
  prismaClient?: PrismaClient;
};

export const prisma: PrismaClient = globalForPrisma.prismaClient ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaClient = prisma;
}
