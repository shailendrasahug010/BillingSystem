import { useSyncExternalStore } from "react";
import { customerById, supplierById } from "../data/db";
import { adjustStock, customerRow, dropCustomer, showCustomerDetails, upsertCustomer, type CustomerRow } from "../data/live";
import { touch } from "../data/store";
import { api, ApiError } from "../lib/api";
import { loadDevice, type DeviceRecord } from "./device";
import { idbAll, idbDelete, idbGet, idbPut } from "./idb";
import { isSealed, seal, unseal, type Sealed } from "./vault";
import { kindOf, type OutboxEntry, type PaymentEntry, type OrderEntry, type CustomerEntry, type CustomerEditEntry, type CollectionNoteEntry, type PurchaseEntry, type ExpenseEntry, type ReturnEntry, type PriceNoteEntry, type CancelEntry, type VisitEntry, type QueuedEntry, type QueuedKind, type SyncedEntry } from "./outbox";

export { kindOf };
export type { OutboxEntry, PaymentEntry, OrderEntry, CustomerEntry, CustomerEditEntry, CollectionNoteEntry, PurchaseEntry, ExpenseEntry, ReturnEntry, PriceNoteEntry, CancelEntry, VisitEntry, QueuedEntry, QueuedKind, SyncedEntry };

/**
 * Work done without a connection waits here (on the device, in IndexedDB)
 * until the server takes it: bills, payments, orders, new customers, changes
 * to customers, collectors' visit notes, salespeople's calls (no order and
 * why), purchase bills, expenses, returns, discount notes and cancelled bills. Each is sent with its own
 * Idempotency-Key, so a send cut off half-way is simply sent again; the
 * server keeps the number the device gave a bill, and a new customer keeps
 * the id it was billed under. Up to 25 go in one request (POST /sync/push),
 * so a weak connection needs few round trips. The kinds of work are in outbox.ts.
 */
export interface OfflineState {
  /** The browser has a network connection. */
  online: boolean;
  /** Running from the copy saved on this device (the server could not be reached at start). */
  offlineMode: boolean;
  entries: QueuedEntry[];
  synced: SyncedEntry[];
  syncing: boolean;
  lastSyncAt: string | null;
  device: DeviceRecord | null;
}

let scope: { userId: string; businessId: string } | null = null;
let state: OfflineState = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  offlineMode: false,
  entries: [],
  synced: [],
  syncing: false,
  lastSyncAt: null,
  device: null,
};
const listeners = new Set<() => void>();
const syncedListeners = new Set<(count: number) => void>();

function set(patch: Partial<OfflineState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  if ("entries" in patch || "online" in patch || "offlineMode" in patch) scheduleReport();
}

let reportTimer: ReturnType<typeof setTimeout> | undefined;
let lastReport = "";

/**
 * Tells the server what waits on this device (counts and the oldest time, no
 * content), so the owner sees it under Settings → Devices and is reminded
 * when a device keeps work too long. Only while online; a report that would
 * say the same as the last one is not sent.
 */
function scheduleReport(): void {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => void reportQueue(), 2_000);
}

