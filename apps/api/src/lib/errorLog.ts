import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { SourceMapConsumer, type RawSourceMap } from "source-map-js";

/**
 * The error log: every failure in the application written to a file a
 * developer can open, in plain words — what went wrong, the source file and
 * line where it happened (the original TypeScript, also for the built app
 * and the browser), the request or screen, who was using it, and the
 * reference shown to that person — so an issue can be found and fixed.
 *
 * Two files a day in LOG_DIR:
 *   errors-YYYY-MM-DD.log    readable, one block per error
 *   errors-YYYY-MM-DD.jsonl  the same entries, one JSON object a line (for tools and `pnpm errors`)
 * Files older than LOG_RETENTION_DAYS are deleted. Request bodies, passwords
 * and tokens are never written.
 */

export interface SourcePlace {
  /** Path from the repository root, e.g. apps/api/src/modules/invoices/routes.ts */
  file: string;
  line: number;
  column: number;
  /** The function it was in, when known. */
  fn: string | null;
}

export type ErrorSource = "api" | "web" | "job" | "database" | "process";

export interface ErrorEntry {
  at: string;
  /** Shown to the person who met the error; search the log for it. */
  reference: string;
  source: ErrorSource;
  /** The error in plain words. */
  message: string;
  /** TypeError, a database error code, an API error code … */
  kind: string;
  /** Where in our code it happened (first frame outside libraries). */
  where: SourcePlace | null;
  /** The call stack, our code and libraries, each as file:line:column function. */
  stack: string[];
  request?: { method: string; url: string; status: number; code: string };
  screen?: string;
  page?: string;
  browser?: string;
  appVersion?: string;
  job?: string;
  user?: { id: string; name: string | null; businessId: string | null };
  details?: Record<string, string | number>;
}

export interface ErrorLogOptions {
  dir: string | null;
  retentionDays: number;
  /** Source maps of the built web app (kept off the public site). */
  webSourceMapsDir: string | null;
  timeZone: string;
}

// ------------------------------------------------------------------ stacks

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
// Browsers other than Chrome: "fn@https://…/app.js:1:2".
const FRAME_AT = /^\s*(?:(.*?)@)?(.+?):(\d+):(\d+)\s*$/;

export interface Frame {
  fn: string | null;
  file: string;
  line: number;
  column: number;
}

/** The frames of a V8 (or Firefox / Safari) stack. */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const raw of stack.split("\n")) {
    const m = FRAME.exec(raw) ?? (raw.includes("@") || /:\d+:\d+$/.test(raw.trim()) ? FRAME_AT.exec(raw) : null);
    if (!m) continue;
    const file = m[2]!.replace(/^async /, "");
    if (file.startsWith("native") || file === "<anonymous>") continue;
    frames.push({ fn: m[1]?.replace(/^async /, "").trim() || null, file, line: Number(m[3]), column: Number(m[4]) });
  }
  return frames;
}

/**
 * A source path as it is in the repository: apps/api/src/…, packages/core/src/…,
 * node_modules/<package>/… for libraries. Works for paths from the development
 * machine, the built API in its container and the web app's source maps.
 */
