#!/usr/bin/env node
/**
 * Digital Bahi on one computer (Windows, macOS, Linux). The first start sets
 * everything up; later starts take a few seconds.
 *
 *   node launcher.mjs start [--no-browser] [--phone | --no-phone] [--backup-folder <folder>]
 *                                             set up if needed, start, open the app
 *   node launcher.mjs stop                    stop the server and the database
 *   node launcher.mjs restart [--no-browser] [--phone | --no-phone]
 *   node launcher.mjs status
 *
 * It runs from the bundle installer/build-bundle.mjs makes (api/, web/,
 * launcher/), with Node.js 22 or newer: the Windows and macOS / Linux
 * wrappers (windows/DigitalBahi.ps1, unix/digitalbahi.sh) download Node.js
 * first when the computer has none.
 *
 * - PostgreSQL: the computer's own when it has version 16 or newer (with
 *   pg_trgm), else PostgreSQL 16 downloaded once (the npm package
 *   @embedded-postgres/<platform>, checked against the hash below). Either way
 *   Digital Bahi gets a database cluster of its own in the data folder, on
 *   its own port, open to this computer only, with passwords made at setup:
 *   an existing PostgreSQL server and its databases are never touched.
 * - The server: the API, which also serves the web app, at
 *   http://localhost:<port>, open to this computer only. There is no SMS
 *   gateway on one computer, so sign-up and OTP codes are shown on the screen
 *   (OTP_DEV_ECHO); that is why, by default, the server never listens on the
 *   network. Other computers and phones need a server (HOW-TO-RUN.md,
 *   section 5), or phone mode below.
 * - Phone mode (--phone, remembered in config.json as "phone": true until
 *   --no-phone): the server also answers phones and computers on the same
 *   Wi-Fi, at http://<this computer's address>:<port>, printed with a QR
 *   code to scan. Sign-up and OTP codes are then still shown only on this
 *   computer (OTP_DEV_ECHO_LOCAL_ONLY): on a phone, staff sign in with a
 *   user ID and password. The database stays open to this computer only.
 * - Automatic backups (Backup & Restore → Automatic backups) are saved in
 *   the data folder's "backups" folder, or the one --backup-folder names
 *   (remembered as "backupFolder"): a pen drive, or a Google Drive /
 *   OneDrive folder on this computer, which copies them online by itself.
 * - The data folder: %LOCALAPPDATA%\DigitalBahi (Windows),
 *   ~/Library/Application Support/DigitalBahi (macOS),
 *   ~/.local/share/digitalbahi (Linux), or DIGITALBAHI_HOME. It holds the
 *   database (pgdata), config.json (ports, passwords and keys; "env" adds or
 *   changes the API's settings, e.g. SMTP_URL) and the logs. Back up the
 *   whole folder: bank details in the database can only be read with the
 *   encryption key in config.json.
 *
 * DIGITALBAHI_PG_BIN=<folder> uses the PostgreSQL programs in that folder;
 * DIGITALBAHI_PG_DOWNLOAD=1 downloads PostgreSQL 16 even when the computer
 * has a PostgreSQL. Both only matter before the database is first created.
 */
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "api");
const WEB_DIR = path.join(ROOT, "web");
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
/** The server's own HTTPS calls (WhatsApp, email, webhooks) trust the computer's certificates too, as the launcher's do. */
const NODE_FLAGS = process.execArgv.includes("--use-system-ca") ? ["--use-system-ca"] : [];

/**
 * PostgreSQL downloaded when the computer has none: the builds npm publishes
 * as @embedded-postgres/<platform> (PostgreSQL 16.14 with its extensions),
 * pinned to the hash npm records for each file.
 */
