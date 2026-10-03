/**
 * Writes docs/12-database-reference.md: every table with all its columns
 * (type, required, default, description), keys, foreign keys, checks,
 * indexes, triggers, row-level security and what the API's role may do;
 * every enum and database function; the migrations.
 *
 * Nothing in it is typed by hand. The structure is read from PostgreSQL
 * after migrating a throw-away database from scratch, and the descriptions
 * are the doc comments written next to each table and column in
 * src/schema/*.ts (and the comments above each function in the migrations),
 * so the reference cannot drift from the real database. CI regenerates it
 * and fails when the committed file differs.
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm db:docs
 *
 * DATABASE_URL is an admin connection (CREATEDB, CREATEROLE): the script
 * creates a temporary database and role on that server and drops both.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import pg from "pg";
import ts from "typescript";
import { MIGRATIONS_FOLDER, runMigrations } from "../src/migrate.js";
import { setupAppRole } from "../src/roles.js";
import * as schema from "../src/schema/index.js";

const SCHEMA_DIR = fileURLToPath(new URL("../src/schema", import.meta.url));
const OUT = fileURLToPath(new URL("../../../docs/12-database-reference.md", import.meta.url));

/** Section titles for the schema files, in the order src/schema/index.ts exports them. */
const MODULE_TITLES: Record<string, string> = {
  platform: "Platform and tenancy",
  access: "Access: users' roles, sessions and sign-in",
  hr: "Employees, attendance and leave",
  parties: "Customers and suppliers",
  catalog: "Products, units and tax",
  inventory: "Stock",
  purchases: "Purchases",
  sales: "Sales: orders, invoices, packing and dispatch",
  notes: "Credit and debit notes",
  payments: "Payments and the party ledger",
  payroll: "Payroll",
  expenses: "Expenses",
  gst: "GST returns and configuration",
  system: "System: audit log, notifications, outbox, sync, backups",
  analytics: "Analytics (derived, rebuildable)",
  messaging: "WhatsApp and email",
};

/**
 * Descriptions for columns that come from shared helpers, or whose name says it
 * all, used when the schema has no comment for that column. A comment in the
 * schema always wins.
 */
const COMMON_COLUMNS: Record<string, string> = {
  business_id: "The business (tenant) the row belongs to. Row-level security shows a connection only the rows of its current business.",
  created_at: "When the row was created.",
  updated_at: "When the row was last changed; kept by the `set_updated_at` trigger.",
  created_by: "User who created the row (informational: users are deactivated, never deleted, so there is no foreign key).",
  updated_by: "User who last changed the row (informational, no foreign key).",
  deleted_at: "Soft delete: when the row was removed from lists. Posted documents are never deleted.",
  deleted_by: "Soft delete: the user who removed the row.",
  version: "Optimistic locking: increases on every change; a stale write (or an offline edit made on an older copy) is detected by it.",
  name: "Name as shown in the app and on documents.",
  name_hi: "Name in Hindi, shown when the app or a document is in Hindi (the English name otherwise).",
  code: "Short code, used in search, imports and printouts.",
  label: "Name shown for it in the app.",
  description: "Free-text description.",
  notes: "Free-text notes.",
  note: "Free-text note.",
  remarks: "Free-text remarks.",
  is_active: "Inactive rows are kept for history but no longer offered for new entries.",
  sort_order: "Position in lists (lowest first).",
  mobile: "Mobile number (10 digits).",
  alt_mobile: "Second mobile number.",
  phone: "Phone number.",
  email: "Email address.",
  address_line1: "Address, first line.",
  address_line2: "Address, second line.",
  city: "City or town.",
  pincode: "PIN code (6 digits).",
  gstin: "GSTIN (15 characters; format and check digit verified when entered).",
  pan: "PAN (10 characters).",
};

/** The primary key's description by kind: UUIDs are made by the app, ledgers number their rows. */
function idDescription(c: Column): string {
  if (c.identity) return "Sequential row number (append-only table).";
  if (c.type === "uuid") return "UUIDv7 made by the application (time-ordered, creatable on an offline device); the default is a safety net.";
  return "";
}

