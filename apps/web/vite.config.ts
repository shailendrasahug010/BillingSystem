import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const here = import.meta.dirname;

/** Files in public/ (served as they are), as site paths. */
function publicFiles(dir = join(here, "public")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? publicFiles(join(dir, e.name)) : [`/${relative(join(here, "public"), join(dir, e.name)).replaceAll("\\", "/")}`],
  );
}

/**
 * Emits sw.js: service-worker.js with the build's file list in front, so the
 * installed app (desktop or phone) opens without a network and each build
 * replaces the previous one's files in one step.
 */
function serviceWorker(): Plugin {
  return {
    name: "digitalbahi-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle)
        .filter((f) => f !== "index.html" && !f.endsWith(".map"))
        // The PDF reader (about 1.8 MB) loads only when a PDF is imported, and the barcode
        // reader (about 1.1 MB) only when a phone without its own scanner first scans:
        // installs and updates skip them, and the service worker keeps each once used.
        .filter((f) => !/^assets\/(pdf[.-]|zxing_reader)/.test(f))
        .map((f) => `/${f}`);
      const precache = ["/", ...built, ...publicFiles()].sort();
      const version = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 12);
      const source = `const VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(precache)};\n${readFileSync(join(here, "service-worker.js"), "utf8")}`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/** The build noted with each error sent to the error log: APP_BUILD, else the git commit, else the date. */
function buildId(): string {
  if (process.env.APP_BUILD) return process.env.APP_BUILD.slice(0, 40);
  try {
    return execSync("git rev-parse --short=12 HEAD", { cwd: here, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return new Date().toISOString().slice(0, 16);
  }
}

// `vite build --mode singlefile` inlines everything into one HTML file: used to
// publish a shareable, static preview of the prototype.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === "singlefile" ? [viteSingleFile()] : [serviceWorker()])],
  define: { __APP_BUILD__: JSON.stringify(buildId()) },
  // The browser build of the translations: Hindi is fetched when it is chosen, not with every visit.
  resolve: { alias: [{ find: /^@digitalbahi\/i18n$/, replacement: join(here, "../../packages/i18n/src/web.ts") }] },
  build: {
    outDir: mode === "singlefile" ? "dist-singlefile" : "dist",
    // Source maps for the error log (errors from the browser shown at their source line). "hidden":
    // the scripts do not point to them; the Docker build moves them to the API, off the public site.
    sourcemap: mode === "singlefile" ? false : "hidden",
    target: "es2022",
    // The prototype ships as one bundle; production code-splits each module route (React.lazy).
    chunkSizeWarningLimit: 800,
  },
  // The Excel and PDF readers load only when a file is picked (the barcode reader when the camera
  // opens); prepare them at start so the
  // dev server does not reload the page the first time one is used.
  optimizeDeps: { include: ["read-excel-file/browser", "pdfjs-dist/legacy/build/pdf.mjs", "barcode-detector/ponyfill"] },
  // Same-origin /api in development too, so the refresh-token cookie behaves as in production.
  server: { port: 5173, proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:3000", changeOrigin: false } } },
}));