export function repoPath(file: string, base = "apps/api/"): string {
  let p = file.replace(/^file:\/\//, "").replace(/\\/g, "/").replace(/[?#].*$/, "");
  const nm = p.lastIndexOf("/node_modules/");
  if (nm >= 0) {
    // pnpm keeps packages at node_modules/.pnpm/<name@version>/node_modules/<name>/…
    return `node_modules/${p.slice(nm + "/node_modules/".length)}`;
  }
  if (p.startsWith("node:")) return p;
  const repo = /(?:^|\/)((?:apps|packages)\/[^/]+\/.+)$/.exec(p);
  if (repo) return repo[1]!;
  // The built API runs from /app with its sources mapped to /app/src/…; the web dev server serves /src/….
  const src = /(?:^|\/)(src\/.+)$/.exec(p);
  if (src) return `${base}${src[1]}`;
  p = p.replace(/^\/+/, "");
  return p;
}

const isOurs = (file: string) => !file.startsWith("node_modules/") && !file.startsWith("node:") && /^(apps|packages)\//.test(file);

/** Frames as repository paths; the first of our own is where it happened. */
export function placesOf(frames: Frame[], base?: string): { where: SourcePlace | null; stack: string[] } {
  const places = frames.map((f) => ({ file: repoPath(f.file, base), line: f.line, column: f.column, fn: f.fn }));
  const where = places.find((p) => isOurs(p.file)) ?? places.find((p) => !p.file.startsWith("node:")) ?? null;
  return { where, stack: places.map((p) => `${p.file}:${p.line}:${p.column}${p.fn ? `  ${p.fn}` : ""}`) };
}

// ------------------------------------------------------------ plain words

interface PgLike {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
  table?: string;
  column?: string;
  constraint?: string;
  where?: string;
  cause?: unknown;
  query?: string;
}

const PG_CODES: Record<string, string> = {
  "23502": "a required value is missing (NOT NULL)",
  "23503": "it refers to a row that does not exist (foreign key)",
  "23505": "the same value already exists (unique)",
  "23514": "a value breaks a rule of the table (check)",
  "22P02": "a value is in the wrong format",
  "22001": "a value is too long for its column",
  "22003": "a number is too large for its column",
  "42703": "a column the query names does not exist",
  "42P01": "a table the query names does not exist",
  "42883": "a function or operator the query uses does not exist",
  "42501": "the database role may not do this (row-level security or privileges)",
  "40001": "two changes collided (serialization)",
  "40P01": "two changes waited on each other (deadlock)",
  "57014": "the query was cancelled (too slow)",
  "53300": "the database has too many connections",
  "08006": "the connection to the database broke",
};

/** The database error inside a query error (Drizzle wraps the one from pg). */
function pgErrorOf(err: unknown): PgLike | null {
  let e = err as PgLike | undefined;
  for (let depth = 0; e && depth < 4; depth++) {
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    e = e.cause as PgLike | undefined;
  }
  return null;
}

/** An error in plain words, with what the database added about it. */
export function describeError(err: unknown): { message: string; kind: string; details: Record<string, string | number> } {
  const details: Record<string, string | number> = {};
  if (!(err instanceof Error) && (typeof err !== "object" || err === null)) return { message: String(err), kind: typeof err, details };
  const e = err as Error & { code?: unknown; statusCode?: number };
  const pg = pgErrorOf(err);
  if (pg) {
    const reason = PG_CODES[pg.code!] ?? "the database refused it";
    const query = (err as { query?: string }).query;
    for (const [k, v] of Object.entries({ table: pg.table, column: pg.column, constraint: pg.constraint, detail: pg.detail, hint: pg.hint, "database code": pg.code })) if (v) details[k] = v;
    // The query's text without its values (they can hold personal data).
    if (typeof query === "string") details.query = query.replace(/\s+/g, " ").slice(0, 400);
    return { message: `Database error: ${pg.message ?? "query failed"} — ${reason}.`, kind: `DatabaseError ${pg.code}`, details };
  }
  const code = typeof e.code === "string" ? e.code : null;
  const kind = [e.name || "Error", code && code !== e.message ? code : null].filter(Boolean).join(" ");
  return { message: e.message || String(err), kind, details };
}

// ------------------------------------------------------------- source maps

/** A name the minifier made up ("Ql", "a"): not worth showing. */
export const minified = (name: string | null | undefined) => !name || /^[A-Za-z_$][\w$]{0,2}$/.test(name);

const DECLARATION = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)?|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/,
  /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:static\s+|override\s+|async\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
];

/** The function a source line sits in: the nearest declaration at or above it (the maps carry the source). */
export function enclosingName(source: string | null, line: number): string | null {
  if (!source) return null;
  const lines = source.split("\n");
  for (let i = Math.min(line, lines.length) - 1; i >= 0 && i >= line - 300; i--) {
    for (const re of DECLARATION) {
      const m = re.exec(lines[i]!);
      if (m) return m[1]!;
    }
  }
  return null;
}

/** Positions in the built web app back to the original files, from the private source maps. */
export class WebSourceMaps {
  private cache = new Map<string, SourceMapConsumer | null>();
  constructor(private readonly dir: string | null) {}

  private async consumer(script: string): Promise<SourceMapConsumer | null> {
    if (!this.dir || !/^[\w.-]+\.js$/.test(script)) return null;
    if (this.cache.has(script)) return this.cache.get(script)!;
    let consumer: SourceMapConsumer | null;
    try {
      consumer = new SourceMapConsumer(JSON.parse(await readFile(path.join(this.dir, `${script}.map`), "utf8")) as RawSourceMap);
    } catch {
      consumer = null;
    }
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(script, consumer);
    return consumer;
  }

