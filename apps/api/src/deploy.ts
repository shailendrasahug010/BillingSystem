import { runMigrations, setupAppRole, createDb, seedReferenceData } from "@digitalbahi/db";

/**
 * Release step, run once before a new API version starts (the `migrate`
 * container): applies migrations and refreshes grants as the schema OWNER,
 * then upserts reference data (states, permissions). Idempotent.
 */
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl) throw new Error("MIGRATION_DATABASE_URL (schema owner) is not set");

await runMigrations(ownerUrl);
console.log("Migrations applied");

await setupAppRole(ownerUrl, process.env.APP_DB_ROLE ?? "digitalbahi_app", process.env.APP_DB_PASSWORD);
console.log("Application role ready");

const { db, pool } = createDb(ownerUrl, { max: 1 });
try {
  await seedReferenceData(db);
  console.log("Reference data seeded");
} finally {
  await pool.end();
}
