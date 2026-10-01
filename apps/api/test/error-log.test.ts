import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SourceMapGenerator } from "source-map-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guard } from "../src/lib/access.js";
import { describeError, enclosingName, ErrorLog, formatEntry, parseStack, placesOf, repoPath } from "../src/lib/errorLog.js";
import { browserOf } from "../src/modules/client-errors.js";
import type { ApiModule } from "../src/modules/types.js";
import { call, createTestApp, hasDatabase, signup, type Session, type TestApp } from "./helpers.js";

const THIS_FILE = "apps/api/test/error-log.test.ts";

/** Throws from a known line of this file. */
function brokenTotal(lines?: Array<{ qty: number }>): number {
  return lines!.reduce((sum, l) => sum + l.qty, 0); // BROKEN-LINE
}

async function lineOf(marker: string): Promise<number> {
  const text = await readFile(new URL(import.meta.url), "utf8");
  return text.split("\n").findIndex((l) => l.includes(marker) && !l.includes("lineOf(")) + 1;
}

describe("the error log's reading of an error", () => {
  it("finds where it happened: the file from the repository root and the line", async () => {
    let err: unknown;
    try {
      brokenTotal();
    } catch (e) {
      err = e;
    }
    const { where, stack } = placesOf(parseStack((err as Error).stack));
    expect(where).toMatchObject({ file: THIS_FILE, line: await lineOf("BROKEN-LINE"), fn: "brokenTotal" });
    expect(stack[0]).toMatch(new RegExp(`^${THIS_FILE}:\\d+:\\d+  brokenTotal$`));
    expect(describeError(err)).toMatchObject({ kind: "TypeError", message: "Cannot read properties of undefined (reading 'reduce')" });
  });

  it("keeps paths the same on a developer's machine, in the built API and in the browser", () => {
    expect(repoPath("/home/dev/BillingSystem/apps/api/src/modules/invoices/routes.ts")).toBe("apps/api/src/modules/invoices/routes.ts");
    expect(repoPath("file:///app/src/modules/invoices/routes.ts")).toBe("apps/api/src/modules/invoices/routes.ts");
    expect(repoPath("/packages/core/src/money.ts")).toBe("packages/core/src/money.ts");
    expect(repoPath("/app/node_modules/.pnpm/fastify@5.12.5/node_modules/fastify/lib/route.js")).toBe("node_modules/fastify/lib/route.js");
    expect(repoPath("http://localhost:5173/src/features/reports/ReportsPage.tsx?t=1727", "apps/web/")).toBe("apps/web/src/features/reports/ReportsPage.tsx");
    // Firefox and Safari write frames as fn@url:line:column.
    expect(parseStack("GroupedReport@https://bahi.example/assets/index-Ab12.js:1:2345\n@https://bahi.example/assets/index-Ab12.js:1:99")).toEqual([
      { fn: "GroupedReport", file: "https://bahi.example/assets/index-Ab12.js", line: 1, column: 2345 },
      { fn: null, file: "https://bahi.example/assets/index-Ab12.js", line: 1, column: 99 },
    ]);
  });

  it("puts a database error in plain words, with the table, column and query but not the values", () => {
    const pg = Object.assign(new Error('null value in column "invoice_date" of relation "invoices" violates not-null constraint'), { code: "23502", table: "invoices", column: "invoice_date" });
    const wrapped = Object.assign(new Error("Failed query: insert into invoices ..."), { name: "DrizzleQueryError", query: 'insert into "invoices" ("id", "invoice_date") values ($1, $2)', params: ["x", null], cause: pg });
    const d = describeError(wrapped);
    expect(d.message).toBe('Database error: null value in column "invoice_date" of relation "invoices" violates not-null constraint — a required value is missing (NOT NULL).');
    expect(d.kind).toBe("DatabaseError 23502");
    expect(d.details).toMatchObject({ table: "invoices", column: "invoice_date", query: 'insert into "invoices" ("id", "invoice_date") values ($1, $2)' });
    expect(JSON.stringify(d)).not.toContain('"x"');
  });

  it("names the function a source line sits in from the source text the maps carry", () => {
    const source = [
      "export function GroupedReport({ kind }: Props) {", // 1
      "  const label = (r: Row) => {", // 2
      "    return r.label;", // 3
      "  };", // 4
      "}", // 5
      "const r0HasQty = (rows: Row[] | undefined) => Boolean(rows?.some((r) => r.qty));", // 6
      "export class ScreenErrorBoundary extends Component {", // 7
      "  override componentDidCatch(error: Error) {", // 8
      "    if (error) report(error);", // 9
    ].join("\n");
    expect(enclosingName(source, 3)).toBe("label");
    expect(enclosingName(source, 6)).toBe("r0HasQty");
    expect(enclosingName(source, 9)).toBe("componentDidCatch");
    expect(enclosingName(null, 3)).toBeNull();
  });

  it("names the browser from its user agent", () => {
    expect(browserOf("Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36")).toBe("Chrome 129 on Android");
    expect(browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari 17 on iPhone/iPad");
  });

  it("writes a readable block and a JSON line a day, and deletes files past the days kept", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digitalbahi-log-"));
    await writeFile(path.join(dir, "errors-2026-07-01.log"), "old\n");
    await writeFile(path.join(dir, "errors-2026-07-01.jsonl"), "{}\n");
    await writeFile(path.join(dir, "errors-2026-09-15.log"), "recent\n");
    const log = new ErrorLog({ dir, retentionDays: 30, timeZone: "Asia/Kolkata", webSourceMapsDir: null });
    log.write({ at: "2026-09-30T09:34:12.000Z", reference: "ref-1", source: "job", message: "SMTP connection refused", kind: "Error ECONNREFUSED", where: null, stack: [], job: "automatic backup (emailed copy)" });
    await log.flush();
    expect((await readdir(dir)).sort()).toEqual(["errors-2026-09-15.log", "errors-2026-09-30.jsonl", "errors-2026-09-30.log"]);
    const text = await readFile(path.join(dir, "errors-2026-09-30.log"), "utf8");
    expect(text).toContain("[30/09/2026, 15:04:12 IST]  ERROR in a background job  ·  reference ref-1");
    expect(text).toContain("What happened : SMTP connection refused  (Error ECONNREFUSED)");
    expect(text).toContain("Where         : not known (no stack trace)");
    expect(text).toContain("Job           : automatic backup (emailed copy)");
    expect(JSON.parse((await readFile(path.join(dir, "errors-2026-09-30.jsonl"), "utf8")).trim())).toMatchObject({ reference: "ref-1", source: "job" });
    await rm(dir, { recursive: true });
  });
});

