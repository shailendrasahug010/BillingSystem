import type { FastifyInstance } from "fastify";

/**
 * Lets routes take a file as it is (application/octet-stream: a backup, a
 * photographed bill), as a Buffer. Each such route sets its own bodyLimit;
 * elsewhere the server's default limit applies. Safe to call from several
 * modules sharing one scope.
 */
export function acceptFiles(app: FastifyInstance): void {
  if (app.hasContentTypeParser("application/octet-stream")) return;
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
}
