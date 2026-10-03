import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertWebApp, registerWebApp } from "../src/lib/webApp.js";

/**
 * The API serving the built web app on one computer (installer/): the same
 * rules as deploy/Caddyfile, without ever leaving the folder or answering an
 * /api path with the app.
 */
describe("web app served by the API", () => {
  let root: string;
  let app: FastifyInstance;
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

  beforeAll(async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "digitalbahi-web-"));
    root = path.join(parent, "dist");
    await mkdir(path.join(root, "assets"), { recursive: true });
    await mkdir(path.join(root, "icons"));
    await writeFile(path.join(root, "index.html"), "<!doctype html><title>Digital Bahi</title>");
    await writeFile(path.join(root, "sw.js"), "const VERSION = 1;");
    await writeFile(path.join(root, "manifest.webmanifest"), "{}");
    await writeFile(path.join(root, "assets", "index-Ab12.js"), "console.log(1)");
    await writeFile(path.join(root, "assets", "index-Ab12.js.map"), "{}");
    await writeFile(path.join(root, "icons", "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // Next to the folder: must never be served.
    await writeFile(path.join(parent, "secret.txt"), "keys");
    app = Fastify();
    app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: "ROUTE_NOT_FOUND", requestId: request.id } }));
    app.get("/api/v1/health", async () => ({ status: "ok" }));
    registerWebApp(app, root);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  it("serves the app at / and at each screen's address, always checked for a new version", async () => {
    for (const url of ["/", "/customers", "/invoices/0192/view?tab=lines"]) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain("<title>Digital Bahi</title>");
    }
  });

  it("keeps hashed files a year, and the service worker and manifest never", async () => {
    const asset = await get("/assets/index-Ab12.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.body).toBe("console.log(1)");
    expect((await get("/sw.js")).headers["cache-control"]).toBe("no-cache");
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.headers["content-type"]).toBe("application/manifest+json; charset=utf-8");
    expect(manifest.headers["cache-control"]).toBe("no-cache");
    const icon = await get("/icons/icon-192.png");
    expect(icon.headers["content-type"]).toBe("image/png");
    expect(icon.headers["cache-control"]).toBeUndefined();
  });

  it("answers a repeat visit with 304 when the file is unchanged", async () => {
    const first = await get("/sw.js");
    const again = await get("/sw.js", { "if-none-match": String(first.headers.etag) });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
  });

  it("gives a 404 for a missing hashed file and for source maps, not the app", async () => {
    expect((await get("/assets/index-Gone.js")).statusCode).toBe(404);
    expect((await get("/assets/index-Ab12.js.map")).statusCode).toBe(404);
  });

  it("leaves /api to the API: a wrong path there is a JSON 404", async () => {
    expect((await get("/api/v1/health")).json()).toEqual({ status: "ok" });
    const wrong = await get("/api/v1/no-such-thing");
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json().error.code).toBe("ROUTE_NOT_FOUND");
    expect((await get("/api")).statusCode).toBe(404);
    // Other methods still reach the API's own 404.
    expect((await app.inject({ method: "POST", url: "/customers" })).statusCode).toBe(404);
  });

  it("never serves a file outside the folder", async () => {
    for (const url of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt", "/%00", "/%E0%A4%A"]) {
      const res = await get(url);
      expect(res.body, url).not.toContain("keys");
    }
  });

  it("stops the API at start when the folder has no app", async () => {
    expect(() => assertWebApp(root)).not.toThrow();
    expect(() => assertWebApp(path.join(root, "icons"))).toThrow(/WEB_DIR has no index.html/);
  });
});
