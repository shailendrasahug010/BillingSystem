import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/context.js";

export type ApiModule = (app: FastifyInstance, deps: AppDeps) => Promise<void>;
