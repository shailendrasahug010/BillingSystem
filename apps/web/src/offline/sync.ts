import { useSyncExternalStore } from "react";
import { customerById, supplierById } from "../data/db";
import { adjustStock, customerRow, dropCustomer, showCustomerDetails, upsertCustomer, type CustomerRow } from "../data/live";
import { touch } from "../data/store";
import type { PrintableInvoice } from "../features/invoice/printable";
import { api, ApiError } from "../lib/api";
import { loadDevice, type DeviceRecord } from "./device";
import { idbAll, idbDelete, idbGet, idbPut } from "./idb";
import { isSealed, seal, unseal, type Sealed } from "./vault";

/**
 * Work done without a connection waits here (on the device, in IndexedDB)
 * until the server takes it: bills, payments, orders, new customers, changes
 * to customers and collectors' visit notes. Each is sent with its own Idempotency-Key, so a send
 * cut off half-way is simply sent again; the server keeps the number the
 * device gave a bill, and a new customer keeps the id it was billed under.
 */
interface EntryBase {
  /** Also the Idempotency-Key (and a new customer's id). */
  id: string;
  userId: string;
  businessId: string;
  savedAt: string;
  status: "pending" | "failed";
  error: { status: number; code: string; params: Record<string, string | number> } | null;
}

/** A bill (entries saved before other kinds existed have no `kind`). */
export interface OutboxEntry extends EntryBase {
  kind?: "invoice";
  number: string;
  date: string;
  customerId: string;
  customerName: string;
  total: number;
  paid: number;
  lineCount: number;
  /** The POST /invoices body, offline block included. */
  body: Record<string, unknown>;
  printable: PrintableInvoice;
  /** Stock taken out on this device (base units), put back if the bill is removed. */
  stock: Array<{ productId: string; qty: number }>;
}

/** Money from a customer or to a supplier; the server applies it to the oldest bills first. */
export interface PaymentEntry extends EntryBase {
  kind: "payment";
  direction: "in" | "out";
  partyId: string;
  partyName: string;
  date: string;
  amount: number;
  method: string;
  body: Record<string, unknown>;
}

export interface OrderEntry extends EntryBase {
  kind: "order";
  customerId: string;
  customerName: string;
  date: string;
  /** What the device worked out; the server prices the order when it arrives. */
  estimate: number;
  lineCount: number;
  body: Record<string, unknown>;
}

/** A customer added on this device: billed at once under this id. */
export interface CustomerEntry extends EntryBase {
  kind: "customer";
  customerId: string;
  customerName: string;
  body: Record<string, unknown>;
  /** How the customer shows until the server has it. */
  row: CustomerRow;
}

/** Changed details of a customer (only the fields that changed). */
export interface CustomerEditEntry extends EntryBase {
  kind: "customer-edit";
  customerId: string;
  customerName: string;
  body: Record<string, unknown>;
  /** The version the change was made on; null once the person chose to keep theirs over a later change. */
  version: number | null;
  /** The customer before and after, to show now and to put back if the change is removed. */
  before: CustomerRow;
  after: CustomerRow;
}

/** A collector's visit: a note, or the customer's promise to pay by a date. */
export interface CollectionNoteEntry extends EntryBase {
  kind: "collection-note";
  customerId: string;
  customerName: string;
  noteKind: "promise" | "note";
  /** The promised date, or the day of the visit. */
  date: string;
  amount: number | null;
  body: Record<string, unknown>;
}

export type QueuedEntry = OutboxEntry | PaymentEntry | OrderEntry | CustomerEntry | CustomerEditEntry | CollectionNoteEntry;
export type QueuedKind = NonNullable<QueuedEntry["kind"]>;
export const kindOf = (e: { kind?: QueuedKind }): QueuedKind => e.kind ?? "invoice";

/** Something the server has taken; kept briefly so the list can show what happened. */
export interface SyncedEntry {
  id: string;
  kind?: QueuedKind;
  /** The device's number for a bill ("" otherwise). */
  number: string;
  customerName: string;
  total: number;
  serverId: string;
  /** Bill, receipt or order number, or the new customer's code. */
  serverNumber: string;
  serverTotal: number;
  syncedAt: string;
}

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

