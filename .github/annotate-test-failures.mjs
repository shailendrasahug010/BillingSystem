/**
 * Turns the failures in a test log into annotations on the pull request.
 * Vitest's own annotations need a line of the project's code in the stack, so
 * a database error, a timeout or a crash of the run gets none, and the job's
 * log is not always at hand. Each failed test (and each unhandled error) here
 * becomes one annotation with its first lines; with none found, the end of
 * the log does.
 *   node .github/annotate-test-failures.mjs <log file>
 */
import { readFileSync } from "node:fs";

const MAX_ANNOTATIONS = 10; // what GitHub keeps per step
const MAX_LINES = 40;

const colours = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const text = readFileSync(process.argv[2], "utf8")
  // Colours, and the "packages/core test: " that pnpm puts before each line of a package.
  .replace(colours, "")
  .split(/\r?\n/)
  .map((line) => line.replace(/^(?:apps|packages)\/[\w-]+ test: ?/, ""));

const blocks = [];
for (let i = 0; i < text.length; i++) {
  const line = text[i];
  const failed = /^\s*FAIL\s+(.+)$/.exec(line);
  const unhandled = /^⎯+\s*(Unhandled (?:Error|Rejection)[^⎯]*)⎯*$/.exec(line.trim());
  if (!failed && !unhandled) continue;
  const lines = [];
  for (let j = i + 1; j < text.length && lines.length < MAX_LINES; j++) {
    const next = text[j];
    if (/^\s*FAIL\s+/.test(next) || /^⎯{3,}/.test(next.trim())) break;
    lines.push(next);
  }
  const message = lines.join("\n").trim();
  // The run lists a failed test as it goes and again, with its error, at the end: keep the one that has it.
  if (failed && !message) continue;
  blocks.push({ title: failed ? failed[1].trim() : unhandled[1].trim(), message: message || line });
}

const escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

if (blocks.length === 0) {
  const tail = text.filter((l) => l.trim() !== "").slice(-MAX_LINES).join("\n");
  console.log(`::error title=${escapeProperty("Tests failed (the end of the log)")}::${escapeData(tail)}`);
} else {
  const seen = new Set();
  for (const b of blocks) {
    const key = `${b.title}\n${b.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > MAX_ANNOTATIONS) break;
    console.log(`::error title=${escapeProperty(b.title.slice(0, 200))}::${escapeData(b.message)}`);
  }
}