describe.skipIf(!hasDatabase)("errors written by the running API", () => {
  let t: TestApp;
  let owner: Session;
  let dir: string;
  let maps: string;

  const boom: ApiModule = async (app, deps) => {
    app.get("/test/boom", { preHandler: guard(deps) }, async () => ({ total: brokenTotal() }));
  };
  const logText = async () => {
    await t.app.deps.errors.flush();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".log"));
    return (await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")))).join("");
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "digitalbahi-log-"));
    maps = await mkdtemp(path.join(tmpdir(), "digitalbahi-maps-"));
    // A built web script, one line long, whose map points back at its source.
    const gen = new SourceMapGenerator({ file: "index-Ab12Cd.js" });
    gen.addMapping({ generated: { line: 1, column: 4120 }, original: { line: 88, column: 14 }, source: "../../src/features/reports/ReportsPage.tsx", name: "GroupedReport" });
    gen.addMapping({ generated: { line: 1, column: 9000 }, original: { line: 250, column: 8 }, source: "../../src/app/App.tsx", name: "Screen" });
    await writeFile(path.join(maps, "index-Ab12Cd.js.map"), gen.toString());
    t = await createTestApp({ logDir: dir, webSourceMapsDir: maps, extraModules: [boom] });
    owner = await signup(t, { name: "Ravi Gupta", legalName: "Log Traders" });
  });
  afterAll(async () => {
    await t?.close();
    await rm(dir, { recursive: true, force: true });
    await rm(maps, { recursive: true, force: true });
  });

  it("writes a failed request with what happened, the file and line, the request and who made it", async () => {
    const res = await call(t.app, "GET", "/test/boom?from=2026-09-01", { token: owner.token });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
    const ref = res.body.error.requestId;
    const text = await logText();
    expect(text).toContain(`ERROR in the API  ·  reference ${ref}`);
    expect(text).toContain("What happened : Cannot read properties of undefined (reading 'reduce')  (TypeError)");
    expect(text).toContain(`Where         : ${THIS_FILE}  line ${await lineOf("BROKEN-LINE")}`);
    expect(text).toContain("(in brokenTotal)");
    expect(text).toContain("Request       : GET /api/v1/test/boom?from=2026-09-01  →  500 INTERNAL");
    expect(text).toMatch(/Who {11}: Ravi Gupta {2}\(user [0-9a-f-]{36}, business [0-9a-f-]{36}\)/);
    // A refusal (a person's mistake, not a fault) is not written.
    await call(t.app, "POST", "/customers", { token: owner.token, body: { name: "" } });
    expect((await logText()).match(/━{78}/g)).toHaveLength(1);
  });

  it("writes an error from the browser at its source file and line, from the build's source maps", async () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'label')",
      "    at GroupedReport (https://bahi.example/assets/index-Ab12Cd.js:1:4121)",
      "    at renderWithHooks (https://bahi.example/assets/vendor-Zz99.js:1:777)",
      "    at Screen (https://bahi.example/assets/index-Ab12Cd.js:1:9001)",
    ].join("\n");
    const res = await call(t.app, "POST", "/client-errors", {
      token: owner.token,
      headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36" },
      body: {
        kind: "render",
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'label')",
        stack,
        componentStack: "\n    at GroupedReport (https://bahi.example/assets/index-Ab12Cd.js:1:4000)\n    at Reports (https://bahi.example/assets/index-Ab12Cd.js:1:5000)",
        screen: "reports",
        page: "https://bahi.example/",
        appVersion: "3f9a2c1d0e4b",
        reference: "0192f1a0-7c1e-7b3a-9d2e-5f6a7b8c9d0e",
      },
    });
    expect(res.status).toBe(202);
    expect(res.body.reference).toBe("0192f1a0-7c1e-7b3a-9d2e-5f6a7b8c9d0e");
    const text = await logText();
    expect(text).toContain("ERROR in the app (browser)  ·  reference 0192f1a0-7c1e-7b3a-9d2e-5f6a7b8c9d0e");
    expect(text).toContain("What happened : Cannot read properties of undefined (reading 'label')  (TypeError while showing a screen)");
    expect(text).toContain("Where         : apps/web/src/features/reports/ReportsPage.tsx  line 88, column 15  (in GroupedReport)");
    expect(text).toContain("Screen        : reports  ·  https://bahi.example/");
    expect(text).toContain("Browser       : Chrome 129 on Android  ·  app build 3f9a2c1d0e4b");
    expect(text).toContain("Who           : Ravi Gupta");
    expect(text).toContain("components  : GroupedReport › Reports");
    expect(text).toContain("apps/web/src/app/App.tsx:250:9  Screen");

    // Before sign-in too, and a stack the development server already mapped is kept as it is.
    const anon = await call(t.app, "POST", "/client-errors", { body: { kind: "error", message: "x is not a function", stack: "TypeError: x is not a function\n    at onClick (http://localhost:5173/src/features/auth/AuthPage.tsx:120:9)", mapped: true } });
    expect(anon.status).toBe(202);
    expect(await logText()).toContain("Where         : apps/web/src/features/auth/AuthPage.tsx  line 120, column 9  (in onClick)");
    expect((await call(t.app, "POST", "/client-errors", { body: { kind: "error", message: "x".repeat(3000) } })).status).toBe(400);
  });
});

