import { DomainError, ValidationError } from "@digitalbahi/core";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { RequestCtx } from "./context.js";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

type Params = Record<string, string | number>;

/**
 * The innermost error's message: the database's own words ("permission denied
 * for table …"), not the wrapper's, which repeats the query with its values.
 */
export function rootMessage(error: unknown): string {
  let e = error;
  while (e instanceof Error && e.cause instanceof Error) e = e.cause;
  return (e instanceof Error ? e.message : String(e)).slice(0, 1000);
}

/**
 * Every failure leaves the API as { error: { code, params, field?, details?, requestId } }.
 * Codes are stable and translated by the clients (see errors.* in @digitalbahi/i18n);
 * the API never relies on English sentences.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Params = {},
    readonly field?: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export const notFound = (entity: string) => new ApiError(404, "NOT_FOUND", { entity });
export const forbidden = (permission?: string) => new ApiError(403, "FORBIDDEN", permission ? { permission } : {});
export const unauthorized = (code = "UNAUTHORIZED") => new ApiError(401, code);
export const conflict = (code: string, params: Params = {}, field?: string) => new ApiError(409, code, params, field);
export const badRequest = (code: string, params: Params = {}, field?: string) => new ApiError(400, code, params, field);

/** Domain error codes that are business-rule conflicts rather than bad input. */
const DOMAIN_STATUS: Record<string, number> = {
  INSUFFICIENT_STOCK: 409,
  INVALID_STATUS_TRANSITION: 409,
  TAX_RULE_NOT_FOUND: 422,
  ALLOCATION_EXCEEDS_BALANCE: 409,
  ALLOCATION_UNKNOWN_DOCUMENT: 409,
  ALLOCATION_EXCEEDS_PAYMENT: 400,
};

/** Unique / check constraints translated to codes the clients understand. */
const CONSTRAINT_CODES: Record<string, { status: number; code: string; field?: string }> = {
  users_mobile_uq: { status: 409, code: "ACCOUNT_EXISTS", field: "mobile" },
  users_email_uq: { status: 409, code: "EMAIL_IN_USE", field: "email" },
  customers_code_uq: { status: 409, code: "DUPLICATE_CODE", field: "code" },
  suppliers_code_uq: { status: 409, code: "DUPLICATE_CODE", field: "code" },
  products_code_uq: { status: 409, code: "DUPLICATE_CODE", field: "code" },
  products_sku_uq: { status: 409, code: "DUPLICATE_SKU", field: "sku" },
  product_barcodes_uq: { status: 409, code: "DUPLICATE_BARCODE", field: "barcodes" },
  purchases_supplier_bill_uq: { status: 409, code: "DUPLICATE_SUPPLIER_BILL", field: "supplierInvoiceNumber" },
  invoices_number_uq: { status: 409, code: "DUPLICATE_NUMBER" },
  invoices_client_id_uq: { status: 409, code: "DUPLICATE_REQUEST" },
  purchases_client_id_uq: { status: 409, code: "DUPLICATE_REQUEST" },
  payments_client_id_uq: { status: 409, code: "DUPLICATE_REQUEST" },
  units_symbol_uq: { status: 409, code: "DUPLICATE_NAME", field: "symbol" },
  payment_accounts_name_uq: { status: 409, code: "DUPLICATE_NAME", field: "name" },
  schemes_name_uq: { status: 409, code: "DUPLICATE_NAME", field: "name" },
  brands_name_uq: { status: 409, code: "DUPLICATE_NAME", field: "name" },
  report_views_name_uq: { status: 409, code: "DUPLICATE_NAME", field: "name" },
  product_categories_name_uq: { status: 409, code: "DUPLICATE_NAME", field: "name" },
  tax_categories_name_uq: { status: 409, code: "DUPLICATE_NAME", field: "name" },
  price_levels_name_uq: { status: 409, code: "DUPLICATE_NAME", field: "name" },
  roles_key_uq: { status: 409, code: "DUPLICATE_NAME", field: "key" },
  warehouses_code_uq: { status: 409, code: "DUPLICATE_CODE", field: "code" },
  expense_categories_name_uq: { status: 409, code: "DUPLICATE_NAME", field: "name" },
  expenses_client_id_uq: { status: 409, code: "DUPLICATE_REQUEST" },
  business_members_uq: { status: 409, code: "ALREADY_MEMBER" },
  customers_b2b_gstin_chk: { status: 400, code: "GSTIN_REQUIRED_FOR_B2B", field: "gstin" },
};

