import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { can, guard } from "../../lib/access.js";
import { acceptFiles } from "../../lib/binary.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { closeOcr, readPageImage } from "../../services/ocr.js";
import type { ApiModule } from "../types.js";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Reading a photographed or scanned page for the import screens (a
 * supplier's bill, a product or customer list). The page is read and
 * forgotten: nothing is stored, and only people who may import through one
 * of those screens can use it.
 */
export const ocrModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  acceptFiles(app);
  app.addHook("onClose", async () => closeOcr());

  r.post(
    "/imports/read-page",
    {
      preHandler: [
        ...guard(deps),
        async (request) => {
          const ctx = request.ctx;
          if (!(can(ctx, "purchase.create") || can(ctx, "product.import") || can(ctx, "customer.create"))) throw forbidden("purchase.create");
        },
      ],
      bodyLimit: MAX_IMAGE_BYTES,
      config: { rateLimit: { max: 40, timeWindow: "1 minute" } },
      schema: { tags: ["imports"] },
    },
    async (request, reply) => {
      const file = request.body;
      if (!Buffer.isBuffer(file) || file.length === 0) throw badRequest("OCR_IMAGE_UNSUPPORTED");
      reply.header("cache-control", "no-store");
      return readPageImage(file);
    },
  );
};