describe("the errors summary", () => {
  it("counts the same error at the same place once, most frequent first", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "digitalbahi-log-"));
    const log = new ErrorLog({ dir, retentionDays: 30, timeZone: "Asia/Kolkata", webSourceMapsDir: null });
    const at = (m: number) => new Date(Date.UTC(2026, 8, 30, 9, m)).toISOString();
    const place = { file: "apps/api/src/modules/invoices/routes.ts", line: 212, column: 31, fn: "postInvoice" };
    for (const m of [1, 5, 9]) log.write({ at: at(m), reference: `r${m}`, source: "api", message: "boom", kind: "TypeError", where: place, stack: [] });
    log.write({ at: at(3), reference: "w1", source: "web", message: "x is not a function", kind: "TypeError", where: { ...place, file: "apps/web/src/a.tsx", line: 4, fn: null }, stack: [] });
    await log.flush();
    const { groupErrors, readEntries } = await import("../src/errors.js");
    const groups = groupErrors(await readEntries(dir, 2, new Date("2026-09-30T12:00:00Z")));
    expect(groups.map((g) => [g.count, g.where, g.last.reference])).toEqual([
      [3, "apps/api/src/modules/invoices/routes.ts:212  (in postInvoice)", "r9"],
      [1, "apps/web/src/a.tsx:4", "w1"],
    ]);
    await rm(dir, { recursive: true });
  });
});

describe("a readable block", () => {
  it("shows our frames and counts the library ones", () => {
    const text = formatEntry({
      at: "2026-09-30T09:34:12.000Z",
      reference: "r",
      source: "api",
      message: "boom",
      kind: "Error",
      where: { file: "apps/api/src/x.ts", line: 3, column: 7, fn: "f" },
      stack: ["apps/api/src/x.ts:3:7  f", "node_modules/fastify/lib/route.js:10:2", "node:internal/process/task_queues:105:5", "packages/core/src/y.ts:9:1  g"],
    });
    expect(text).toContain("    1. apps/api/src/x.ts:3:7  f");
    expect(text).toContain("    4. packages/core/src/y.ts:9:1  g");
    expect(text).toContain("(2 more inside libraries and Node.js; see the .jsonl file)");
    expect(text).not.toContain("fastify/lib/route.js");
  });
});