const PG_DOWNLOAD = {
  version: "16.14.0-beta.17",
  major: 16,
  builds: {
    "win32-x64": ["windows-x64", "sha512-Wn4nuAT1H7SIJuLWPs+C1aSdZKpbTloCr0Xaozdfg956lUVvv3iHv6K8Lsc+xmtt1qQpTno3PJLqAgzJ/lg60Q=="],
    "linux-x64": ["linux-x64", "sha512-8fr7hEiI7XlbPDPsLZJ4RU1NR6jTIDWpf81Sfiwk3T845V0yJJGxjawjkQZmIWVgPW/qY/dMSv0o08FRWJ/zsg=="],
    "linux-arm64": ["linux-arm64", "sha512-LNT9TXoOGR/RSop1PewcMtpuf1Dtg6sKU7sFA1ODqInRA8NoP15HyLekUHW5aWnruu4yfs1pcy6DaV39T556mQ=="],
    "darwin-x64": ["darwin-x64", "sha512-zikibpPYGWokfT/OFWNHCwerA3ZGat0ZyCIXOIbIucLBMDHztQ2WZQ9R5zil6oOxzElrMz2Q4aEOssGNrMDdyg=="],
    "darwin-arm64": ["darwin-arm64", "sha512-CB1DFZ08zfmNapx231rAJW74UZfs1jQmeGLwbQSaAIRVs2uqEdMhVNLwVlztFG3ZPSeuCsgTn/0yeYDmKF67og=="],
  },
};
const MIN_PG_MAJOR = 16;

const DB_NAME = "digitalbahi";
const OWNER_ROLE = "digitalbahi_owner";
const APP_ROLE = "digitalbahi_app";
/** Ports tried, in order, the first time (then kept in config.json, so the app's address never changes). */
const API_PORTS = range(8710, 8730);
const PG_PORTS = range(54320, 54340);

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function dataHome() {
  if (process.env.DIGITALBAHI_HOME) return path.resolve(process.env.DIGITALBAHI_HOME);
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "DigitalBahi");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "DigitalBahi");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "digitalbahi");
}

const HOME = dataHome();
const FILES = {
  config: path.join(HOME, "config.json"),
  pgdata: path.join(HOME, "pgdata"),
  logs: path.join(HOME, "logs"),
  runtime: path.join(HOME, "runtime"),
  pid: path.join(HOME, "server.pid"),
  lock: path.join(HOME, "launcher.lock"),
};

class Stop extends Error {}
/** Ends the command with a message for the person at the computer (no stack trace). */
function fail(message) {
  throw new Stop(message);
}
const say = (message) => console.log(`  ${message}`);

// ---------------------------------------------------------------- processes and ports

