import { runMigrations } from "../src/migrate.js";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL (schema owner) is not set");
await runMigrations(url);
console.log("Migrations applied");
