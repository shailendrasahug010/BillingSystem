#!/usr/bin/env node
/**
 * Builds Digital Bahi for one computer: a folder with the API (bundled, with
 * its production dependencies), the web app and the launcher. installer/windows
 * turns it into DigitalBahi-Setup.exe; on macOS and Linux it runs as it is
 * (digitalbahi.sh).
 *
 *   node installer/build-bundle.mjs [--target win32-x64] [--out dist-installer] [--skip-build] [--exe]
 *
 * The same steps as the Dockerfile's build stage. --target builds for another
 * system than this one (the native parts of dependencies are fetched for it
 * from npm); --exe also makes the Windows installer with NSIS (makensis).
 * Output: <out>/DigitalBahi/ (and <out>/DigitalBahi-Setup-<version>.exe).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const TARGET = option("--target", `${process.platform}-${process.arch}`);
const OUT = path.resolve(REPO, option("--out", "dist-installer"));
const BUNDLE = path.join(OUT, "DigitalBahi");
const [targetOs, targetCpu] = TARGET.split("-");
const HOST = `${process.platform}-${process.arch}`;
const VERSION = JSON.parse(readFileSync(path.join(REPO, "apps/api/package.json"), "utf8")).version;
const SHELL = process.platform === "win32";

if (!["win32", "linux", "darwin"].includes(targetOs) || !["x64", "arm64"].includes(targetCpu)) {
  console.error(`Unknown --target ${TARGET} (win32-x64, linux-x64, linux-arm64, darwin-x64, darwin-arm64)`);
  process.exit(2);
}

const step = (msg) => console.log(`\n== ${msg}`);
// pnpm is a .cmd on Windows, which only runs through the shell (so arguments with spaces are quoted).
// A step that fails has said why above: no stack trace of this script under it.
const sh = (cmd, cmdArgs, opts = {}) => {
  try {
    execFileSync(cmd, SHELL ? cmdArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : cmdArgs, { cwd: REPO, stdio: "inherit", shell: SHELL, ...opts });
  } catch (e) {
    console.error(`\n  "${[cmd, ...cmdArgs].join(" ")}" failed${e.status ? ` (code ${e.status})` : ""}: the lines above it say why.`);
    process.exit(1);
  }
};
const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: REPO }).toString().trim();
  } catch {
    return "unknown";
  }
})();

if (!args.includes("--skip-build")) {
  step("Building the API and the web app");
  sh("pnpm", ["--filter", "@digitalbahi/api", "build"]);
  sh("pnpm", ["--filter", "@digitalbahi/web", "build"], { env: { ...process.env, APP_BUILD: process.env.APP_BUILD ?? commit } });
}

step(`Assembling ${BUNDLE} for ${TARGET}`);
rmSync(BUNDLE, { recursive: true, force: true });
const deployed = path.join(OUT, ".deploy-api");
rmSync(deployed, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// Production dependencies only, in a plain node_modules (no links: the folder is copied to other computers).
sh("pnpm", ["--filter", "@digitalbahi/api", "deploy", "--legacy", "--prod", "--config.node-linker=hoisted", deployed]);

const api = path.join(BUNDLE, "api");
mkdirSync(api, { recursive: true });
cpSync(path.join(deployed, "package.json"), path.join(api, "package.json"));
cpSync(path.join(deployed, "node_modules"), path.join(api, "node_modules"), {
  recursive: true,
  dereference: true,
  // The workspace packages are inside the bundled dist/*.js already.
  filter: (src) => !/[\\/]node_modules[\\/](\.bin|@digitalbahi)([\\/]|$)/.test(src),
});
rmSync(deployed, { recursive: true, force: true });
cpSync(path.join(REPO, "apps/api/dist"), path.join(api, "dist"), { recursive: true });
for (const file of readdirSync(path.join(api, "dist"))) {
  if (file.endsWith(".js") && /(from |import\(|require\()"@digitalbahi\//.test(readFileSync(path.join(api, "dist", file), "utf8"))) throw new Error(`dist/${file} imports a workspace package at run time`);
}
cpSync(path.join(REPO, "packages/db/migrations"), path.join(api, "migrations"), { recursive: true });
cpSync(path.join(REPO, "apps/api/assets"), path.join(api, "assets"), { recursive: true });
// The bill reader needs only the compact English model; the full one (11 MB) is dropped (as in the Dockerfile).
rmSync(path.join(api, "node_modules/@tesseract.js-data/eng/4.0.0"), { recursive: true, force: true });

if (TARGET !== HOST) {
  step(`Native parts of dependencies for ${TARGET}`);
  await nativeBuildsFor(path.join(api, "node_modules"));
}

step("The web app (source maps go to the API, off the site)");
const web = path.join(BUNDLE, "web");
const maps = path.join(api, "web-sourcemaps");
mkdirSync(maps, { recursive: true });
cpSync(path.join(REPO, "apps/web/dist"), web, { recursive: true });
for (const file of walk(web)) {
  if (file.endsWith(".map")) renameSync(file, path.join(maps, path.basename(file)));
}

step("The launcher");
mkdirSync(path.join(BUNDLE, "launcher"));
cpSync(path.join(REPO, "installer/launcher.mjs"), path.join(BUNDLE, "launcher/launcher.mjs"));
if (targetOs === "win32") {
  cpSync(path.join(REPO, "installer/windows/DigitalBahi.ps1"), path.join(BUNDLE, "launcher/DigitalBahi.ps1"));
  cpSync(path.join(REPO, "installer/windows/DigitalBahi.cmd"), path.join(BUNDLE, "DigitalBahi.cmd"));
  cpSync(path.join(REPO, "installer/windows/digitalbahi.ico"), path.join(BUNDLE, "digitalbahi.ico"));
} else {
  cpSync(path.join(REPO, "installer/unix/digitalbahi.sh"), path.join(BUNDLE, "digitalbahi.sh"));
  chmodSync(path.join(BUNDLE, "digitalbahi.sh"), 0o755);
}
writeFileSync(path.join(BUNDLE, "VERSION.txt"), `Digital Bahi ${VERSION} (${commit}), built ${new Date().toISOString().slice(0, 10)} for ${TARGET}\n`);

if (args.includes("--exe")) {
  if (targetOs !== "win32") throw new Error("--exe is for --target win32-x64");
  step("The Windows installer (NSIS)");
  const makensis = [process.env.MAKENSIS, "C:\\Program Files (x86)\\NSIS\\makensis.exe", "makensis"].find((m) => m && (m === "makensis" || existsSync(m)));
  const exe = path.join(OUT, `DigitalBahi-Setup-${VERSION}.exe`);
  // Plain (not shell) call: the paths may have spaces.
  // makensis on Linux crashes on non-ASCII file names (a dependency's test fixture has one) unless the locale is UTF-8.
  const env = process.platform === "win32" ? process.env : { ...process.env, LC_ALL: "C.UTF-8" };
  // The files to pack, with this system's path separator (Windows makensis finds nothing behind a "/").
  execFileSync(makensis, [`-DVERSION=${VERSION}`, `-DBUNDLE_FILES=${path.join(BUNDLE, "*.*")}`, `-DOUTFILE=${exe}`, path.join(REPO, "installer/windows/DigitalBahi.nsi")], { stdio: "inherit", env });
  console.log(`\n${exe}`);
}
console.log(`\nDone: ${BUNDLE}`);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Packages with a native part ship it as optional per-system packages
 * (@node-rs/argon2-win32-x64-msvc...). pnpm installed this computer's; this
 * swaps in the target's, checked against npm's hash.
 */