async function reportQueue(): Promise<void> {
  if (!scope || workingOffline()) return;
  const { userId, businessId } = scope;
  const device = await loadDevice(userId, businessId);
  if (!device?.id) return;
  const pending = state.entries.filter((e) => e.status === "pending");
  const oldest = state.entries.map((e) => e.savedAt).sort()[0] ?? null;
  const body = { waiting: pending.length, bills: pending.filter((e) => kindOf(e) === "invoice").length, refused: state.entries.length - pending.length, oldestAt: oldest };
  const signature = `${device.id}:${JSON.stringify(body)}`;
  if (signature === lastReport) return;
  try {
    await api.put(`/devices/${device.id}/queue`, body);
    lastReport = signature;
  } catch {
    // Not reachable just now: the next change or sync reports again.
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getOfflineState = () => state;

export function useOffline(): OfflineState {
  return useSyncExternalStore(subscribe, getOfflineState, getOfflineState);
}

/** No connection, or started from the copy on the device: work is kept here to send later. */
export const workingOffline = () => state.offlineMode || !state.online || (typeof navigator !== "undefined" && !navigator.onLine);

/** The request never reached the server (as opposed to the server saying no). */
export const unreachable = (e: unknown) => e instanceof ApiError && e.code === "network";

/** Who and where new work is saved for (null: nobody signed in, or no storage). */
export const offlineScope = () => scope;

/** Called after work was synced (the session reloads the workspace then). */
export function onSynced(listener: (count: number) => void): () => void {
  syncedListeners.add(listener);
  return () => syncedListeners.delete(listener);
}

const syncedKey = () => `synced:${scope!.userId}:${scope!.businessId}`;
const byOrder = (a: QueuedEntry, b: QueuedEntry) => a.savedAt.localeCompare(b.savedAt) || a.id.localeCompare(b.id);

/** How an entry is stored: who and when in the clear (to find and order them), the rest encrypted. */
interface StoredEntry {
  id: string;
  userId: string;
  businessId: string;
  savedAt: string;
  sealed: Sealed;
}
const entryLabel = (id: string) => `outbox:${id}`;

/** Keeps an entry on the device, encrypted; false when it cannot (storage blocked, copy locked). */
async function putEntry(e: QueuedEntry): Promise<boolean> {
  const sealed = await seal(e, entryLabel(e.id));
  if (!sealed) return false;
  return idbPut("outbox", { id: e.id, userId: e.userId, businessId: e.businessId, savedAt: e.savedAt, sealed } satisfies StoredEntry);
}

async function readEntries(userId: string, businessId: string): Promise<QueuedEntry[]> {
  const out: QueuedEntry[] = [];
  for (const row of await idbAll<StoredEntry | QueuedEntry>("outbox")) {
    if (row.userId !== userId || row.businessId !== businessId) continue;
    if ("sealed" in row && isSealed(row.sealed)) {
      const e = await unseal<QueuedEntry>(row.sealed, entryLabel(row.id));
      if (e) out.push(e);
      continue;
    }
    // Kept before the device copy was encrypted: encrypted now (left as it is if the copy is locked).
    const plain = row as QueuedEntry;
    await putEntry(plain);
    out.push(plain);
  }
  return out.sort(byOrder);
}

async function readSynced(): Promise<SyncedEntry[]> {
  const stored = await idbGet<unknown>("kv", syncedKey());
  if (isSealed(stored)) return (await unseal<SyncedEntry[]>(stored, syncedKey())) ?? [];
  return Array.isArray(stored) ? (stored as SyncedEntry[]) : [];
}

async function saveSynced(history: SyncedEntry[]): Promise<void> {
  const sealed = await seal(history, syncedKey());
  if (sealed) await idbPut("kv", sealed, syncedKey());
}

async function reload(): Promise<void> {
  if (!scope) return;
  const { userId, businessId } = scope;
  const [entries, synced, device] = await Promise.all([readEntries(userId, businessId), readSynced(), loadDevice(userId, businessId)]);
  if (scope?.userId !== userId || scope.businessId !== businessId) return;
  set({ entries, synced, device: device?.seriesCode ? device : null });
}

/** Points the queue at the signed-in user and business (work of others stays on the device, untouched). */
export async function setOfflineScope(userId: string, businessId: string): Promise<void> {
  scope = { userId, businessId };
  await reload();
}

export function clearOfflineScope(): void {
  scope = null;
  set({ entries: [], synced: [], device: null, offlineMode: false });
}

export function setOfflineMode(value: boolean): void {
  if (state.offlineMode !== value) set({ offlineMode: value });
}

export const refreshDevice = () => reload();

/** The customer an entry belongs to (null for a supplier payment, a purchase or an expense). */
function customerOf(e: QueuedEntry): string | null {
  const kind = kindOf(e);
  if (kind === "payment") return (e as PaymentEntry).direction === "in" ? (e as PaymentEntry).partyId : null;
  if (kind === "purchase" || kind === "expense") return null;
  if (kind === "return" || kind === "price-note") return (e as ReturnEntry | PriceNoteEntry).side === "sale" ? (e as ReturnEntry | PriceNoteEntry).partyId : null;
  return (e as OutboxEntry | OrderEntry | CustomerEntry | CustomerEditEntry | CollectionNoteEntry | CancelEntry | VisitEntry).customerId;
}

/**
 * Puts what is still waiting over freshly loaded data: new customers first
 * (bills may be for them), then changed details, then stock and balances.
 */
export function applyPendingEffects(): void {
  const rank = (e: QueuedEntry) => ({ customer: 0, "customer-edit": 1 })[kindOf(e) as "customer"] ?? 2;
  for (const e of [...state.entries].sort((a, b) => rank(a) - rank(b) || byOrder(a, b))) applyEffects(e, 1);
  touch();
}

function applyEffects(e: QueuedEntry, sign: 1 | -1): void {
  switch (kindOf(e)) {
    case "invoice": {
      const bill = e as OutboxEntry;
      for (const s of bill.stock) adjustStock(s.productId, -sign * s.qty);
      const c = customerById.get(bill.customerId);
      if (c) c.balance = (c.balance ?? 0) + sign * (bill.total - bill.paid);
      return;
    }
    case "payment": {
      const p = e as PaymentEntry;
      const party = p.direction === "in" ? customerById.get(p.partyId) : supplierById.get(p.partyId);
      if (party) party.balance = (party.balance ?? 0) - sign * p.amount;
      return;
    }
    case "customer": {
      const c = e as CustomerEntry;
      if (sign === -1) dropCustomer(c.customerId);
      // Changed again before it was sent: new details, the balance the device has.
      else if (customerById.has(c.customerId)) showCustomerDetails(c.row);
      else upsertCustomer(c.row);
      return;
    }
    case "customer-edit": {
      const c = e as CustomerEditEntry;
      showCustomerDetails(sign === 1 ? { ...c.after, balance: customerRow(c.customerId)?.balance ?? c.after.balance } : { ...c.before, balance: customerRow(c.customerId)?.balance ?? c.before.balance });
      return;
    }
    case "purchase": {
      const p = e as PurchaseEntry;
      for (const x of p.stock) adjustStock(x.productId, sign * x.qty);
      const s = supplierById.get(p.supplierId);
      if (s) s.balance = (s.balance ?? 0) + sign * (p.total - p.paid);
      return;
    }
    case "return": {
      const r = e as ReturnEntry;
      for (const x of r.stock) adjustStock(x.productId, sign * x.qty);
      const party = r.side === "sale" ? customerById.get(r.partyId) : supplierById.get(r.partyId);
      if (party) party.balance = (party.balance ?? 0) - sign * r.estimate;
      return;
    }
    case "price-note": {
      const n = e as PriceNoteEntry;
      const party = n.side === "sale" ? customerById.get(n.partyId) : supplierById.get(n.partyId);
      if (party) party.balance = (party.balance ?? 0) - sign * n.estimate;
      return;
    }
    case "invoice-cancel": {
      const c = e as CancelEntry;
      for (const x of c.stock) adjustStock(x.productId, sign * x.qty);
      const customer = customerById.get(c.customerId);
      if (customer) customer.balance = (customer.balance ?? 0) - sign * c.amount;
      return;
    }
    case "order":
    case "collection-note":
    case "expense":
    case "visit":
      return;
  }
}

/** Keeps work done offline; its effect on stock, balances and customers shows on this device at once. */
export async function queueEntry(entry: QueuedEntry): Promise<boolean> {
  if (!(await putEntry(entry))) return false;
  applyEffects(entry, 1);
  touch();
  set({ entries: [...state.entries.filter((x) => x.id !== entry.id), entry].sort(byOrder) });
  // Kept while online (behind a customer not sent yet): send it all now.
  if (!workingOffline()) void syncNow();
  return true;
}

/** A bill made offline (kept for the bill form's existing call). */
export const queueBill = (entry: OutboxEntry) => queueEntry(entry);

/**
 * A change to a customer while offline. Joins a change still waiting for the
 * same customer (or the new customer itself), so the server sees one change
 * made on the version the device knew.
 */
export async function queueCustomerChange(customerId: string, patch: Record<string, unknown>, after: CustomerRow, make: () => CustomerEditEntry): Promise<boolean> {
  const pending = state.entries.find((e) => e.status === "pending" && (kindOf(e) === "customer" || kindOf(e) === "customer-edit") && customerOf(e) === customerId) as CustomerEntry | CustomerEditEntry | undefined;
  if (pending && kindOf(pending) === "customer") {
    const created = pending as CustomerEntry;
    return queueEntry({ ...created, customerName: after.businessName ?? after.name, body: { ...created.body, ...patch }, row: { ...after, balance: created.row.balance } });
  }
  if (pending) {
    const edit = pending as CustomerEditEntry;
    return queueEntry({ ...edit, customerName: after.businessName ?? after.name, body: { ...edit.body, ...patch }, after, madeAt: new Date().toISOString() });
  }
  return queueEntry(make());
}

/** A customer added on this device that the server does not have yet. */
export const isWaitingCustomer = (customerId: string) => state.entries.some((e) => kindOf(e) === "customer" && (e as CustomerEntry).customerId === customerId);

/** Drops something the server refused; its effects on this device are undone (a bill's number stays unused). */
export async function removeEntry(id: string): Promise<void> {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  await idbDelete("outbox", id);
  applyEffects(e, -1);
  touch();
  set({ entries: state.entries.filter((x) => x.id !== id) });
}

export const removeBill = removeEntry;

/** Sends it again; a customer change that clashed with a later one is now saved over it. */
export async function retryEntry(id: string): Promise<void> {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  const overwrite = kindOf(e) === "customer-edit" && e.error?.code === "VERSION_CONFLICT";
  const next = { ...e, status: "pending", error: null, ...(overwrite ? { version: null } : {}) } as QueuedEntry;
  await putEntry(next);
  set({ entries: state.entries.map((x) => (x.id === id ? next : x)) });
  await syncNow();
}

export const retryBill = retryEntry;

/**
 * The record an entry acts on, as the server knows it: a bill made on this
 * device and sent since is found under the id the server gave it.
 */
function resolveTarget(id: string): string {
  return state.synced.find((x) => x.id === id)?.serverId ?? id;
}

/** What a sent entry became, from the server's answer. */
function syncedFrom(e: QueuedEntry, res: Record<string, unknown>): Omit<SyncedEntry, "id" | "syncedAt"> {
  const text = (k: string) => String(res[k] ?? "");
  switch (kindOf(e)) {
    case "invoice": {
      const bill = e as OutboxEntry;
      return {
        kind: "invoice",
        number: bill.number,
        customerName: bill.customerName,
        total: bill.total,
        serverId: text("id"),
        serverNumber: text("invoiceNumber"),
        serverTotal: Number(res.grandTotal),
        ...(res.reviewStatus === "needs_review" ? { held: true } : {}),
      };
    }
    case "payment": {
      const p = e as PaymentEntry;
      return { kind: "payment", number: "", customerName: p.partyName, total: p.amount, serverId: text("id"), serverNumber: text("paymentNumber"), serverTotal: Number(res.amount) };
    }
    case "order": {
      const o = e as OrderEntry;
      return { kind: "order", number: "", customerName: o.customerName, total: o.estimate, serverId: text("id"), serverNumber: text("orderNumber"), serverTotal: Number(res.grandTotal) };
    }
    case "customer": {
      const c = e as CustomerEntry;
      return { kind: "customer", number: "", customerName: c.customerName, total: 0, serverId: text("id"), serverNumber: text("code"), serverTotal: 0 };
    }
    case "customer-edit": {
      const c = e as CustomerEditEntry;
      const merge = res.merge as { kept: string[] } | undefined;
      return { kind: "customer-edit", number: "", customerName: c.customerName, total: 0, serverId: text("id"), serverNumber: text("code"), serverTotal: 0, ...(merge?.kept.length ? { kept: merge.kept } : {}) };
    }
    case "purchase": {
      const p = e as PurchaseEntry;
      return { kind: "purchase", number: "", customerName: p.supplierName, total: p.total, serverId: text("id"), serverNumber: text("purchaseNumber"), serverTotal: Number(res.grandTotal) };
    }
    case "expense": {
      const x = e as ExpenseEntry;
      return { kind: "expense", number: "", customerName: x.paidTo || x.categoryName, total: x.total, serverId: text("id"), serverNumber: text("expenseNumber"), serverTotal: Number(res.totalAmount) };
    }
    case "return": {
      const r = e as ReturnEntry;
      return { kind: "return", number: "", customerName: r.partyName, total: r.estimate, serverId: text("id"), serverNumber: text("noteNumber"), serverTotal: Number(res.grandTotal) };
    }
    case "price-note": {
      const n = e as PriceNoteEntry;
      return { kind: "price-note", number: "", customerName: n.partyName, total: n.estimate, serverId: text("id"), serverNumber: text("noteNumber"), serverTotal: Number(res.grandTotal) };
    }
    case "invoice-cancel": {
      const c = e as CancelEntry;
      return { kind: "invoice-cancel", number: "", customerName: c.customerName, total: c.amount, serverId: text("id") || resolveTarget(c.documentId), serverNumber: text("invoiceNumber") || c.documentNumber, serverTotal: 0 };
    }
    case "collection-note": {
      const n = e as CollectionNoteEntry;
      return { kind: "collection-note", number: "", customerName: n.customerName, total: n.amount ?? 0, serverId: text("id"), serverNumber: "", serverTotal: n.amount ?? 0 };
    }
    case "visit": {
      const v = e as VisitEntry;
      return { kind: "visit", number: "", customerName: v.customerName, total: 0, serverId: text("id"), serverNumber: "", serverTotal: 0 };
    }
  }
}

/** A cancellation answered "not posted: cancelled": it was done before and the answer lost. */
const alreadyCancelled = (e: QueuedEntry, status: number, body: unknown) =>
  kindOf(e) === "invoice-cancel" &&
  status === 409 &&
  (body as { error?: { code?: string; params?: { status?: string } } } | null)?.error?.code === "INVOICE_NOT_POSTED" &&
  (body as { error: { params?: { status?: string } } }).error.params?.status === "cancelled";

/** A customer change and what the device had before it, so a change made meanwhile is merged field by field. */
function customerEditBody(c: CustomerEditEntry): Record<string, unknown> {
  if (c.version === null) return c.body;
  const before = c.before as unknown as Record<string, unknown>;
  const base = Object.fromEntries(Object.keys(c.body).filter((k) => k in before).map((k) => [k, (before[k] ?? null) as string | number | boolean | null]));
  return { ...c.body, offline: { base, madeAt: c.madeAt ?? c.savedAt } };
}

/** Sends one entry on its own; returns what the server made of it. */
async function send(e: QueuedEntry): Promise<Omit<SyncedEntry, "id" | "syncedAt">> {
  switch (kindOf(e)) {
    case "invoice":
      return syncedFrom(e, await api.post("/invoices", (e as OutboxEntry).body, { idempotencyKey: e.id }));
    case "payment":
      return syncedFrom(e, await api.post("/payments", (e as PaymentEntry).body, { idempotencyKey: e.id }));
    case "order":
      return syncedFrom(e, await api.post("/sales-orders", (e as OrderEntry).body, { idempotencyKey: e.id }));
    case "customer":
      return syncedFrom(e, await api.post("/customers", (e as CustomerEntry).body, { idempotencyKey: e.id }));
    case "customer-edit": {
      const c = e as CustomerEditEntry;
      const path = `/customers/${c.customerId}`;
      try {
        return syncedFrom(e, await api.patch(path, customerEditBody(c), c.version === null ? {} : { headers: { "if-match": String(c.version) } }));
      } catch (err) {
        // Changed since: fine if the server already shows this change (it was sent before, the answer lost).
        if (!(err instanceof ApiError && err.code === "VERSION_CONFLICT")) throw err;
        const now = await api.get<Record<string, unknown>>(path);
        if (!Object.entries(c.body).every(([k, v]) => (now[k] ?? null) === (v ?? null))) throw err;
        return syncedFrom(e, now);
      }
    }
    case "purchase":
      return syncedFrom(e, await api.post("/purchases", (e as PurchaseEntry).body, { idempotencyKey: e.id }));
    case "expense":
      return syncedFrom(e, await api.post("/expenses", (e as ExpenseEntry).body, { idempotencyKey: e.id }));
    case "return": {
      const r = e as ReturnEntry;
      return syncedFrom(e, await api.post(`/${r.side === "sale" ? "invoices" : "purchases"}/${resolveTarget(r.documentId)}/returns`, r.body, { idempotencyKey: r.id }));
    }
    case "price-note": {
      const n = e as PriceNoteEntry;
      return syncedFrom(e, await api.post(`/${n.side === "sale" ? "invoices" : "purchases"}/${resolveTarget(n.documentId)}/price-notes`, n.body, { idempotencyKey: n.id }));
    }
    case "invoice-cancel": {
      const c = e as CancelEntry;
      try {
        return syncedFrom(e, await api.post(`/invoices/${resolveTarget(c.documentId)}/cancel`, c.body, { idempotencyKey: c.id }));
      } catch (err) {
        if (err instanceof ApiError && alreadyCancelled(e, err.status, { error: { code: err.code, params: err.params } })) return syncedFrom(e, {});
        throw err;
      }
    }
    case "collection-note":
      return syncedFrom(e, await api.post("/collections/notes", (e as CollectionNoteEntry).body, { idempotencyKey: e.id }));
    case "visit":
      return syncedFrom(e, await api.post("/visits", (e as VisitEntry).body, { idempotencyKey: e.id }));
  }
}

/** One item of POST /sync/push for an entry (customer changes go on their own: a clash with a later change needs a look first). */
function pushItem(e: QueuedEntry, inBatch: ReadonlySet<string>): Record<string, unknown> | null {
  const customer = customerOf(e);
  // Work for a new customer sent in the same batch waits for it.
  const after = customer && customer !== e.id && inBatch.has(customer) ? { after: customer } : {};
  const target = (id: string) => ({ target: inBatch.has(id) ? id : resolveTarget(id) });
  switch (kindOf(e)) {
    case "invoice":
      return { id: e.id, kind: "invoice", ...after, body: (e as OutboxEntry).body };
    case "payment":
      return { id: e.id, kind: "payment", ...after, body: (e as PaymentEntry).body };
    case "order":
      return { id: e.id, kind: "order", ...after, body: (e as OrderEntry).body };
    case "customer":
      return { id: e.id, kind: "customer", body: (e as CustomerEntry).body };
    case "purchase":
      return { id: e.id, kind: "purchase", body: (e as PurchaseEntry).body };
    case "expense":
      return { id: e.id, kind: "expense", body: (e as ExpenseEntry).body };
    case "collection-note":
      return { id: e.id, kind: "collection-note", ...after, body: (e as CollectionNoteEntry).body };
    case "visit":
      return { id: e.id, kind: "visit", ...after, body: (e as VisitEntry).body };
    case "return": {
      const r = e as ReturnEntry;
      return { id: e.id, kind: r.side === "sale" ? "sale-return" : "purchase-return", ...target(r.documentId), body: r.body };
    }
    case "price-note": {
      const n = e as PriceNoteEntry;
      return { id: e.id, kind: n.side === "sale" ? "sale-price-note" : "purchase-price-note", ...target(n.documentId), body: n.body };
    }
    case "invoice-cancel": {
      const c = e as CancelEntry;
      return { id: e.id, kind: "invoice-cancel", ...target(c.documentId), body: c.body };
    }
    case "customer-edit":
      return null;
  }
}

/** Entries sent in one request at most. */
const BATCH = 25;
/** The server has no POST /sync/push (an older version): entries go one by one. */
let batchUnsupported = false;

let running: Promise<number> | null = null;

/**
 * Sends waiting work oldest first, up to BATCH in a request. Stops at the
 * first network or server error (tried again later); anything the server
 * refuses is marked and the rest still go, except work for a new customer the
 * server has not taken yet, and work on a bill made here that it refused.
 */
export function syncNow(): Promise<number> {
  running ??= (async () => {
    if (!scope || state.offlineMode) return 0;
    const pending = state.entries.filter((e) => e.status === "pending");
    if (pending.length === 0) return 0;
    set({ syncing: true });
    let done = 0;
    // Customers and bills the server does not have yet (refused): what is for them waits.
    const blocked = new Set(state.entries.filter((e) => (kindOf(e) === "customer" || kindOf(e) === "invoice") && e.status === "failed").map((e) => e.id));
    const isBlocked = (e: QueuedEntry) => {
      const customer = customerOf(e);
      if (customer && customer !== e.id && blocked.has(customer)) return true;
      const target = (e as Partial<ReturnEntry | PriceNoteEntry | CancelEntry>).documentId;
      return Boolean(target && blocked.has(target));
    };
    const succeeded = async (e: QueuedEntry, result: Omit<SyncedEntry, "id" | "syncedAt">) => {
      await idbDelete("outbox", e.id);
      const history = [{ ...result, id: e.id, syncedAt: new Date().toISOString() }, ...state.synced].slice(0, 30);
      await saveSynced(history);
      set({ entries: state.entries.filter((x) => x.id !== e.id), synced: history });
      done += 1;
    };
    /** Refused for good (a 4xx the person must look at): kept, marked; true. Otherwise false: stop and try later. */
    const refused = async (e: QueuedEntry, error: ApiError) => {
      if (!(error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status))) return false;
      const failed = { ...e, status: "failed", error: { status: error.status, code: error.code, params: error.params } } as QueuedEntry;
      await putEntry(failed);
      set({ entries: state.entries.map((x) => (x.id === e.id ? failed : x)) });
      if (kindOf(e) === "customer" || kindOf(e) === "invoice") blocked.add(e.id);
      return true;
    };
    const one = async (e: QueuedEntry): Promise<boolean> => {
      try {
        await succeeded(e, await send(e));
        return true;
      } catch (err) {
        return refused(e, err instanceof ApiError ? err : new ApiError(0, "network"));
      }
    };
    try {
      let i = 0;
      outer: while (i < pending.length) {
        const e = pending[i]!;
        if (isBlocked(e)) {
          i++;
          continue;
        }
        if (batchUnsupported || kindOf(e) === "customer-edit") {
          i++;
          if (!(await one(e))) break;
          continue;
        }
        // The next run of entries that can go together.
        const group: QueuedEntry[] = [];
        while (i < pending.length && group.length < BATCH && kindOf(pending[i]!) !== "customer-edit") {
          if (!isBlocked(pending[i]!)) group.push(pending[i]!);
          i++;
        }
        const ids = new Set(group.map((x) => x.id));
        let results: Array<{ id: string; status: number; body: unknown }>;
        try {
          results = (await api.post<{ results: typeof results }>("/sync/push", { items: group.map((x) => pushItem(x, ids)) })).results;
        } catch (err) {
          if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
            // An older server: one by one, from this group on.
            batchUnsupported = true;
            i -= group.length;
            continue;
          }
          break;
        }
        for (const [k, x] of group.entries()) {
          const r = results[k];
          if (!r || r.status === 0) {
            // Not tried: waits for something refused (stays waiting), or the server stopped the batch.
            if (results.some((y) => y.status >= 500 || y.status === 429)) break outer;
            continue;
          }
          if ((r.status >= 200 && r.status < 300) || alreadyCancelled(x, r.status, r.body)) {
            await succeeded(x, syncedFrom(x, (r.body ?? {}) as Record<string, unknown>));
            continue;
          }
          const error = (r.body as { error?: { code?: string; params?: Record<string, string | number>; field?: string } } | null)?.error;
          if (!(await refused(x, new ApiError(r.status, error?.code ?? "generic", error?.params ?? {}, error?.field)))) break outer;
        }
      }
    } finally {
      set({ syncing: false, ...(done > 0 ? { lastSyncAt: new Date().toISOString() } : {}) });
    }
    if (done > 0) syncedListeners.forEach((l) => l(done));
    return done;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** The bill made offline behind an "offline:<id>" link, or where the server filed it. */
export function findOfflineBill(id: string): { entry?: OutboxEntry; synced?: SyncedEntry } {
  const entry = state.entries.find((e) => e.id === id && kindOf(e) === "invoice") as OutboxEntry | undefined;
  if (entry) return { entry };
  const synced = state.synced.find((s) => s.id === id && kindOf(s) === "invoice");
  return synced ? { synced } : {};
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    set({ online: true });
    void syncNow();
  });
  window.addEventListener("offline", () => set({ online: false }));
  // Work can wait when the server is briefly out of reach while the network is up.
  setInterval(() => {
    if (state.online && state.entries.some((e) => e.status === "pending")) void syncNow();
  }, 60_000);
}