  /**
   * Browser frames with built positions (…/assets/x-abc.js:1:2345) mapped to the source they
   * came from, named after the function they are in (not the minifier's name).
   */
  async map(frames: Frame[]): Promise<Frame[]> {
    const out: Frame[] = [];
    for (const f of frames) {
      const script = /\/assets\/([\w.-]+\.js)$/.exec(f.file.replace(/[?#].*$/, ""))?.[1];
      const consumer = script ? await this.consumer(script) : null;
      const pos = consumer?.originalPositionFor({ line: f.line, column: Math.max(0, f.column - 1) });
      if (consumer && pos?.source && pos.line) {
        // Sources are relative to the map (apps/web/dist/assets): ../../src/x.tsx → apps/web/src/x.tsx.
        const file = pos.source.startsWith("/") ? pos.source : path.posix.join("apps/web/dist/assets", pos.source);
        const content = consumer.sourceContentFor(pos.source, true);
        const fn = enclosingName(content, pos.line) ?? (minified(f.fn) ? null : f.fn);
        out.push({ fn, file, line: pos.line, column: (pos.column ?? 0) + 1 });
      } else out.push({ ...f, fn: minified(f.fn) && /\/assets\//.test(f.file) ? null : f.fn });
    }
    return out;
  }
}

// ------------------------------------------------------------------ files

const SOURCES: Record<ErrorSource, string> = {
  api: "in the API",
  web: "in the app (browser)",
  job: "in a background job",
  database: "with the database connection",
  process: "that stopped the API process",
};

/** One error as a readable block. */
export function formatEntry(e: ErrorEntry, timeZone = "Asia/Kolkata"): string {
  const local = new Intl.DateTimeFormat("en-IN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short" }).format(new Date(e.at));
  const lines = [
    "━".repeat(78),
    `[${local}]  ERROR ${SOURCES[e.source]}  ·  reference ${e.reference}`,
    `What happened : ${e.message}  (${e.kind})`,
    `Where         : ${e.where ? `${e.where.file}  line ${e.where.line}, column ${e.where.column}${e.where.fn ? `  (in ${e.where.fn})` : ""}` : "not known (no stack trace)"}`,
  ];
  if (e.request) lines.push(`Request       : ${e.request.method} ${e.request.url}  →  ${e.request.status} ${e.request.code}`);
  if (e.screen || e.page) lines.push(`Screen        : ${[e.screen, e.page].filter(Boolean).join("  ·  ")}`);
  if (e.browser || e.appVersion) lines.push(`Browser       : ${[e.browser, e.appVersion ? `app build ${e.appVersion}` : null].filter(Boolean).join("  ·  ")}`);
  if (e.job) lines.push(`Job           : ${e.job}`);
  if (e.user) lines.push(`Who           : ${e.user.name ?? "(name not known)"}  (user ${e.user.id}${e.user.businessId ? `, business ${e.user.businessId}` : ""})`);
  for (const [k, v] of Object.entries(e.details ?? {})) lines.push(`${`  ${k}`.padEnd(14)}: ${v}`);
  if (e.stack.length) {
    lines.push("Call stack    :");
    let hidden = 0;
    e.stack.forEach((s, i) => {
      if (i > 0 && !/^(apps|packages)\//.test(s)) hidden++;
      else lines.push(`   ${String(i + 1).padStart(2)}. ${s}`);
    });
    if (hidden) lines.push(`      (${hidden} more inside libraries and Node.js; see the .jsonl file)`);
  }
  return `${lines.join("\n")}\n\n`;
}

export class ErrorLog {
  private writing: Promise<unknown> = Promise.resolve();
  private cleanedFor = "";
  readonly maps: WebSourceMaps;

  constructor(private readonly options: ErrorLogOptions) {
    this.maps = new WebSourceMaps(options.webSourceMapsDir);
  }

  get dir(): string | null {
    return this.options.dir;
  }

  /** Writes an entry (in the background, in order); never throws. Returns the entry. */
  write(entry: Omit<ErrorEntry, "at"> & { at?: string }): ErrorEntry {
    const full: ErrorEntry = { at: entry.at ?? new Date().toISOString(), ...entry };
    const dir = this.options.dir;
    if (!dir) return full;
    const day = full.at.slice(0, 10);
    this.writing = this.writing
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(path.join(dir, `errors-${day}.log`), formatEntry(full, this.options.timeZone));
        await appendFile(path.join(dir, `errors-${day}.jsonl`), `${JSON.stringify(full)}\n`);
        if (this.cleanedFor !== day) {
          this.cleanedFor = day;
          await this.removeOld(day);
        }
      })
      .catch((e: unknown) => {
        // The log itself failed (disk full, no permission): say so where the process output goes.
        console.error(`error log: could not write to ${dir}: ${(e as Error).message}`);
      });
    return full;
  }

  /** An error caught by the application: described, located and written. */
  record(err: unknown, context: Omit<ErrorEntry, "at" | "message" | "kind" | "where" | "stack"> & { details?: Record<string, string | number> }): ErrorEntry {
    const d = describeError(err);
    const { where, stack } = placesOf(parseStack(err instanceof Error ? err.stack : undefined));
    return this.write({ ...context, message: d.message, kind: d.kind, where, stack, details: { ...d.details, ...context.details } });
  }

  /** Waits for what is being written (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writing;
  }

  private async removeOld(today: string): Promise<void> {
    const dir = this.options.dir!;
    const keepFrom = new Date(Date.parse(`${today}T00:00:00Z`) - this.options.retentionDays * 86_400_000).toISOString().slice(0, 10);
    for (const name of await readdir(dir)) {
      const m = /^errors-(\d{4}-\d{2}-\d{2})\.(log|jsonl)$/.exec(name);
      if (m && m[1]! < keepFrom) await unlink(path.join(dir, name)).catch(() => undefined);
    }
  }
}

/** The web app's private source maps: next to the built API in its container, or the local web build. */
export function defaultWebSourceMapsDir(): string | null {
  for (const dir of [path.resolve("web-sourcemaps"), path.resolve("../web/dist/assets")]) if (existsSync(dir)) return dir;
  return null;
}