/** Runs a program to its end; its output is returned (and shown unless quiet). */
function run(command, args, { env = process.env, cwd, quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (chunk) => {
      out += chunk;
      if (!quiet) process.stdout.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

const portFree = async (port) => !(await canConnect(port)) && (await canListen(port));

async function firstFreePort(ports, taken = []) {
  for (const port of ports) if (!taken.includes(port) && (await portFree(port))) return port;
  fail(`No free port between ${ports[0]} and ${ports.at(-1)}. Close some programs and start Digital Bahi again.`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Whether the process is this API (a pid in an old pid file may now be another program's). */
async function isServerProcess(pid) {
  if (!alive(pid)) return false;
  if (IS_WIN) {
    const { out } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).catch(() => ({ out: "" }));
    return /"node(\.exe)?"/i.test(out);
  }
  const { out } = await run("ps", ["-p", String(pid), "-o", "args="]).catch(() => ({ out: "" }));
  return out.includes(path.join("dist", "main.js"));
}

function tail(file, lines = 25) {
  try {
    return readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-lines).map((l) => `    | ${l}`).join("\n");
  } catch {
    return "    | (no log)";
  }
}

// ---------------------------------------------------------------- settings

async function loadConfig() {
  if (existsSync(FILES.config)) {
    let cfg;
    try {
      cfg = JSON.parse(await readFile(FILES.config, "utf8"));
    } catch (e) {
      fail(`${FILES.config} cannot be read (${e.message}). Put back a good copy, or fix the mistake in it.`);
    }
    for (const key of ["apiPort", "pgPort", "ownerPassword", "appPassword", "jwtPrivateKey", "jwtPublicKey", "dataEncryptionKey"]) {
      if (!cfg[key]) fail(`${FILES.config} has no "${key}". Put back a good copy of the file.`);
    }
    return cfg;
  }
  if (existsSync(path.join(FILES.pgdata, "PG_VERSION"))) {
    fail(`The database is in ${FILES.pgdata}, but config.json (its passwords and keys) is missing. Put back the copy of config.json from your backup.`);
  }
  const apiPort = await firstFreePort(API_PORTS);
  const pgPort = await firstFreePort(PG_PORTS, [apiPort]);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cfg = {
    note: "Digital Bahi on this computer. Keep a copy of this file with your backups: without dataEncryptionKey, bank details in the database cannot be read. 'env' adds or changes the server's settings (see HOW-TO-RUN.md).",
    apiPort,
    pgPort,
    ownerPassword: randomBytes(24).toString("hex"),
    appPassword: randomBytes(24).toString("hex"),
    jwtPrivateKey: privateKey,
    jwtPublicKey: publicKey,
    dataEncryptionKey: randomBytes(32).toString("base64"),
    createdAt: new Date().toISOString(),
    env: {},
  };
  await saveConfig(cfg);
  return cfg;
}

async function saveConfig(cfg) {
  await writeFile(FILES.config, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  if (!IS_WIN) await chmod(FILES.config, 0o600);
}

const appUrl = (cfg) => `http://localhost:${cfg.apiPort}`;

/**
 * This computer's addresses on the local network (Wi-Fi or cable), home
 * routers' 192.168.x.x first: the ones a phone on the same Wi-Fi can open.
 */
function lanAddresses() {
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))
    .map((a) => a.address)
    .filter((ip, i, all) => all.indexOf(ip) === i)
    .sort((a, b) => rank(a) - rank(b));
}

const phoneUrls = (cfg) => lanAddresses().map((ip) => `http://${ip}:${cfg.apiPort}`);

/** A QR code drawn with text blocks (two rows of modules per line) for a terminal, or null when the QR library is missing. */
function qrText(text) {
  let qrcode;
  try {
    qrcode = createRequire(path.join(API_DIR, "package.json"))("qrcode-generator");
  } catch {
    return null;
  }
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  // Black on white whatever the terminal's own colours, so phone cameras read it.
  const dark = (r, c) => r >= 0 && r < n && c >= 0 && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = "";
    for (let c = -2; c < n + 2; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    lines.push(`  \x1b[30;107m${line}\x1b[0m`);
  }
  return lines.join("\n");
}

function showPhoneAddress(cfg) {
  const urls = phoneUrls(cfg);
  console.log("");
  if (urls.length === 0) {
    say("Phones: this computer is not on a Wi-Fi or network right now. Connect it, then start Digital Bahi again.");
    return;
  }
  say("On a phone on the same Wi-Fi, open this address in Chrome (or scan the code with the camera):");
  console.log("");
  say(`    ${urls[0]}`);
  for (const other of urls.slice(1)) say(`    (or ${other})`);
  const qr = process.stdout.isTTY ? qrText(urls[0]) : null;
  if (qr) console.log(`\n${qr}`);
  console.log("");
  say("Sign in on the phone with a user ID and password (Users & Roles -> Add member):");
  say("sign-up and OTP codes are only shown on this computer.");
  say(`If the phone cannot open it, allow Node.js through this computer's firewall${IS_WIN ? " (Private networks)" : ""}.`);
}

/** Whether the running server answers on the network: it was started in phone mode. */
async function answersNetwork(cfg) {
  const [ip] = lanAddresses();
  if (!ip) return cfg.phone;
  try {
    return (await fetch(`http://${ip}:${cfg.apiPort}/api/v1/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const ownerUrl = (cfg, db = DB_NAME) => `postgres://${OWNER_ROLE}:${cfg.ownerPassword}@127.0.0.1:${cfg.pgPort}/${db}`;

// ---------------------------------------------------------------- PostgreSQL

const pgTool = (bin, name) => path.join(bin, name + EXE);
const hasPgTools = (bin) => ["initdb", "pg_ctl", "postgres"].every((t) => existsSync(pgTool(bin, t)));

async function pgMajor(bin) {
  const { code, out } = await run(pgTool(bin, "pg_ctl"), ["--version"]);
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(out);
  if (code !== 0 || !m) throw new Error(`pg_ctl --version failed: ${out.trim()}`);
  return Number(m[1]);
}

/** pg_trgm (product and customer search) comes with PostgreSQL's contrib extensions, which some packages leave out. */
async function hasTrgm(bin, major) {
  const shares = [];
  if (existsSync(pgTool(bin, "pg_config"))) {
    const r = await run(pgTool(bin, "pg_config"), ["--sharedir"]).catch(() => null);
    if (r?.code === 0) shares.push(r.out.trim());
  }
  shares.push(path.join(bin, "..", "share"), path.join(bin, "..", "share", "postgresql"), `/usr/share/postgresql/${major}`, `/usr/pgsql-${major}/share`, "/usr/share/pgsql", "/usr/share/postgresql");
  return shares.some((dir) => existsSync(path.join(dir, "extension", "pg_trgm.control")));
}

function listDirs(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(parent, e.name));
  } catch {
    return [];
  }
}

/** Folders where an installed PostgreSQL keeps its programs. */
function systemPgFolders() {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (IS_WIN) {
    for (const pf of new Set([process.env.ProgramW6432, process.env.ProgramFiles].filter(Boolean))) {
      dirs.push(...listDirs(path.join(pf, "PostgreSQL")).map((d) => path.join(d, "bin")));
    }
  } else if (process.platform === "darwin") {
    for (const brew of ["/opt/homebrew/opt", "/usr/local/opt"]) dirs.push(...listDirs(brew).filter((d) => /\/postgresql(@\d+)?$/.test(d)).map((d) => path.join(d, "bin")));
    dirs.push(...listDirs("/Applications/Postgres.app/Contents/Versions").map((d) => path.join(d, "bin")));
  } else {
    dirs.push(...listDirs("/usr/lib/postgresql").map((d) => path.join(d, "bin")), ...listDirs("/usr").filter((d) => /\/pgsql-\d+$/.test(d)).map((d) => path.join(d, "bin")), "/usr/local/pgsql/bin");
  }
  return [...new Set(dirs.map((d) => path.resolve(d)))].filter(hasPgTools);
}

/** The newest usable PostgreSQL on the computer (or exactly `major`, for a database made with it). */
async function findSystemPg(major) {
  let best = null;
  for (const bin of systemPgFolders()) {
    const found = await pgMajor(bin).catch(() => null);
    if (!found || found < MIN_PG_MAJOR || (major && found !== major)) continue;
    if (!(await hasTrgm(bin, found))) continue;
    if (!best || found > best.major) best = { bin, major: found };
  }
  return best;
}

async function download(url, what) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    fail(`Could not download ${what} (${e.cause?.code ?? e.message}). Check the internet connection, then start Digital Bahi again.`);
  }
  if (!res.ok) fail(`Could not download ${what} (${res.status} from ${new URL(url).host}). Start Digital Bahi again in a while.`);
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks = [];
  let got = 0;
  let shown = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (total && got / total >= shown + 0.2) {
      shown = Math.floor((got / total) * 5) / 5;
      say(`  ${Math.round(shown * 100)}%`);
    }
  }
  return Buffer.concat(chunks);
}

/** Windows antivirus may hold new files open for a moment after they are written. */
async function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (!IS_WIN || attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      await sleep(500);
    }
  }
}

