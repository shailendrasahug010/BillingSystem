/**
 * Reads the error log files and prints what went wrong, most frequent first,
 * each with the file and line it happened at:
 *
 *   pnpm --filter @vyapaar/api errors                 errors of today and yesterday, grouped
 *   pnpm --filter @vyapaar/api errors --days 7        the last 7 days
 *   pnpm --filter @vyapaar/api errors --last 3        the 3 latest, in full
 *   pnpm --filter @vyapaar/api errors --ref <ref>     the error a person was shown this reference for
 *
 * In the container: docker compose exec api node dist/errors.js [same options].
 * LOG_DIR and LOG_TIME_ZONE as for the API (default ./logs, Asia/Kolkata).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { formatEntry, type ErrorEntry } from "./lib/errorLog.js";

export interface ErrorGroup {
  where: string;
  message: string;
  kind: string;
  count: number;
  last: ErrorEntry;
}

/** The same error at the same place counted once, most frequent (then latest) first. */
export function groupErrors(entries: ErrorEntry[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const e of entries) {
    const where = e.where ? `${e.where.file}:${e.where.line}${e.where.fn ? `  (in ${e.where.fn})` : ""}` : "(place not known)";
    const key = `${where}\n${e.message}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { where, message: e.message, kind: e.kind, count: 1, last: e });
    else {
      g.count++;
      if (e.at > g.last.at) g.last = e;
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.last.at.localeCompare(a.last.at));
}

export async function readEntries(dir: string, days: number, today = new Date()): Promise<ErrorEntry[]> {
  const from = new Date(today.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: ErrorEntry[] = [];
  for (const name of names.filter((n) => /^errors-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(7, 17) >= from).sort()) {
    for (const line of (await readFile(path.join(dir, name), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as ErrorEntry);
      } catch {
        // A line cut short (the API stopped while writing it).
      }
    }
  }
  return entries;
}

const SOURCE: Record<ErrorEntry["source"], string> = { api: "API", web: "app (browser)", job: "background job", database: "database", process: "API process" };

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = path.resolve(process.env.LOG_DIR || "logs");
  const timeZone = process.env.LOG_TIME_ZONE || "Asia/Kolkata";
  const ref = opt("--ref");
  const days = Math.max(1, Number(opt("--days") ?? (ref ? 30 : 2)) || 2);
  const entries = await readEntries(dir, days);

  if (ref) {
    const found = entries.filter((e) => e.reference === ref || e.reference.endsWith(ref));
    if (!found.length) console.log(`No error with reference ${ref} in ${dir} (last ${days} days).`);
    for (const e of found) process.stdout.write(formatEntry(e, timeZone));
    return;
  }
  const last = opt("--last");
  if (last) {
    for (const e of entries.slice(-Math.max(1, Number(last) || 1))) process.stdout.write(formatEntry(e, timeZone));
    return;
  }
  const groups = groupErrors(entries);
  console.log(entries.length ? `Errors in ${dir} for the last ${days} day(s): ${entries.length} in ${groups.length} place(s)\n` : `No errors in ${dir} for the last ${days} day(s).`);
  const when = new Intl.DateTimeFormat("en-IN", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
  for (const g of groups) {
    console.log(`${`${g.count}×`.padStart(6)}  ${g.where}`);
    console.log(`        ${g.message}  (${g.kind})`);
    console.log(`        last ${when.format(new Date(g.last.at))} · ${SOURCE[g.last.source]} · reference ${g.last.reference}  (errors-${g.last.at.slice(0, 10)}.log)\n`);
  }
}

if (process.argv[1] && /errors\.(ts|js)$/.test(process.argv[1])) await main();
