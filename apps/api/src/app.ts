import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import type { AppDeps } from "./lib/context.js";
import { errorHandler } from "./lib/errors.js";
import { MODULES } from "./modules/index.js";

/**
 * Builds the API. Every business module registers its routes under /api/v1;
 * modules only talk to each other through exported service functions that
 * take the caller's transaction.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger:
      config.env === "test"
        ? false
        : {
            level: config.logLevel,
            redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
            ...(config.env === "development" ? { transport: { target: "pino-pretty" } } : {}),
          },
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : uuidv7();
    },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  app.decorate("deps", deps);
  app.decorateRequest("user", null);
  app.decorateRequest("ctx", null as never);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: "ROUTE_NOT_FOUND", requestId: request.id } }),
  );
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.corsOrigins.length ? config.corsOrigins : false, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.headers.authorization?.slice(-24) ?? req.ip,
  });

  if (config.docsEnabled) {
    await app.register(swagger, {
      openapi: {
        info: { title: "Vyapaar CRM API", version: "1.0.0", description: "Billing, stock, GST and collections for distributors" },
        components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
        security: [{ bearer: [] }],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: "/api/docs" });
  }

  await app.register(
    async (api) => {
      for (const register of MODULES) await register(api, deps);
    },
    { prefix: "/api/v1" },
  );

  return app;
}