/** Unpacks a .tgz with the system's tar (Windows 10 and 11 have one; Git's tar would misread C:\ paths). */
async function untar(archive, into) {
  const tar = IS_WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  const { code, out } = await run(tar, ["-xzf", path.basename(archive)], { cwd: into });
  if (code !== 0) fail(`Could not unpack ${path.basename(archive)}: ${out.trim()}`);
}

async function downloadPg() {
  const platform = `${process.platform}-${process.arch}`;
  const build = PG_DOWNLOAD.builds[platform];
  if (!build) fail(`There is no PostgreSQL download for this computer (${platform}). Install PostgreSQL ${MIN_PG_MAJOR} or newer, then start Digital Bahi again.`);
  const [name, integrity] = build;
  const dir = path.join(FILES.runtime, `postgresql-${PG_DOWNLOAD.version}-${platform}`);
  const bin = path.join(dir, "bin");
  if (hasPgTools(bin)) return { bin, major: PG_DOWNLOAD.major };

  say(`Downloading PostgreSQL ${PG_DOWNLOAD.major} (25 to 40 MB, only this once)...`);
  const data = await download(`https://registry.npmjs.org/@embedded-postgres/${name}/-/${name}-${PG_DOWNLOAD.version}.tgz`, "PostgreSQL");
  const [algorithm, expected] = [integrity.slice(0, integrity.indexOf("-")), integrity.slice(integrity.indexOf("-") + 1)];
  if (createHash(algorithm).update(data).digest("base64") !== expected) fail("The PostgreSQL download is damaged (its checksum does not match). Start Digital Bahi again to download it again.");

  const work = `${dir}.part`;
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await writeFile(path.join(work, "postgresql.tgz"), data);
  await untar(path.join(work, "postgresql.tgz"), work);
  const native = path.join(work, "package", "native");
  // macOS and Linux builds list their library links separately (npm packages cannot hold links).
  const links = path.join(native, "pg-symlinks.json");
  if (existsSync(links)) {
    for (const { source, target } of JSON.parse(await readFile(links, "utf8"))) {
      const from = path.join(work, "package", source);
      const at = path.join(work, "package", target);
      await symlink(path.relative(path.dirname(at), from), at).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  await renameRetrying(native, dir);
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  if (!hasPgTools(bin)) fail(`The PostgreSQL download did not have its programs (${bin}).`);
  return { bin, major: PG_DOWNLOAD.major };
}

/** Picks the PostgreSQL programs once, and finds them again if they moved. */
async function ensurePg(cfg) {
  if (cfg.pgBin && hasPgTools(cfg.pgBin)) return;
  const made = existsSync(path.join(FILES.pgdata, "PG_VERSION")) ? Number(readFileSync(path.join(FILES.pgdata, "PG_VERSION"), "utf8").trim()) : null;
  let pick;
  if (made) {
    // Only the same major version opens a database cluster.
    pick = made === PG_DOWNLOAD.major ? await downloadPg() : await findSystemPg(made);
    if (!pick) fail(`Digital Bahi's database was made with PostgreSQL ${made}, which is no longer on this computer${cfg.pgBin ? ` (${cfg.pgBin})` : ""}. Install PostgreSQL ${made} again, then start Digital Bahi.`);
  } else if (process.env.DIGITALBAHI_PG_BIN) {
    const bin = path.resolve(process.env.DIGITALBAHI_PG_BIN);
    if (!hasPgTools(bin)) fail(`DIGITALBAHI_PG_BIN (${bin}) does not have initdb, pg_ctl and postgres.`);
    pick = { bin, major: await pgMajor(bin) };
    if (pick.major < MIN_PG_MAJOR) fail(`DIGITALBAHI_PG_BIN has PostgreSQL ${pick.major}; Digital Bahi needs ${MIN_PG_MAJOR} or newer.`);
  } else {
    pick = process.env.DIGITALBAHI_PG_DOWNLOAD === "1" ? null : await findSystemPg();
    if (pick) say(`Using PostgreSQL ${pick.major} already on this computer (${pick.bin}), with a database of Digital Bahi's own.`);
    else pick = await downloadPg();
  }
  cfg.pgBin = pick.bin;
  cfg.pgMajor = pick.major;
  await saveConfig(cfg);
}

/** Libc locales tried for character rules (pg_trgm needs a UTF-8 one for Hindi names); sorting is ICU's where the build has it. */
function localeChoices() {
  if (IS_WIN) return [[]];
  if (process.platform === "darwin") return [["--locale=en_US.UTF-8"], []];
  return [["--locale=C.UTF-8"], ["--locale=en_US.UTF-8"], [], ["--locale=C"]];
}

async function initCluster(cfg) {
  say("Creating Digital Bahi's database (only this once)...");
  const pwfile = path.join(HOME, `initdb-${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(pwfile, `${cfg.ownerPassword}\n`, { mode: 0o600 });
  let last = "";
  try {
    for (const locale of localeChoices()) {
      for (const icu of [["--locale-provider=icu", "--icu-locale=und"], []]) {
        await rm(FILES.pgdata, { recursive: true, force: true });
        const args = ["-D", FILES.pgdata, "-U", OWNER_ROLE, `--pwfile=${pwfile}`, "--auth=scram-sha-256", "--encoding=UTF8", ...icu, ...locale];
        const r = await run(pgTool(cfg.pgBin, "initdb"), args);
        if (r.code === 0) {
          await appendFile(path.join(FILES.pgdata, "postgresql.conf"), "\n# Digital Bahi: port and addresses, written at each start from config.json\ninclude_if_exists = 'digitalbahi.conf'\n");
          return;
        }
        last = r.out;
        // A missing C++ runtime (Windows) or a broken install fails the same way every time.
        if (r.code === 3221225781 || r.code === -1073741515) fail("PostgreSQL could not start: the Microsoft Visual C++ runtime is missing. Start Digital Bahi again (it installs it), or install it from https://aka.ms/vs/17/release/vc_redist.x64.exe");
      }
    }
  } finally {
    await rm(pwfile, { force: true });
  }
  await rm(FILES.pgdata, { recursive: true, force: true });
  fail(`Could not create the database:\n${last.trim()}`);
}

async function pgRunning(cfg) {
  if (!existsSync(path.join(FILES.pgdata, "PG_VERSION"))) return false;
  const { code } = await run(pgTool(cfg.pgBin, "pg_ctl"), ["status", "-D", FILES.pgdata]);
  return code === 0;
}

async function startPg(cfg) {
  if (await pgRunning(cfg)) return;
  await writeFile(
    path.join(FILES.pgdata, "digitalbahi.conf"),
    [
      "# Written by the Digital Bahi launcher at each start; change ports in config.json.",
      "listen_addresses = '127.0.0.1'",
      `port = ${cfg.pgPort}`,
      "unix_socket_directories = ''",
      "max_connections = 50",
      "",
    ].join("\n"),
  );
  if (!(await portFree(cfg.pgPort))) fail(`Port ${cfg.pgPort} (Digital Bahi's database) is used by another program. Close it, or set "pgPort" in ${FILES.config} to a free port, then start again.`);
  say("Starting the database...");
  const logFile = path.join(FILES.logs, "postgresql.log");
  const { code, out } = await new Promise((resolve, reject) => {
    // No inherited handles: on Windows pg_ctl then gets a hidden console of its own, so the
    // database keeps running when this window closes (macOS / Linux: a session of its own).
    // The server it starts may hold the pipes open, so its end is the process exiting.
    const child = spawn(pgTool(cfg.pgBin, "pg_ctl"), ["start", "-D", FILES.pgdata, "-l", logFile, "-w", "-t", "120"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !IS_WIN });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    child.on("error", reject);
    child.on("exit", (exit) => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code: exit, out: text });
    });
  });
  await appendFile(path.join(FILES.logs, "pg_ctl.log"), `\n--- ${new Date().toISOString()}\n${out}`);
  if (code !== 0) fail(`The database did not start. The end of its log (${logFile}):\n${tail(logFile)}`);
}

async function stopPg(cfg) {
  if (!cfg.pgBin || !(await pgRunning(cfg))) return false;
  say("Stopping the database...");
  const { code, out } = await run(pgTool(cfg.pgBin, "pg_ctl"), ["stop", "-D", FILES.pgdata, "-m", "fast", "-w", "-t", "60"]);
  if (code !== 0) fail(`The database did not stop: ${out.trim()}`);
  return true;
}

async function ensureDatabase(cfg) {
  const pg = createRequire(path.join(API_DIR, "package.json"))("pg");
  const client = new pg.Client({ connectionString: ownerUrl(cfg, "postgres") });
  await client.connect();
  try {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [DB_NAME]);
    if (!rowCount) await client.query(`create database ${DB_NAME}`);
  } finally {
    await client.end();
  }
}

