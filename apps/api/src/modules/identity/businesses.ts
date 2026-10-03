import type { BusinessInput, BusinessSummary } from "@digitalbahi/contracts";
import { panFromGstin, stateCodeFromGstin, validateGstin } from "@digitalbahi/core";
import { schema, seedBusinessDefaults, type Executor, type Tx } from "@digitalbahi/db";
import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { z } from "zod";
import { audit } from "../../lib/audit.js";
import type { AppDeps } from "../../lib/context.js";
import { badRequest } from "../../lib/errors.js";

export type BusinessInputT = z.output<typeof BusinessInput>;

const DEFAULT_TIME_ZONE = "Asia/Kolkata";

/** Field-level checks that need reference data (state codes) or GSTIN checksums. */
export async function validateBusinessInput(db: Executor, input: BusinessInputT, fieldPrefix = ""): Promise<void> {
  const [state] = await db.select({ code: schema.states.code }).from(schema.states).where(eq(schema.states.code, input.stateCode));
  if (!state) throw badRequest("INVALID_STATE_CODE", {}, `${fieldPrefix}stateCode`);
  if (input.gstin) {
    const issues = validateGstin(input.gstin);
    if (issues.length) throw badRequest("INVALID_GSTIN", { issue: issues[0]! }, `${fieldPrefix}gstin`);
    if (stateCodeFromGstin(input.gstin) !== input.stateCode) {
      throw badRequest("GSTIN_STATE_MISMATCH", { gstinState: stateCodeFromGstin(input.gstin) }, `${fieldPrefix}gstin`);
    }
  }
}

/**
 * Creates a tenant inside the caller's transaction: the business row, its
 * default roles / units / series / settings, and the creator as owner (Admin).
 * The transaction is switched to the new business so row-level security lets
 * the rows in.
 */
/** How many businesses one person may own (sign-up, new business, restore). */
export const MAX_OWNED_BUSINESSES = 10;

export async function createBusiness(
  tx: Tx,
  deps: AppDeps,
  actor: { userId: string; userName: string; ip: string; userAgent: string | null; requestId: string },
  input: BusinessInputT,
): Promise<BusinessSummary> {
  const businessId = uuidv7();
  await tx.execute(
    sql`select set_config('app.business_id', ${businessId}, true), set_config('app.user_id', ${actor.userId}, true)`,
  );
  const now = deps.clock.now();
  const trialEndsAt = new Date(now.getTime() + deps.config.trialDays * 86_400_000).toISOString();
  await tx.insert(schema.businesses).values({
    id: businessId,
    legalName: input.legalName,
    tradeName: input.tradeName ?? null,
    gstin: input.gstin ?? null,
    pan: input.gstin ? panFromGstin(input.gstin) : null,
    gstRegistration: input.gstRegistration,
    stateCode: input.stateCode,
    city: input.city ?? null,
    addressLine1: input.addressLine1 ?? null,
    pincode: input.pincode ?? null,
    timeZone: DEFAULT_TIME_ZONE,
    status: "trial",
    plan: "trial",
    trialEndsAt,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  await seedBusinessDefaults(tx, businessId, deps.clock.today(DEFAULT_TIME_ZONE));

  const [admin] = await tx
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(eq(schema.roles.businessId, businessId), eq(schema.roles.key, "admin")));
  await tx.insert(schema.businessMembers).values({
    id: uuidv7(),
    businessId,
    userId: actor.userId,
    roleId: admin!.id,
    isOwner: true,
  });
  await tx.update(schema.users).set({ lastBusinessId: businessId }).where(eq(schema.users.id, actor.userId));
  await audit(tx, { ...actor, businessId }, {
    action: "business.created",
    entityType: "business",
    entityId: businessId,
    entityLabel: input.legalName,
  });

  return {
    id: businessId,
    legalName: input.legalName,
    tradeName: input.tradeName ?? null,
    gstin: input.gstin ?? null,
    stateCode: input.stateCode,
    status: "trial",
    plan: "trial",
    trialEndsAt,
    role: "admin",
    isOwner: true,
  };
}
