import { setupAppRole } from "../src/roles.js";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL (schema owner) is not set");
await setupAppRole(url, process.env.APP_DB_ROLE ?? "vyapaar_app", process.env.APP_DB_PASSWORD);
console.log("Application role ready");
