import pg from "pg";

/**
 * Creates (if needed) the least-privileged role the API connects as, and
 * grants it what it needs in the current database. Because it does not own
 * the tables, PostgreSQL row-level security applies to every query it runs,
 * and it cannot rewrite append-only history even if a trigger were dropped.
 *
 * Run by an operator / deploy job with the owner connection after migrations
 * (and by the API test harness on its throw-away databases).
 */
export async function setupAppRole(ownerConnectionString: string, role = "vyapaar_app", password?: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`Invalid role name ${role}`);
  const client = new pg.Client({ connectionString: ownerConnectionString });
  await client.connect();
  try {
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) {
      if (!password) throw new Error(`Role ${role} does not exist and no password was given`);
      await client.query(`create role ${role} login password ${client.escapeLiteral(password)} nosuperuser nobypassrls`);
    }
    await client.query(`
      grant usage on schema public to ${role};
      grant select, insert, update, delete on all tables in schema public to ${role};
      grant usage, select on all sequences in schema public to ${role};
      alter default privileges in schema public grant select, insert, update, delete on tables to ${role};
      alter default privileges in schema public grant usage, select on sequences to ${role};
      revoke update, delete on stock_ledger, party_ledger_entries, audit_logs from ${role};
      revoke delete on gst_transactions from ${role};
      revoke insert, update, delete on states, permissions from ${role};
    `);
  } finally {
    await client.end();
  }
}
