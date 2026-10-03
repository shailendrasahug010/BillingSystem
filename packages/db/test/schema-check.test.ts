/**
 * The API's start-up check that the database has every migration the code
 * ships (checkSchema), against a throw-away database on a real PostgreSQL.
 * Skipped when DATABASE_URL is not set; always runs in CI.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSchema, MIGRATIONS_FOLDER, runMigrations, setupAppRole } from "../src/index.js";

const adminUrl = process.env.DATABASE_URL;
const dbName = `digitalbahi_sc_${Date.now()}`;
const role = `digitalbahi_sc_${Date.now()}`;
const tags = (JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries.map((e) => e.tag);

function urlFor(database: string): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${database}`;
  return u.toString();
}

describe.skipIf(!adminUrl)("checkSchema (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    client = new pg.Client({ connectionString: urlFor(dbName) });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("a database never migrated is behind by every migration", async () => {
    expect(await checkSchema(client)).toEqual({ status: "behind", missing: tags });
  });

  it("after the migrations it is current", async () => {
    await runMigrations(urlFor(dbName));
    expect(await checkSchema(client)).toEqual({ status: "current" });
  });

  it("names the migrations not applied, and a newer database is ahead", async () => {
    await client.query("BEGIN");
    try {
      await client.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)");
      expect(await checkSchema(client)).toEqual({ status: "behind", missing: [tags.at(-1)] });
    } finally {
      await client.query("ROLLBACK");
    }
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) SELECT 'newer', max(created_at) + 1 FROM drizzle.__drizzle_migrations");
      expect(await checkSchema(client)).toEqual({ status: "ahead" });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("the application role reads it once setupAppRole has run, and says when it has not", async () => {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${role}`);
      expect(await checkSchema(client)).toEqual({ status: "not_granted" });
    } finally {
      await client.query("ROLLBACK");
    }
    await setupAppRole(urlFor(dbName), role);
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${role}`);
      expect(await checkSchema(client)).toEqual({ status: "current" });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