const FK_ACTIONS: Record<string, string> = { r: "restrict", c: "cascade", n: "set null", d: "set default" };

// ---------------------------------------------------------------- doc comments

interface SourceDocs {
  /** table name -> schema file (module) */
  module: Map<string, string>;
  /** table name -> order of declaration across the modules */
  order: Map<string, number>;
  tableDoc: Map<string, string>;
  /** table name -> property key -> doc */
  columnDoc: Map<string, Map<string, string>>;
  enumDoc: Map<string, string>;
  moduleOrder: string[];
}

function docOf(node: ts.Node, text: string): string | undefined {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const docs = ranges.map((r) => text.slice(r.pos, r.end)).filter((c) => c.startsWith("/**"));
  const raw = docs.at(-1);
  if (!raw) return undefined;
  return raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

function readSourceDocs(): SourceDocs {
  const moduleOrder = [...readFileSync(join(SCHEMA_DIR, "index.ts"), "utf8").matchAll(/from "\.\/([\w-]+)\.js"/g)].map((m) => m[1]!);
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".ts"));
  const parsed = files.map((f) => {
    const text = readFileSync(join(SCHEMA_DIR, f), "utf8");
    return { module: basename(f, ".ts"), text, source: ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true) };
  });

  // Shared column sets (`...auditColumns`, `...taxLineColumns()`): name -> key -> doc.
  const sets = new Map<string, ts.ObjectLiteralExpression>();
  const textOf = new Map<ts.Node, string>();
  for (const p of parsed) {
    for (const st of p.source.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        let init: ts.Expression = d.initializer;
        if (ts.isArrowFunction(init) && ts.isParenthesizedExpression(init.body)) init = init.body.expression;
        if (ts.isObjectLiteralExpression(init)) {
          sets.set(d.name.text, init);
          textOf.set(init, p.text);
        }
      }
    }
  }
  const keysOf = (obj: ts.ObjectLiteralExpression, text: string, out: Map<string, string>) => {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const target = ts.isCallExpression(prop.expression) ? prop.expression.expression : prop.expression;
        const set = ts.isIdentifier(target) ? sets.get(target.text) : undefined;
        if (set) keysOf(set, textOf.get(set)!, out);
      } else if ((ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && ts.isIdentifier(prop.name)) {
        const doc = docOf(prop, text);
        if (doc) out.set(prop.name.text, doc);
      }
    }
  };

  const docs: SourceDocs = { module: new Map(), order: new Map(), tableDoc: new Map(), columnDoc: new Map(), enumDoc: new Map(), moduleOrder };
  const sorted = [...parsed].sort((a, b) => rank(moduleOrder, a.module) - rank(moduleOrder, b.module));
  let order = 0;
  for (const p of sorted) {
    for (const st of p.source.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        const call = d.initializer;
        if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
        const name = call.arguments[0];
        if (!name || !ts.isStringLiteral(name)) continue;
        const doc = docOf(st, p.text);
        if (call.expression.text === "pgEnum") {
          if (doc) docs.enumDoc.set(name.text, doc);
        } else if (call.expression.text === "pgTable") {
          docs.module.set(name.text, p.module);
          docs.order.set(name.text, order++);
          if (doc) docs.tableDoc.set(name.text, doc);
          const cols = new Map<string, string>();
          const body = call.arguments[1];
          if (body && ts.isObjectLiteralExpression(body)) keysOf(body, p.text, cols);
          docs.columnDoc.set(name.text, cols);
        }
      }
    }
  }
  return docs;
}

function rank(order: string[], module: string): number {
  const i = order.indexOf(module);
  return i === -1 ? order.length : i;
}

/** Drizzle's snake_case casing (drizzle-orm/casing.js), which named every column. */
function toSnakeCase(input: string): string {
  const words = input.replace(/['\u2019]/g, "").match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [];
  return words.map((w) => w.toLowerCase()).join("_");
}

/** table name -> column name -> doc, joining the schema objects (column names) with the comments (keys). */
function columnDocs(docs: SourceDocs): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const table = getTableConfig(value).name;
    const byKey = docs.columnDoc.get(table) ?? new Map<string, string>();
    const byColumn = new Map<string, string>();
    for (const [key, column] of Object.entries(getTableColumns(value))) {
      const name = column.keyAsName ? toSnakeCase(column.name) : column.name;
      const doc = byKey.get(key);
      if (doc) byColumn.set(name, doc);
    }
    out.set(table, byColumn);
  }
  return out;
}