/** Migrations, the API's own database role and reference data: quick when nothing changed, and how an update reaches the database. */
async function migrate(cfg) {
  say("Bringing the database up to date...");
  const { code, out } = await run(process.execPath, [path.join(API_DIR, "dist", "deploy.js")], {
    cwd: API_DIR,
    env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl(cfg), APP_DB_ROLE: APP_ROLE, APP_DB_PASSWORD: cfg.appPassword },
  });
  await appendFile(path.join(FILES.logs, "migrations.log"), `\n--- ${new Date().toISOString()}\n${out}`);
  if (code !== 0) fail(`Could not bring the database up to date:\n${out.trim()}`);
}

// ---------------------------------------------------------------- the server

async function healthy(cfg) {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.apiPort}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function apiEnv(cfg) {
  const sourceMaps = path.join(API_DIR, "web-sourcemaps");
  return {
    ...process.env,
    // Development mode for OTP codes on screen; the rest set as a real server has it.
    NODE_ENV: "development",
    OTP_DEV_ECHO: "true",
    // Phone mode: phones on the Wi-Fi too, but codes on screen only for this computer.
    HOST: cfg.phone ? "0.0.0.0" : "127.0.0.1",
    ...(cfg.phone ? { OTP_DEV_ECHO_LOCAL_ONLY: "true" } : {}),
    BACKUP_FOLDER: cfg.backupFolder || path.join(HOME, "backups"),
    PORT: String(cfg.apiPort),
    DATABASE_URL: `postgres://${APP_ROLE}:${cfg.appPassword}@127.0.0.1:${cfg.pgPort}/${DB_NAME}`,
    JWT_PRIVATE_KEY: cfg.jwtPrivateKey,
    JWT_PUBLIC_KEY: cfg.jwtPublicKey,
    DATA_ENCRYPTION_KEY: cfg.dataEncryptionKey,
    MESSAGING_DRIVER: "live",
    DOCS_ENABLED: "false",
    COOKIE_SECURE: "false",
    LOG_PRETTY: "false",
    LOG_DIR: FILES.logs,
    WEB_DIR,
    ...(existsSync(sourceMaps) ? { WEB_SOURCEMAPS_DIR: sourceMaps } : {}),
    ...Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, String(v)])),
  };
}

