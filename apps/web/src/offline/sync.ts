import { useSyncExternalStore } from "react";
import { customerById } from "../data/db";
import { adjustStock } from "../data/live";
import { touch } from "../data/store";
import type { PrintableInvoice } from "../features/invoice/printable";
import { api, ApiError } from "../lib/api";
import { loadDevice, type DeviceRecord } from "./device";
import { idbAll, idbDelete, idbGet, idbPut } from "./idb";

/**
 * Bills made without a connection wait here (on the device, in IndexedDB)
 * until the server takes them. Each is sent with its own Idempotency-Key, so
 * a send cut off half-way is simply sent again; the server keeps the number
 * the device gave it.
 */
export interface OutboxEntry {
  /** Also the Idempotency-Key. */
  id: string;
  userId: string;
  businessId: string;
  number: string;
  date: string;
  savedAt: string;
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
  status: "pending" | "failed";
  error: { status: number; code: string; params: Record<string, string | number> } | null;
}

/** A bill the server has taken; kept briefly so the list can show what happened. */
export interface SyncedEntry {
  id: string;
  number: string;
  customerName: string;
  total: number;
  serverId: string;
  serverNumber: string;
  serverTotal: number;
  syncedAt: string;
}

export interface OfflineState {
  /** The browser has a network connection. */
  online: boolean;
  /** Running from the copy saved on this device (the server could not be reached at start). */
  offlineMode: boolean;
  entries: OutboxEntry[];
  synced: SyncedEntry[];
  syncing: boolean;
  lastSyncAt: string | null;
  device: DeviceRecord | null;
}

interface PostedInvoice {
  id: string;
  invoiceNumber: string;
  grandTotal: string;
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

/** Called after bills were synced (the session reloads the workspace then). */
export function onSynced(listener: (count: number) => void): () => void {
  syncedListeners.add(listener);
  return () => syncedListeners.delete(listener);
}

const syncedKey = () => `synced:${scope!.userId}:${scope!.businessId}`;
const byOrder = (a: OutboxEntry, b: OutboxEntry) => a.savedAt.localeCompare(b.savedAt) || a.number.localeCompare(b.number);

async function reload(): Promise<void> {
  if (!scope) return;
  const { userId, businessId } = scope;
  const [all, synced, device] = await Promise.all([idbAll<OutboxEntry>("outbox"), idbGet<SyncedEntry[]>("kv", syncedKey()), loadDevice(userId, businessId)]);
  if (scope?.userId !== userId || scope.businessId !== businessId) return;
  set({ entries: all.filter((e) => e.userId === userId && e.businessId === businessId).sort(byOrder), synced: synced ?? [], device: device?.seriesCode ? device : null });
}

/** Points the queue at the signed-in user and business (bills of others stay on the device, untouched). */
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

/** Takes the bills still waiting out of the freshly loaded stock and balances again. */
export function applyPendingEffects(): void {
  for (const e of state.entries) applyEffects(e, 1);
  touch();
}

function applyEffects(e: OutboxEntry, sign: 1 | -1): void {
  for (const s of e.stock) adjustStock(s.productId, -sign * s.qty);
  const c = customerById.get(e.customerId);
  if (c) c.balance = (c.balance ?? 0) + sign * (e.total - e.paid);
}

/** Keeps a bill made offline; its stock and balance move on this device at once. */
export async function queueBill(entry: OutboxEntry): Promise<boolean> {
  if (!(await idbPut("outbox", entry))) return false;
  applyEffects(entry, 1);
  touch();
  set({ entries: [...state.entries, entry].sort(byOrder) });
  return true;
}

/** Drops a bill the server refused; its number stays unused (a gap to explain in the GST return). */
export async function removeBill(id: string): Promise<void> {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  await idbDelete("outbox", id);
  applyEffects(e, -1);
  touch();
  set({ entries: state.entries.filter((x) => x.id !== id) });
}

export async function retryBill(id: string): Promise<void> {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  const next: OutboxEntry = { ...e, status: "pending", error: null };
  await idbPut("outbox", next);
  set({ entries: state.entries.map((x) => (x.id === id ? next : x)) });
  await syncNow();
}

let running: Promise<number> | null = null;

/**
 * Sends waiting bills oldest first. Stops at the first network or server
 * error (tried again later); a bill the server refuses is marked and the
 * rest still go.
 */
export function syncNow(): Promise<number> {
  running ??= (async () => {
    if (!scope || state.offlineMode) return 0;
    const pending = state.entries.filter((e) => e.status === "pending");
    if (pending.length === 0) return 0;
    set({ syncing: true });
    let done = 0;
    try {
      for (const e of pending) {
        try {
          const res = await api.post<PostedInvoice>("/invoices", e.body, { idempotencyKey: e.id });
          await idbDelete("outbox", e.id);
          const synced: SyncedEntry = {
            id: e.id,
            number: e.number,
            customerName: e.customerName,
            total: e.total,
            serverId: res.id,
            serverNumber: res.invoiceNumber,
            serverTotal: Number(res.grandTotal),
            syncedAt: new Date().toISOString(),
          };
          const history = [synced, ...state.synced].slice(0, 30);
          await idbPut("kv", history, syncedKey());
          set({ entries: state.entries.filter((x) => x.id !== e.id), synced: history });
          done += 1;
        } catch (err) {
          const error = err instanceof ApiError ? err : new ApiError(0, "network");
          if (error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status)) {
            const failed: OutboxEntry = { ...e, status: "failed", error: { status: error.status, code: error.code, params: error.params } };
            await idbPut("outbox", failed);
            set({ entries: state.entries.map((x) => (x.id === e.id ? failed : x)) });
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
  const entry = state.entries.find((e) => e.id === id);
  if (entry) return { entry };
  const synced = state.synced.find((s) => s.id === id);
  return synced ? { synced } : {};
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    set({ online: true });
    void syncNow();
  });
  window.addEventListener("offline", () => set({ online: false }));
  // Bills can wait when the server is briefly out of reach while the network is up.
  setInterval(() => {
    if (state.online && state.entries.some((e) => e.status === "pending")) void syncNow();
  }, 60_000);
}