/** The comment block right above each `CREATE [OR REPLACE] FUNCTION name` in the migrations (the latest one wins). */
function functionDocs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql")).sort()) {
    const lines = readFileSync(join(MIGRATIONS_FOLDER, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = /^CREATE (?:OR REPLACE )?FUNCTION\s+(?:"?public"?\.)?"?(\w+)"?/i.exec(line);
      if (!m) return;
      const comment: string[] = [];
      for (let j = i - 1; j >= 0 && /^\s*--(?!>)/.test(lines[j]!); j--) comment.unshift(lines[j]!.replace(/^\s*--\s?/, ""));
      if (comment.length) out.set(m[1]!, comment.join(" ").replace(/^\d+[a-z]?\.\s*/, "").trim());
    });
  }
  return out;
}

// ---------------------------------------------------------------- the database

interface Column {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  identity: string;
  generated: string;
}
interface Constraint {
  name: string;
  type: "p" | "f" | "u" | "c" | "x";
  def: string;
  columns: string[];
  refTable: string | null;
  refColumns: string[];
  onDelete: string;
}
interface Table {
  oid: number;
  name: string;
  rls: boolean;
  forceRls: boolean;
  columns: Column[];
  constraints: Constraint[];
  indexes: Array<{ name: string; def: string }>;
  triggers: Array<{ name: string; def: string }>;
  policies: Array<{ name: string; command: string; roles: string; using: string | null; check: string | null }>;
  privileges: { select: boolean; insert: boolean; update: boolean; delete: boolean };
}