async function startApi(cfg) {
  if (!(await portFree(cfg.apiPort))) fail(`Port ${cfg.apiPort} (Digital Bahi's address) is used by another program. Close it, or set "apiPort" in ${FILES.config} to a free port, then start again.`);
  say("Starting the server...");
  const logFile = path.join(FILES.logs, "server.log");
  if (existsSync(logFile) && statSync(logFile).size > 20 * 1024 * 1024) await rename(logFile, `${logFile}.1`);
  const out = openSync(logFile, "a");
  const child = spawn(process.execPath, [...NODE_FLAGS, "--enable-source-maps", path.join(API_DIR, "dist", "main.js")], {
    cwd: API_DIR,
    env: apiEnv(cfg),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  let exited = null;
  child.on("exit", (code) => (exited = code ?? -1));
  child.unref();
  await writeFile(FILES.pid, String(child.pid));
  for (let waited = 0; waited < 120_000; waited += 500) {
    if (exited !== null) {
      await rm(FILES.pid, { force: true });
      fail(`The server stopped while starting. The end of its log (${logFile}):\n${tail(logFile)}`);
    }
    if (await healthy(cfg)) return;
    await sleep(500);
  }
  fail(`The server did not answer within 2 minutes. The end of its log (${logFile}):\n${tail(logFile)}`);
}

async function stopApi() {
  const pid = existsSync(FILES.pid) ? Number(readFileSync(FILES.pid, "utf8").trim()) : null;
  if (!pid || !(await isServerProcess(pid))) {
    await rm(FILES.pid, { force: true });
    return false;
  }
  say("Stopping the server...");
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < 15_000 && alive(pid); waited += 250) await sleep(250);
  if (alive(pid)) process.kill(pid, "SIGKILL");
  await rm(FILES.pid, { force: true });
  return true;
}

function openBrowser(url) {
  const [command, args] = IS_WIN ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: false });
    child.on("error", () => say(`Open ${url} in Chrome or Edge.`));
    child.unref();
  } catch {
    say(`Open ${url} in Chrome or Edge.`);
  }
}

