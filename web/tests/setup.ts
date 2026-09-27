/**
 * Vitest setup.
 *
 * Loads `.env` so tests that talk to PostgreSQL (`tests/events.db.test.ts`)
 * resolve `DATABASE_URL` the same way the Prisma CLI and the app do. Absent
 * `.env` is not an error: the pure unit tests must still run without one.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env file. Only the database-backed tests are affected, and they skip
  // themselves when DATABASE_URL is unset.
}