async function introspect(client: pg.Client, appRole: string) {
  const tables = new Map<number, Table>();
  const t = await client.query<{ oid: number; relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; s: boolean; i: boolean; u: boolean; d: boolean }>(
    `select c.oid::int, c.relname, c.relrowsecurity, c.relforcerowsecurity,
            has_table_privilege($1, c.oid, 'SELECT') s, has_table_privilege($1, c.oid, 'INSERT') i,
            has_table_privilege($1, c.oid, 'UPDATE') u, has_table_privilege($1, c.oid, 'DELETE') d
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname`,
    [appRole],
  );
  for (const r of t.rows) {
    tables.set(r.oid, {
      oid: r.oid,
      name: r.relname,
      rls: r.relrowsecurity,
      forceRls: r.relforcerowsecurity,
      columns: [],
      constraints: [],
      indexes: [],
      triggers: [],
      policies: [],
      privileges: { select: r.s, insert: r.i, update: r.u, delete: r.d },
    });
  }
  const oids = [...tables.keys()];

  const cols = await client.query<{ rel: number; attname: string; type: string; attnotnull: boolean; def: string | null; attidentity: string; attgenerated: string }>(
    `select a.attrelid::int rel, a.attname, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull,
            pg_get_expr(d.adbin, d.adrelid) def, a.attidentity, a.attgenerated
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped
      order by a.attrelid, a.attnum`,
    [oids],
  );
  for (const c of cols.rows) {
    tables.get(c.rel)!.columns.push({ name: c.attname, type: c.type, notNull: c.attnotnull, default: c.def, identity: c.attidentity, generated: c.attgenerated });
  }

  const cons = await client.query<{ rel: number; conname: string; contype: Constraint["type"]; def: string; cols: string[]; ref: string | null; refcols: string[] | null; confdeltype: string }>(
    `select c.conrelid::int rel, c.conname, c.contype::text, pg_get_constraintdef(c.oid, true) def,
            array(select a.attname::text from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.o) cols,
            rc.relname::text ref,
            array(select a.attname::text from unnest(c.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.o) refcols,
            c.confdeltype::text
       from pg_constraint c left join pg_class rc on rc.oid = c.confrelid
      where c.conrelid = any($1::oid[]) order by c.conrelid, c.conname`,
    [oids],
  );
  for (const c of cons.rows) {
    tables.get(c.rel)!.constraints.push({ name: c.conname, type: c.contype, def: c.def, columns: c.cols, refTable: c.ref, refColumns: c.refcols ?? [], onDelete: c.confdeltype });
  }

  const idx = await client.query<{ rel: number; relname: string; def: string }>(
    `select i.indrelid::int rel, ic.relname, pg_get_indexdef(i.indexrelid) def
       from pg_index i join pg_class ic on ic.oid = i.indexrelid
      where i.indrelid = any($1::oid[])
        and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid and c.contype in ('p', 'u', 'x'))
      order by i.indrelid, ic.relname`,
    [oids],
  );
  for (const i of idx.rows) tables.get(i.rel)!.indexes.push({ name: i.relname, def: i.def });

  const trg = await client.query<{ rel: number; tgname: string; def: string }>(
    `select tgrelid::int rel, tgname, pg_get_triggerdef(oid) def from pg_trigger
      where tgrelid = any($1::oid[]) and not tgisinternal order by tgrelid, tgname`,
    [oids],
  );
  for (const g of trg.rows) tables.get(g.rel)!.triggers.push({ name: g.tgname, def: g.def });

  const pol = await client.query<{ rel: number; polname: string; cmd: string; roles: string[]; qual: string | null; check: string | null }>(
    `select p.polrelid::int rel, p.polname, p.polcmd::text cmd,
            array(select case when r = 0 then 'public' else pg_get_userbyid(r)::text end from unnest(p.polroles) r) roles,
            pg_get_expr(p.polqual, p.polrelid) qual, pg_get_expr(p.polwithcheck, p.polrelid) "check"
       from pg_policy p where p.polrelid = any($1::oid[]) order by p.polrelid, p.polname`,
    [oids],
  );
  const commands: Record<string, string> = { r: "select", a: "insert", w: "update", d: "delete", "*": "all commands" };
  for (const p of pol.rows) {
    tables.get(p.rel)!.policies.push({ name: p.polname, command: commands[p.cmd] ?? p.cmd, roles: p.roles.join(", "), using: p.qual, check: p.check });
  }

  const enums = await client.query<{ typname: string; labels: string[] }>(
    `select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) labels
       from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' group by t.typname order by t.typname`,
  );

  const fns = await client.query<{ proname: string; args: string; result: string; lang: string }>(
    `select p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) result, l.lanname lang
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
      where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by p.proname, args`,
  );

  const ext = await client.query<{ extname: string }>(`select extname from pg_extension where extname <> 'plpgsql' order by extname`);

  return { tables: [...tables.values()], enums: enums.rows, functions: fns.rows, extensions: ext.rows.map((e) => e.extname) };
}

// ---------------------------------------------------------------- markdown

/** Escapes text for a markdown table cell / paragraph: pipes everywhere, `<` outside code spans. */
function md(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith("`") ? part.replace(/\|/g, "\\|") : part.replace(/\|/g, "\\|").replace(/</g, "&lt;")))
    .join("");
}

function code(text: string): string {
  return "`" + text.replace(/\|/g, "\\|").replace(/`/g, "'") + "`";
}

/** A doc comment as one table cell. */
function cell(doc: string | undefined): string {
  return doc ? md(doc.replace(/\s*\n\s*/g, " ")) : "";
}

/** A doc comment as markdown paragraphs: wrapped lines joined, list items and blank lines kept. */
function paragraphs(doc: string): string {
  const out: string[] = [];
  for (const raw of doc.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (out.length && out.at(-1) !== "") out.push("");
    } else if (/^([-*]|\d+\.)\s/.test(line) || !out.length || out.at(-1) === "") {
      if (/^([-*]|\d+\.)\s/.test(line) && out.length && out.at(-1) !== "" && !/^([-*]|\d+\.)\s/.test(out.at(-1)!)) out.push("");
      out.push(line);
    } else {
      out[out.length - 1] += " " + line;
    }
  }
  return md(out.join("\n").trim());
}

