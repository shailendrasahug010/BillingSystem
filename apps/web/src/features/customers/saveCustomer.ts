import { customerById } from "../../data/db";
import { customerRow, upsertCustomer, type CustomerRow } from "../../data/live";
import type { Customer } from "../../data/types";
import { api, newIdempotencyKey } from "../../lib/api";
import { isWaitingCustomer, offlineScope, queueCustomerChange, queueEntry, unreachable, workingOffline } from "../../offline/sync";

/** The customer fields the quick form edits (the POST /customers body). */
export interface CustomerInput {
  name: string;
  businessName: string;
  customerType: "b2b" | "b2c";
  /** regular, consumer, sez or overseas (the server works it out from the GSTIN when left out). */
  gstRegistration?: string;
  mobile?: string;
  stateCode: string;
  gstin?: string;
  pincode?: string;
  city?: string;
  addressLine1?: string;
  creditLimit?: string | null;
  priceLevelId?: string;
  /** Messages in this language; null: the business's. */
  messageLocale?: "en" | "hi" | null;
  /** No automatic or bulk payment reminders (editing only). */
  remindersOptOut?: boolean;
}

/** The device could not keep the work (storage blocked, nobody signed in). */
export class NotKeptOffline extends Error {
  constructor() {
    super("not-kept-offline");
  }
}

type Detail = CustomerRow & { summary: { overdue: string } };
const shown = (res: Detail) => upsertCustomer({ ...res, overdue: res.summary.overdue });
const scopeOrFail = () => {
  const scope = offlineScope();
  if (!scope) throw new NotKeptOffline();
  return scope;
};

/** The customer as the device knows it, in the server's shape. */
function currentRow(id: string): CustomerRow {
  const row = customerRow(id);
  if (row) return row;
  const c = customerById.get(id)!;
  return {
    id,
    code: c.code,
    name: c.name,
    businessName: c.businessName,
    customerType: c.type,
    mobile: c.mobile || null,
    city: c.city || null,
    gstin: c.gstin,
    balance: String(c.balance ?? 0),
    overdue: String(c.overdue ?? 0),
    creditLimit: c.creditLimit === null ? null : String(c.creditLimit),
    creditDays: c.creditDays,
    routeId: null,
    stateCode: c.stateCode,
    addressLine1: c.address || null,
    pincode: c.pincode || null,
    priceLevelId: c.priceLevelId ?? null,
    categoryId: null,
    isActive: true,
    messageLocale: c.messageLocale ?? null,
    remindersOptOut: c.remindersOptOut ?? false,
    remindersOptOutAt: c.remindersOptOutAt ?? null,
    remindersOptOutBy: c.remindersOptOutBy ?? null,
    ...(c.version !== undefined ? { version: c.version } : {}),
  };
}

/**
 * Adds a customer. Online the server makes it (under an id made here, so a
 * retry cannot make two); without a connection it is kept on this device,
 * can be billed at once, and is sent before the bills made for it.
 */
export async function createCustomer(body: CustomerInput): Promise<{ customer: Customer; queued: boolean }> {
  const id = newIdempotencyKey();
  if (!workingOffline()) {
    try {
      return { customer: shown(await api.post<Detail>("/customers", body, { idempotencyKey: id })), queued: false };
    } catch (e) {
      if (!unreachable(e)) throw e;
    }
  }
  const scope = scopeOrFail();
  const row: CustomerRow = {
    id,
    code: "NEW",
    name: body.name,
    businessName: body.businessName || null,
    customerType: body.customerType,
    ...(body.gstRegistration ? { gstRegistration: body.gstRegistration } : {}),
    mobile: body.mobile?.replace(/\D/g, "").slice(-10) || null,
    city: body.city ?? null,
    gstin: body.gstin ?? null,
    balance: "0",
    overdue: "0",
    creditLimit: body.creditLimit ?? null,
    creditDays: 0,
    routeId: null,
    stateCode: body.stateCode,
    addressLine1: body.addressLine1 ?? null,
    pincode: body.pincode ?? null,
    priceLevelId: body.priceLevelId ?? null,
    categoryId: null,
    isActive: true,
    messageLocale: body.messageLocale ?? null,
  };
  const kept = await queueEntry({ kind: "customer", id, userId: scope.userId, businessId: scope.businessId, savedAt: new Date().toISOString(), status: "pending", error: null, customerId: id, customerName: body.businessName || body.name, body: { ...body }, row });
  if (!kept) throw new NotKeptOffline();
  return { customer: customerById.get(id)!, queued: true };
}

/**
 * Changes a customer's details. Online the change is checked against the
 * version this device saw (If-Match); without a connection it is kept and
 * sent later with that version, so it cannot quietly undo a change someone
 * made in between.
 */
export async function editCustomer(id: string, patch: Partial<CustomerInput>): Promise<{ customer: Customer; queued: boolean }> {
  const before = currentRow(id);
  if (!workingOffline() && !isWaitingCustomer(id)) {
    try {
      const res = await api.patch<Detail>(`/customers/${id}`, patch, before.version !== undefined ? { headers: { "if-match": String(before.version) } } : {});
      return { customer: shown(res), queued: false };
    } catch (e) {
      if (!unreachable(e)) throw e;
    }
  }
  const scope = scopeOrFail();
  const after: CustomerRow = {
    ...before,
    ...patch,
    businessName: patch.businessName ?? before.businessName,
    creditLimit: patch.creditLimit !== undefined ? patch.creditLimit : before.creditLimit,
    ...(patch.remindersOptOut !== undefined ? { remindersOptOutAt: patch.remindersOptOut ? new Date().toISOString() : null, remindersOptOutBy: patch.remindersOptOut ? ("staff" as const) : null } : {}),
  };
  const kept = await queueCustomerChange(id, patch, after, () => ({
    kind: "customer-edit",
    id: newIdempotencyKey(),
    userId: scope.userId,
    businessId: scope.businessId,
    savedAt: new Date().toISOString(),
    status: "pending",
    error: null,
    customerId: id,
    customerName: after.businessName ?? after.name,
    body: { ...patch },
    version: before.version ?? null,
    before,
    after,
  }));
  if (!kept) throw new NotKeptOffline();
  return { customer: customerById.get(id)!, queued: true };
}
