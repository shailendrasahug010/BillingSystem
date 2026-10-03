#!/usr/bin/env node
/**
 * Runs the Android project's Gradle wrapper with the given tasks:
 * gradlew.bat on Windows (pnpm runs scripts in cmd.exe there, which cannot
 * start ./gradlew), ./gradlew elsewhere.
 *
 *   node scripts/gradle.mjs assembleDebug
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const android = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "android");
const windows = process.platform === "win32";
const run = spawnSync(windows ? "gradlew.bat" : "./gradlew", process.argv.slice(2), { cwd: android, stdio: "inherit", shell: windows });
if (run.error) console.error(`Could not start Gradle: ${run.error.message}`);
process.exit(run.status ?? 1);