/** The customer an entry belongs to (null for a supplier payment). */
function customerOf(e: QueuedEntry): string | null {
  const kind = kindOf(e);
  if (kind === "payment") return (e as PaymentEntry).direction === "in" ? (e as PaymentEntry).partyId : null;
  return (e as OutboxEntry | OrderEntry | CustomerEntry | CustomerEditEntry | CollectionNoteEntry).customerId;
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
    case "order":
    case "collection-note":
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
    return queueEntry({ ...edit, customerName: after.businessName ?? after.name, body: { ...edit.body, ...patch }, after });
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

/** Sends one entry; returns what the server made of it. */
async function send(e: QueuedEntry): Promise<Omit<SyncedEntry, "id" | "syncedAt">> {
  switch (kindOf(e)) {
    case "invoice": {
      const bill = e as OutboxEntry;
      const res = await api.post<{ id: string; invoiceNumber: string; grandTotal: string }>("/invoices", bill.body, { idempotencyKey: bill.id });
      return { kind: "invoice", number: bill.number, customerName: bill.customerName, total: bill.total, serverId: res.id, serverNumber: res.invoiceNumber, serverTotal: Number(res.grandTotal) };
    }
    case "payment": {
      const p = e as PaymentEntry;
      const res = await api.post<{ id: string; paymentNumber: string; amount: string }>("/payments", p.body, { idempotencyKey: p.id });
      return { kind: "payment", number: "", customerName: p.partyName, total: p.amount, serverId: res.id, serverNumber: res.paymentNumber, serverTotal: Number(res.amount) };
    }
    case "order": {
      const o = e as OrderEntry;
      const res = await api.post<{ id: string; orderNumber: string; grandTotal: string }>("/sales-orders", o.body, { idempotencyKey: o.id });
      return { kind: "order", number: "", customerName: o.customerName, total: o.estimate, serverId: res.id, serverNumber: res.orderNumber, serverTotal: Number(res.grandTotal) };
    }
    case "customer": {
      const c = e as CustomerEntry;
      const res = await api.post<{ id: string; code: string }>("/customers", c.body, { idempotencyKey: c.id });
      return { kind: "customer", number: "", customerName: c.customerName, total: 0, serverId: res.id, serverNumber: res.code, serverTotal: 0 };
    }
    case "customer-edit": {
      const c = e as CustomerEditEntry;
      const path = `/customers/${c.customerId}`;
      let res: { id: string; code: string };
      try {
        res = await api.patch<{ id: string; code: string }>(path, c.body, c.version === null ? {} : { headers: { "if-match": String(c.version) } });
      } catch (err) {
        // Changed since: fine if the server already shows this change (it was sent before, the answer lost).
        if (!(err instanceof ApiError && err.code === "VERSION_CONFLICT")) throw err;
        const now = await api.get<Record<string, unknown> & { id: string; code: string }>(path);
        if (!Object.entries(c.body).every(([k, v]) => (now[k] ?? null) === (v ?? null))) throw err;
        res = now;
      }
      return { kind: "customer-edit", number: "", customerName: c.customerName, total: 0, serverId: res.id, serverNumber: res.code, serverTotal: 0 };
    }
    case "collection-note": {
      const n = e as CollectionNoteEntry;
      const res = await api.post<{ id: string }>("/collections/notes", n.body, { idempotencyKey: n.id });
      return { kind: "collection-note", number: "", customerName: n.customerName, total: n.amount ?? 0, serverId: res.id, serverNumber: "", serverTotal: n.amount ?? 0 };
    }
  }
}

let running: Promise<number> | null = null;

/**
 * Sends waiting work oldest first. Stops at the first network or server error
 * (tried again later); anything the server refuses is marked and the rest
 * still go, except work for a new customer the server has not taken yet.
 */
export function syncNow(): Promise<number> {
  running ??= (async () => {
    if (!scope || state.offlineMode) return 0;
    const pending = state.entries.filter((e) => e.status === "pending");
    if (pending.length === 0) return 0;
    set({ syncing: true });
    let done = 0;
    // Customers the server does not have yet: what is for them waits.
    const blocked = new Set(state.entries.filter((e) => kindOf(e) === "customer" && e.status === "failed").map((e) => (e as CustomerEntry).customerId));
    try {
      for (const e of pending) {
        const customer = customerOf(e);
        if (customer && blocked.has(customer) && kindOf(e) !== "customer") continue;
        try {
          const result = await send(e);
          await idbDelete("outbox", e.id);
          const history = [{ ...result, id: e.id, syncedAt: new Date().toISOString() }, ...state.synced].slice(0, 30);
          await saveSynced(history);
          set({ entries: state.entries.filter((x) => x.id !== e.id), synced: history });
          done += 1;
        } catch (err) {
          const error = err instanceof ApiError ? err : new ApiError(0, "network");
          if (error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status)) {
            const failed = { ...e, status: "failed", error: { status: error.status, code: error.code, params: error.params } } as QueuedEntry;
            await putEntry(failed);
            set({ entries: state.entries.map((x) => (x.id === e.id ? failed : x)) });
            if (kindOf(e) === "customer") blocked.add((e as CustomerEntry).customerId);
            continue;
          }
          break;
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