// ---------------------------------------------------------------- commands

/** One launcher at a time (a double click while it is still starting waits for the first). */
async function withLock(work) {
  await mkdir(HOME, { recursive: true });
  for (let waited = 0; ; waited += 500) {
    try {
      await writeFile(FILES.lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const holder = Number(readFileSync(FILES.lock, "utf8").trim());
      if (!holder || !alive(holder) || waited > 180_000) await unlink(FILES.lock).catch(() => {});
      else {
        if (waited === 0) say("Digital Bahi is already starting or stopping; waiting for it...");
        await sleep(500);
      }
    }
  }
  try {
    return await work();
  } finally {
    await unlink(FILES.lock).catch(() => {});
  }
}

function checkBundle() {
  for (const file of [path.join(API_DIR, "dist", "main.js"), path.join(API_DIR, "dist", "deploy.js"), path.join(WEB_DIR, "index.html")]) {
    if (!existsSync(file)) fail(`${file} is missing: install Digital Bahi again.`);
  }
}

async function start({ browser, phone, backupFolder }) {
  checkBundle();
  if (!IS_WIN && process.getuid?.() === 0) fail("Start Digital Bahi as your normal user, not as root (PostgreSQL does not run as root).");
  await mkdir(FILES.logs, { recursive: true });
  await mkdir(FILES.runtime, { recursive: true });
  if (!IS_WIN) await chmod(HOME, 0o700);
  const cfg = await loadConfig();
  let changed = false;
  if (phone !== undefined && Boolean(cfg.phone) !== phone) {
    cfg.phone = phone;
    changed = true;
    say(phone ? "Phone mode is on: phones on the same Wi-Fi can open Digital Bahi too." : "Phone mode is off: only this computer can open Digital Bahi.");
  }
  if (backupFolder !== undefined && cfg.backupFolder !== backupFolder) {
    cfg.backupFolder = backupFolder;
    changed = true;
    say(`Automatic backups will be saved in ${backupFolder || path.join(HOME, "backups")}`);
  }
  if (changed) await saveConfig(cfg);
  if ((await healthy(cfg)) && (changed || (await answersNetwork(cfg)) !== Boolean(cfg.phone))) {
    // Running, but started with other settings: the server (not the database) starts again.
    await stopApi();
    await startApi(cfg);
    say(`Digital Bahi is running: ${appUrl(cfg)}`);
  } else if (await healthy(cfg)) {
    say(`Digital Bahi is already running: ${appUrl(cfg)}`);
  } else {
    await ensurePg(cfg);
    const made = path.join(FILES.pgdata, "PG_VERSION");
    if (!existsSync(made)) await initCluster(cfg);
    else if (Number(readFileSync(made, "utf8").trim()) !== cfg.pgMajor) fail(`The database was made with PostgreSQL ${readFileSync(made, "utf8").trim()}, but config.json points to PostgreSQL ${cfg.pgMajor} (${cfg.pgBin}). Remove "pgBin" from config.json and start again.`);
    // A server of ours that no longer answers (its database stopped, say) is replaced.
    await stopApi();
    await startPg(cfg);
    await ensureDatabase(cfg);
    await migrate(cfg);
    await startApi(cfg);
    console.log("");
    say(`Digital Bahi is running: ${appUrl(cfg)}`);
    say(`Data: ${HOME}`);
  }
  if (cfg.phone) showPhoneAddress(cfg);
  if (browser) openBrowser(appUrl(cfg));
}

async function stop() {
  if (!existsSync(FILES.config)) return say("Digital Bahi has not been set up on this computer yet.");
  const cfg = await loadConfig();
  const server = await stopApi();
  const database = await stopPg(cfg);
  say(server || database ? "Digital Bahi has stopped." : "Digital Bahi was not running.");
}

async function status() {
  if (!existsSync(FILES.config)) return say("Digital Bahi has not been set up on this computer yet.");
  const cfg = await loadConfig();
  const up = await healthy(cfg);
  say(`Server:    ${up ? `running, ${appUrl(cfg)}` : "stopped"}`);
  if (cfg.phone) say(`Phones:    ${phoneUrls(cfg).join(", ") || "phone mode is on, but this computer is not on a network"}`);
  say(`Database:  ${cfg.pgBin && (await pgRunning(cfg)) ? `running, port ${cfg.pgPort}` : "stopped"}${cfg.pgMajor ? ` (PostgreSQL ${cfg.pgMajor}, ${cfg.pgBin})` : ""}`);
  say(`Data:      ${HOME}`);
  say(`Backups:   ${cfg.backupFolder || path.join(HOME, "backups")}`);
  say(`Logs:      ${FILES.logs}`);
  return up;
}

const [command = "start", ...flags] = process.argv.slice(2);
const browser = !flags.includes("--no-browser") && process.env.DIGITALBAHI_NO_BROWSER !== "1";
const phone = flags.includes("--phone") ? true : flags.includes("--no-phone") ? false : undefined;
// --backup-folder "E:\Digital Bahi backups"; an empty value goes back to the data folder's own.
const folderAt = flags.indexOf("--backup-folder");
const folderArg = folderAt < 0 ? undefined : (flags[folderAt + 1] ?? "");
const backupFolder = folderArg === undefined || folderArg.startsWith("--") ? undefined : folderArg ? path.resolve(folderArg) : "";
console.log(`Digital Bahi (${command})`);
try {
  if (command === "start") await withLock(() => start({ browser, phone, backupFolder }));
  else if (command === "stop") await withLock(stop);
  else if (command === "restart") await withLock(async () => (await stop(), await start({ browser, phone, backupFolder })));
  else if (command === "status") process.exitCode = (await status()) ? 0 : 3;
  else {
    console.log("Commands: start [--no-browser] [--phone | --no-phone] [--backup-folder <folder>], stop, restart (as start), status");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`\n  ${e instanceof Stop ? e.message : e.stack ?? e}`);
  process.exitCode = 1;
}
