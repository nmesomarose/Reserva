import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Prisma 7 removed `url` from the `datasource` block in schema.prisma, so the
 * CLI's connection string is configured here instead. The application runtime
 * does NOT use this file — it builds its own client from a driver adapter in
 * `src/server/db.ts`, which reads the same DATABASE_URL via `src/server/env.ts`.
 *
 * `.env` is loaded explicitly because the Prisma CLI no longer does it for us.
 * `process.loadEnvFile` is built into Node (>=20.6) and throws when the file is
 * absent, which is expected here and non-fatal.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env file present. `prisma validate` and `prisma generate` do not need
  // a database connection, so they must keep working without one (e.g. in CI).
  // Commands that actually talk to Postgres (migrate, db push, studio) will
  // fail with Prisma's own "datasource url is not set" error, which is the
  // correct and clear failure.
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