interface PgLikeError {
  code?: string;
  constraint?: string;
  message: string;
  cause?: PgLikeError;
}

function pgError(err: unknown): PgLikeError | null {
  let e = err as PgLikeError | undefined;
  for (let depth = 0; e && depth < 4; depth++) {
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    e = e.cause;
  }
  return null;
}

function toApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof ValidationError) return new ApiError(DOMAIN_STATUS[err.code] ?? 400, err.code, err.params);
  if (err instanceof DomainError) return new ApiError(DOMAIN_STATUS[err.code] ?? 409, err.code, err.params);
  const pg = pgError(err);
  if (!pg) return null;
  const mapped = pg.constraint ? CONSTRAINT_CODES[pg.constraint] : undefined;
  if (mapped) return new ApiError(mapped.status, mapped.code, {}, mapped.field);
  switch (pg.code) {
    case "23505":
      return new ApiError(409, "DUPLICATE", pg.constraint ? { constraint: pg.constraint } : {});
    case "23503":
      return new ApiError(400, "REFERENCE_NOT_FOUND", pg.constraint ? { constraint: pg.constraint } : {});
    case "23514":
      return new ApiError(400, "CONSTRAINT_VIOLATION", pg.constraint ? { constraint: pg.constraint } : {});
    case "23000":
      if (pg.message.includes("GST period")) return new ApiError(409, "GST_PERIOD_LOCKED");
      if (pg.message.includes("cancel it instead")) return new ApiError(409, "POSTED_DOCUMENT_IMMUTABLE");
      return new ApiError(409, "IMMUTABLE_RECORD");
    case "42501":
      // Row-level security: another tenant's row. Never reveal that it exists.
      return new ApiError(404, "NOT_FOUND");
    case "40001":
    case "40P01":
      return new ApiError(409, "CONCURRENT_UPDATE");
    default:
      return null;
  }
}

function fieldFromPath(path: string): string {
  return path
    .replace(/^\//, "")
    .split("/")
    .map((p, i) => (/^\d+$/.test(p) ? `[${p}]` : i === 0 ? p : `.${p}`))
    .join("");
}

/** Codes that say the server is busy rather than that something is wrong: not written to the error log. */
const EXPECTED = new Set(["OCR_BUSY"]);

/** A failure of the API written to the error log, with the request and who made it. */
function logFailure(err: unknown, request: FastifyRequest, status: number, code: string) {
  const errors = request.server.deps?.errors;
  if (!errors || EXPECTED.has(code)) return;
  const ctx = request.ctx as RequestCtx | null;
  const user = ctx ? { id: ctx.userId, name: ctx.userName, businessId: ctx.businessId } : request.user ? { id: request.user.userId, name: null, businessId: request.user.businessId } : undefined;
  errors.record(err, { reference: request.id, source: "api", request: { method: request.method, url: request.url, status, code }, ...(user ? { user } : {}) });
}

export function errorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const requestId = request.id;
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.code(400).send({
      error: {
        code: "VALIDATION_FAILED",
        requestId,
        details: err.validation.map((v) => ({
          field: fieldFromPath(v.instancePath ?? ""),
          code: String(v.keyword ?? "invalid"),
          params: { message: v.message ?? "" },
        })),
      },
    });
  }
  const api = toApiError(err);
  if (api) {
    if (api.status >= 500) {
      request.log.error({ err }, "request failed");
      logFailure(err, request, api.status, api.code);
    }
    return reply.code(api.status).send({
      error: { code: api.code, params: api.params, ...(api.field ? { field: api.field } : {}), requestId },
    });
  }
  if (err.statusCode === 429) return reply.code(429).send({ error: { code: "RATE_LIMITED", requestId } });
  if (err.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: { code: err.code ?? "BAD_REQUEST", requestId } });
  }
  request.log.error({ err }, "unhandled error");
  logFailure(err, request, 500, "INTERNAL");
  return reply.code(500).send({ error: { code: "INTERNAL", requestId } });
}
