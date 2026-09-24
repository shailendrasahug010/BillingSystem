import { healthModule } from "./health.js";
import type { ApiModule } from "./types.js";

/** Registered in order under /api/v1. Adding a module = one import and one entry. */
export const MODULES: ApiModule[] = [healthModule];