function shortType(type: string): string {
  return type
    .replace(/^timestamp\((\d)\) with time zone/, "timestamptz($1)")
    .replace(/^timestamp with time zone/, "timestamptz")
    .replace(/^timestamp without time zone/, "timestamp")
    .replace(/^time without time zone/, "time")
    .replace(/^character varying/, "varchar")
    .replace(/^character\b/, "char")
    .replace(/^double precision/, "float8");
}

function shortDefault(c: Column): string {
  if (c.identity) return c.identity === "a" ? "identity (always)" : "identity";
  if (c.generated === "s") return `generated: ${code(c.default ?? "")}`;
  if (c.default === null) return "";
  const literal = /^'(.*)'::[\w ."]+(\[\])?$/.exec(c.default);
  if (literal && /^(numeric|integer|smallint|bigint)/.test(c.type) && /^-?\d+(\.\d+)?$/.test(literal[1]!)) return code(literal[1]!);
  return code(literal ? `'${literal[1]}'` : c.default);
}

const TENANT_RULE = "(business_id = (NULLIF(current_setting('app.business_id'::text, true), ''::text))::uuid)";

function triggerLine(def: string): string {
  const m = /^CREATE (?:CONSTRAINT )?TRIGGER \S+ (.+?) ON \S+ (?:.*?)(FOR EACH (?:ROW|STATEMENT))(?: WHEN \((.*)\))? EXECUTE (?:FUNCTION|PROCEDURE) (.+)$/.exec(def);
  if (!m) return code(def);
  return `${m[1]!.toLowerCase()}, ${m[2]!.toLowerCase().replace("for ", "")}${m[3] ? ` when ${code(m[3])}` : ""} → ${code(m[4]!)}`;
}

function indexLine(def: string): string {
  const m = /^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING (\w+) (.+)$/.exec(def);
  if (!m) return code(def);
  return `${m[1] ? "unique, " : ""}${m[2]} ${code(m[3]!)}`;
}

function privilegesLine(p: Table["privileges"]): string | null {
  const all = { select: "read", insert: "insert", update: "update", delete: "delete" } as const;
  const may = (Object.keys(all) as Array<keyof typeof all>).filter((k) => p[k]).map((k) => all[k]);
  const not = (Object.keys(all) as Array<keyof typeof all>).filter((k) => !p[k]).map((k) => all[k]);
  if (!not.length) return null;
  return `**The API's role may:** ${may.join(", ") || "nothing"} (not ${not.join(" or ")}).`;
}

function render(data: Awaited<ReturnType<typeof introspect>>, docs: SourceDocs, colDocs: Map<string, Map<string, string>>, fnDocs: Map<string, string>): string {
  const tables = [...data.tables].sort((a, b) => (docs.order.get(a.name) ?? 1e6) - (docs.order.get(b.name) ?? 1e6) || a.name.localeCompare(b.name));
  const enumNames = new Set(data.enums.map((e) => e.typname));
  const referencedBy = new Map<string, Array<{ table: string; column: string }>>();
  for (const t of tables) {
    for (const c of t.constraints) {
      if (c.type === "f" && c.refTable) {
        const list = referencedBy.get(c.refTable) ?? [];
        list.push({ table: t.name, column: c.columns.join(", ") });
        referencedBy.set(c.refTable, list);
      }
    }
  }
  const enumUse = new Map<string, string[]>();
  for (const t of tables) {
    for (const c of t.columns) {
      const base = c.type.replace(/\[\]$/, "");
      if (enumNames.has(base)) enumUse.set(base, [...(enumUse.get(base) ?? []), `[\`${t.name}\`](#${t.name}).${c.name}`]);
    }
  }
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };

  const count = (f: (t: Table) => number) => tables.reduce((s, t) => s + f(t), 0);
  const L: string[] = [];
  L.push("# Database reference", "");
  L.push(
    "<!-- Generated by `pnpm db:docs` (packages/db/scripts/db-docs.ts). Do not edit: change the schema's comments in packages/db/src/schema/*.ts or the migrations, then run it again. -->",
    "",
  );
  L.push(
    "Every table of the Digital Bahi database with all its columns, keys, indexes, triggers and access rules, every enum and every database function. It is **generated** from a database migrated from scratch (so it is exactly what `pnpm db:deploy` creates) and from the comments written next to each table and column in `packages/db/src/schema/*.ts`; CI fails when it is out of date. Why the database is designed this way (ER diagrams, integrity rules, indexing strategy) is in [03-database-design.md](03-database-design.md).",
    "",
  );
  L.push("| | Count |", "|---|---|");
  L.push(`| Tables | ${tables.length} |`);
  L.push(`| Columns | ${count((t) => t.columns.length)} |`);
  L.push(`| Foreign keys | ${count((t) => t.constraints.filter((c) => c.type === "f").length)} |`);
  L.push(`| Unique constraints | ${count((t) => t.constraints.filter((c) => c.type === "u").length)} |`);
  L.push(`| Check constraints | ${count((t) => t.constraints.filter((c) => c.type === "c").length)} |`);
  L.push(`| Indexes (besides primary keys and unique constraints) | ${count((t) => t.indexes.length)} |`);
  L.push(`| Triggers | ${count((t) => t.triggers.length)} |`);
  L.push(`| Tables with row-level security | ${tables.filter((t) => t.rls).length} |`);
  L.push(`| Enums | ${data.enums.length} |`);
  L.push(`| Functions | ${data.functions.length} |`);
  L.push(`| Migrations | ${journal.entries.length} (last: \`${journal.entries.at(-1)?.tag}\`) |`, "");

  L.push("## How the database is set up", "");
  L.push(
    "* **One PostgreSQL database, many businesses.** The database is `digitalbahi` (`digitalbahi_dev` on a developer's computer). Every business-owned table has a `business_id`; row-level security lets a connection see and write only the rows of the business it has set in `app.business_id` for its transaction. Tables without `business_id` are platform-wide (users, states, permissions) or are reached through their parent.",
    "* **Two roles.** `digitalbahi_owner` owns the tables and runs the migrations. The API connects as `digitalbahi_app`, which does not own the tables, so row-level security always applies to it; it also lacks UPDATE / DELETE on the append-only tables (marked below), so history cannot be rewritten even if a trigger were dropped.",
    "* **Conventions.** Column names are snake_case. Primary keys are UUIDs (append-only ledgers use bigint identities). Money is `numeric(15,2)`, rates `numeric(15,4)`, quantities `numeric(15,3)`, percentages `numeric(7,3)`; never floating point. Times are `timestamptz`; business dates are `date`. `created_by` / `updated_by` have no foreign key (users are never deleted). `version` is for optimistic locking.",
    `* **Extensions:** ${data.extensions.map((e) => code(e)).join(", ") || "none"}.`,
    "* **Migrations** are in `packages/db/migrations` (SQL, applied in order by `pnpm db:deploy`); the Drizzle schema in `packages/db/src/schema` must match them (checked in CI).",
    "",
  );
  L.push("**Reading a table below:** *Required* ✓ means `NOT NULL`. A foreign key is shown as → `table.column` (with its delete rule when it is not *no action*). Constraints over several columns, checks, indexes, triggers and row-level security follow each column list.", "");

  // Contents
  L.push("## Contents", "");
  const modules = [...new Set(tables.map((t) => docs.module.get(t.name) ?? "other"))].sort((a, b) => rank(docs.moduleOrder, a) - rank(docs.moduleOrder, b));
  for (const m of modules) {
    const title = MODULE_TITLES[m] ?? (m === "other" ? "Other tables" : m);
    const names = tables.filter((t) => (docs.module.get(t.name) ?? "other") === m).map((t) => `[\`${t.name}\`](#${t.name})`);
    L.push(`* **${title}:** ${names.join(", ")}`);
  }
  L.push("* [Enums](#enums) · [Functions](#functions) · [Migrations](#migrations)", "");

  for (const m of modules) {
    L.push(`## ${MODULE_TITLES[m] ?? (m === "other" ? "Other tables" : m)}`, "");
    for (const t of tables.filter((x) => (docs.module.get(x.name) ?? "other") === m)) {
      L.push(`### \`${t.name}\``, "");
      const doc = docs.tableDoc.get(t.name);
      if (doc) L.push(paragraphs(doc), "");
      const pkCols = new Set(t.constraints.find((c) => c.type === "p")?.columns ?? []);
      const singleUnique = new Set(t.constraints.filter((c) => c.type === "u" && c.columns.length === 1).map((c) => c.columns[0]!));
      const singleFk = new Map(t.constraints.filter((c) => c.type === "f" && c.columns.length === 1).map((c) => [c.columns[0]!, c]));
      const cd = colDocs.get(t.name) ?? new Map<string, string>();
      L.push("| Column | Type | Required | Default | Description |", "|---|---|:-:|---|---|");
      for (const c of t.columns) {
        const notes: string[] = [];
        if (pkCols.has(c.name)) notes.push(pkCols.size > 1 ? "**Primary key** (with " + [...pkCols].filter((x) => x !== c.name).map((x) => `\`${x}\``).join(", ") + ")." : "**Primary key.**");
        if (singleUnique.has(c.name)) notes.push("**Unique.**");
        const fk = singleFk.get(c.name);
        if (fk && fk.refTable) notes.push(`→ [\`${fk.refTable}\`](#${fk.refTable}).${fk.refColumns.join(", ")}${FK_ACTIONS[fk.onDelete] ? ` (on delete ${FK_ACTIONS[fk.onDelete]})` : ""}.`);
        const text = cd.get(c.name) ?? (c.name === "id" ? idDescription(c) : COMMON_COLUMNS[c.name]);
        if (text) notes.push(cell(text));
        const base = c.type.replace(/\[\]$/, "");
        const type = enumNames.has(base) ? `[${base}](#enum-${base})${c.type.endsWith("[]") ? "[]" : ""}` : shortType(c.type);
        L.push(`| \`${c.name}\` | ${type} | ${c.notNull ? "✓" : ""} | ${shortDefault(c)} | ${notes.join(" ")} |`);
      }
      L.push("");
      const extra: string[] = [];
      for (const c of t.constraints) {
        if (c.type === "p" && c.columns.length > 1) extra.push(`* Primary key ${code(c.columns.join(", "))}`);
        if (c.type === "u" && c.columns.length > 1) extra.push(`* Unique ${code(c.name)}: ${code(c.def.replace(/^UNIQUE /, ""))}`);
        if (c.type === "f" && c.columns.length > 1 && c.refTable)
          extra.push(`* Foreign key ${code(c.columns.join(", "))} → [\`${c.refTable}\`](#${c.refTable}) ${code(c.refColumns.join(", "))}${FK_ACTIONS[c.onDelete] ? ` (on delete ${FK_ACTIONS[c.onDelete]})` : ""}`);
        if (c.type === "c") extra.push(`* Check ${code(c.name)}: ${code(c.def.replace(/^CHECK /, ""))}`);
        if (c.type === "x") extra.push(`* Exclusion ${code(c.name)}: ${code(c.def)}`);
      }
      for (const i of t.indexes) extra.push(`* Index ${code(i.name)}: ${indexLine(i.def)}`);
      for (const g of t.triggers) extra.push(`* Trigger ${code(g.name)}: ${triggerLine(g.def)}`);
      if (t.rls) {
        for (const p of t.policies) {
          const standard = p.using === TENANT_RULE && !p.check && p.command === "all commands" && p.roles === "public";
          extra.push(
            standard
              ? `* Row-level security: policy ${code(p.name)}, rows of the current business only (\`app.business_id\`)`
              : `* Row-level security: policy ${code(p.name)} (${p.command}${p.roles !== "public" ? `, ${p.roles}` : ""})${p.using ? `, using ${code(p.using)}` : ""}${p.check ? `, check ${code(p.check)}` : ""}`,
          );
        }
        if (!t.policies.length) extra.push("* Row-level security on, with no policy: only the owner can read it");
      }
      const priv = privilegesLine(t.privileges);
      if (priv) extra.push(`* ${priv}`);
      const refs = referencedBy.get(t.name) ?? [];
      const viaBusiness = refs.filter((r) => r.column === "business_id").length;
      const shown = refs.filter((r) => r.column !== "business_id");
      if (shown.length || viaBusiness) {
        const parts = shown.map((r) => `[\`${r.table}\`](#${r.table}).${r.column}`);
        if (viaBusiness) parts.push(`${viaBusiness} tables by \`business_id\``);
        extra.push(`* Referenced by: ${parts.join(", ")}`);
      }
      if (extra.length) L.push(...extra, "");
    }
  }

  L.push("## Enums", "");
  for (const e of data.enums) {
    L.push(`### Enum \`${e.typname}\``, "");
    const doc = docs.enumDoc.get(e.typname);
    if (doc) L.push(paragraphs(doc), "");
    L.push(`Values: ${e.labels.map((l) => code(l)).join(", ")}`, "");
    const used = enumUse.get(e.typname);
    if (used) L.push(`Used by: ${used.join(", ")}`, "");
  }

  L.push("## Functions", "");
  L.push("Written in the migrations; triggers use them to keep the rules no application bug can break.", "");
  const triggersOf = new Map<string, string[]>();
  for (const t of tables) {
    for (const g of t.triggers) {
      const fn = /EXECUTE (?:FUNCTION|PROCEDURE) (\w+)\(/.exec(g.def)?.[1];
      if (fn) triggersOf.set(fn, [...(triggersOf.get(fn) ?? []), t.name]);
    }
  }
  L.push("| Function | Returns | Language | Description |", "|---|---|---|---|");
  for (const f of data.functions) {
    const on = triggersOf.get(f.proname) ?? [];
    const usedBy = on.length > 8 ? `Trigger on ${on.length} tables.` : on.length ? `Trigger on ${on.map((t) => `[\`${t}\`](#${t})`).join(", ")}.` : "";
    L.push(`| ${code(`${f.proname}(${f.args})`)} | ${md(f.result)} | ${f.lang} | ${[cell(fnDocs.get(f.proname)), usedBy].filter(Boolean).join(" ")} |`);
  }
  L.push("");

  L.push("## Migrations", "");
  L.push("Applied in this order (`packages/db/migrations`):", "");
  L.push(journal.entries.map((e) => code(e.tag)).join(" · "), "");
  return L.join("\n");
}

// ---------------------------------------------------------------- main

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error("Set DATABASE_URL to an admin connection, e.g. postgres://postgres:postgres@localhost:5432/postgres");
const suffix = `${Date.now()}_${process.pid}`;
const dbName = `digitalbahi_docs_${suffix}`;
const appRole = `digitalbahi_docs_app_${suffix}`;
const urlFor = (database: string) => {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  return u.toString();
};

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`create database ${dbName}`);
try {
  await runMigrations(urlFor(dbName));
  await setupAppRole(urlFor(dbName), appRole, `docs-${suffix}`);
  const client = new pg.Client({ connectionString: urlFor(dbName) });
  await client.connect();
  let data;
  try {
    data = await introspect(client, appRole);
  } finally {
    await client.end();
  }
  const docs = readSourceDocs();
  const missing = data.tables.filter((t) => !docs.module.has(t.name)).map((t) => t.name);
  if (missing.length) console.warn(`Tables without a Drizzle definition: ${missing.join(", ")}`);
  const cdocs = columnDocs(docs);
  const out = render(data, docs, cdocs, functionDocs());
  writeFileSync(OUT, out.endsWith("\n") ? out : `${out}\n`);
  const undescribed = data.tables.flatMap((t) =>
    t.columns.filter((c) => !cdocs.get(t.name)?.has(c.name) && !(c.name === "id" ? idDescription(c) : COMMON_COLUMNS[c.name])).map((c) => `${t.name}.${c.name}`),
  );
  const total = data.tables.reduce((s, t) => s + t.columns.length, 0);
  console.log(`Wrote ${OUT}: ${data.tables.length} tables, ${total} columns (${total - undescribed.length} with a description).`);
  // `--missing`: list the columns that still have no description, to write their comments.
  if (process.argv.includes("--missing")) console.log(undescribed.join("\n"));
} finally {
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`drop role if exists ${appRole}`);
  await admin.end();
}
