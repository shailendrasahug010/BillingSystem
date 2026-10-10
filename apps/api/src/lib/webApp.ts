import { createReadStream, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { WEB_APP_CSP } from "@digitalbahi/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Serves the built web app (apps/web/dist) from the API itself, for one
 * computer running Digital Bahi without Caddy (the Windows installer and the
 * macOS / Linux launcher, see installer/). Same rules as deploy/Caddyfile:
 * hashed files under /assets are kept for a year; index.html, the service
 * worker and the manifest are checked on every start; any other path is one
 * of the app's own screens and gets index.html. Paths under /api never reach
 * here (a wrong one stays a JSON 404), and source maps are never served. The
 * pages carry the same Content-Security-Policy as behind Caddy (WEB_APP_CSP).
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

/** Checked by the browser on every start, so a new version is seen at once. */
const ALWAYS_CHECK = new Set(["/index.html", "/sw.js", "/manifest.webmanifest"]);

/** The folder's index.html must be there: a wrong WEB_DIR stops the API at start, not at the first visit. */
export function assertWebApp(root: string): void {
  if (!statSync(path.join(root, "index.html"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`WEB_DIR has no index.html: ${root}`);
  }
}

export function registerWebApp(app: FastifyInstance, root: string): void {
  const base = path.resolve(root);
  const index = path.join(base, "index.html");

  async function send(request: FastifyRequest, reply: FastifyReply, file: string, sitePath: string) {
    const info = await stat(file);
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const isIndex = file === index;
    if (sitePath.startsWith("/assets/")) reply.header("cache-control", "public, max-age=31536000, immutable");
    else if (isIndex || ALWAYS_CHECK.has(sitePath)) reply.header("cache-control", "no-cache");
    reply.header("etag", etag).header("last-modified", info.mtime.toUTCString()).header("content-security-policy", WEB_APP_CSP);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply
      .type(TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream")
      .header("content-length", info.size)
      .send(createReadStream(file));
  }

  const notFound = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(404).send({ error: { code: "ROUTE_NOT_FOUND", requestId: request.id } });

  app.get("/*", { config: { rateLimit: false }, schema: { hide: true } }, async (request, reply) => {
    let sitePath: string;
    try {
      sitePath = decodeURIComponent(request.url.split("?")[0]!);
    } catch {
      return notFound(request, reply);
    }
    if (sitePath === "/api" || sitePath.startsWith("/api/")) return notFound(request, reply);
    if (sitePath.includes("\0") || sitePath.endsWith(".map")) return notFound(request, reply);

    // Inside the folder only: "..", backslashes and drive letters cannot leave it.
    const file = path.resolve(base, `.${path.posix.normalize(sitePath.replaceAll("\\", "/"))}`);
    if (file !== base && !file.startsWith(base + path.sep)) return notFound(request, reply);
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) return send(request, reply, file, sitePath);
    // A missing hashed file is an error, not a screen (its HTML would fail as a script).
    if (sitePath.startsWith("/assets/")) return notFound(request, reply);
    return send(request, reply, index, sitePath);
  });
}
