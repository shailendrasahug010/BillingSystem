import { schema, type Tx } from "@vyapaar/db";
import type { RequestCtx } from "./context.js";

type Change = [unknown, unknown];

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  changes?: Record<string, Change | unknown> | null;
}

/** Who did it: a request's context, or a scheduled job (no address or request). */
export type AuditActor = Pick<RequestCtx, "businessId" | "userId" | "userName" | "userAgent"> & { ip: string | null; requestId: string | null };

/** Written inside the same transaction as the change it records (append-only table). */
export async function audit(tx: Tx, ctx: AuditActor, entry: AuditEntry): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    businessId: ctx.businessId,
    userId: ctx.userId,
    userName: ctx.userName,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    entityLabel: entry.entityLabel ?? null,
    changes: entry.changes ?? null,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
}

/** { field: [old, new] } for the fields that actually changed. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): Record<string, Change> {
  const out: Record<string, Change> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (b === undefined) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = [a ?? null, b ?? null];
  }
  return out;
}