async function nativeBuildsFor(nodeModules) {
  const packages = readdirSync(nodeModules).flatMap((name) => (name.startsWith("@") ? readdirSync(path.join(nodeModules, name)).map((n) => `${name}/${n}`) : [name]));
  for (const name of packages) {
    const manifest = path.join(nodeModules, name, "package.json");
    if (!existsSync(manifest)) continue;
    for (const [dep, version] of Object.entries(JSON.parse(readFileSync(manifest, "utf8")).optionalDependencies ?? {})) {
      // Per-system builds are pinned to the package's own version; a range is an ordinary optional package.
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) continue;
      const res = await fetch(`https://registry.npmjs.org/${dep.replace("/", "%2f")}/${version}`);
      if (!res.ok) throw new Error(`npm: ${dep}@${version}: ${res.status}`);
      const meta = await res.json();
      if (!meta.os && !meta.cpu) continue;
      const dir = path.join(nodeModules, dep);
      const fits = (!meta.os || meta.os.includes(targetOs)) && (!meta.cpu || meta.cpu.includes(targetCpu)) && (targetOs !== "linux" || !meta.libc || meta.libc.includes("glibc"));
      if (!fits) {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          console.log(`  - ${dep} (this computer's)`);
        }
        continue;
      }
      if (existsSync(dir)) continue;
      const tarball = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
      const [algorithm, expected] = [meta.dist.integrity.slice(0, meta.dist.integrity.indexOf("-")), meta.dist.integrity.slice(meta.dist.integrity.indexOf("-") + 1)];
      if (createHash(algorithm).update(tarball).digest("base64") !== expected) throw new Error(`${dep}: checksum mismatch`);
      const work = `${dir}.part`;
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      writeFileSync(path.join(work, "p.tgz"), tarball);
      execFileSync("tar", ["-xzf", "p.tgz"], { cwd: work });
      renameSync(path.join(work, "package"), dir);
      rmSync(work, { recursive: true, force: true });
      console.log(`  + ${dep}@${version}`);
    }
  }
}
