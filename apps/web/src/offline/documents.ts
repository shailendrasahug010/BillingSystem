import { useSyncExternalStore } from "react";
import { api, ApiError } from "../lib/api";
import { idbDelete, idbGet, idbKeys, idbPut } from "./idb";
import { unreachable, workingOffline } from "./sync";
import { isSealed, seal, unseal, vaultOpen, type Sealed } from "./vault";

export type DocKind = "invoice" | "purchase";

interface Kept {
  savedAt: string;
  invoices: Record<string, { id: string }>;
  purchases: Record<string, { id: string }>;
}

/**
 * Recent bills (the last 30 days, and any opened since) kept on the device,
 * encrypted like the rest of its copy, so a bill can be opened, printed and
 * returned against without a connection. Refreshed from the server in the
 * background while online; signing out wipes it.
 */
let scope: { userId: string; businessId: string } | null = null;
let kept: Kept | null = null;
let fetchedAt = 0;
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

const keyFor = (s: { userId: string; businessId: string }) => `docs:${s.userId}:${s.businessId}`;
const REFRESH_MS = 15 * 60_000;

async function persist(): Promise<void> {
  if (!scope || !kept || !vaultOpen(scope.userId)) return;
  const k = keyFor(scope);
  const sealed = await seal(kept, k);
  if (sealed) await idbPut("kv", { sealed }, k);
}

/** Opens this person's kept bills for a business (at start, online or not). */
export async function openDeviceDocuments(userId: string, businessId: string): Promise<void> {
  scope = { userId, businessId };
  kept = null;
  fetchedAt = 0;
  const stored = await idbGet<{ sealed: Sealed }>("kv", keyFor(scope));
  if (stored && isSealed(stored.sealed)) kept = (await unseal<Kept>(stored.sealed, keyFor(scope))) ?? null;
  emit();
}

/** Fetches the recent bills again (at most every 15 minutes unless forced). */
export async function refreshDeviceDocuments(force = false): Promise<void> {
  if (!scope || workingOffline() || (!force && Date.now() - fetchedAt < REFRESH_MS)) return;
  fetchedAt = Date.now();
  try {
    const res = await api.get<{ invoices?: Array<{ id: string }>; purchases?: Array<{ id: string }> }>("/offline/documents", { days: "30" });
    kept = {
      savedAt: new Date().toISOString(),
      invoices: Object.fromEntries((res.invoices ?? []).map((d) => [d.id, d])),
      purchases: Object.fromEntries((res.purchases ?? []).map((d) => [d.id, d])),
    };
    await persist();
    emit();
  } catch {
    fetchedAt = 0;
  }
}

/** A bill as kept on this device, if it is. */
export function deviceDocument<T>(kind: DocKind, id: string): T | undefined {
  return kept?.[kind === "invoice" ? "invoices" : "purchases"][id] as T | undefined;
}

/** All kept bills of a kind (newest first as the server gave them). */
export function deviceDocuments<T>(kind: DocKind): T[] {
  return Object.values(kept?.[kind === "invoice" ? "invoices" : "purchases"] ?? {}) as T[];
}

/** When the kept bills were last fetched. */
export const deviceDocumentsSavedAt = () => kept?.savedAt ?? null;

/** Keeps (or updates) one bill just read from the server, so it opens offline later too. */
export function rememberDocument(kind: DocKind, doc: { id: string }): void {
  if (!scope) return;
  kept ??= { savedAt: new Date().toISOString(), invoices: {}, purchases: {} };
  kept[kind === "invoice" ? "invoices" : "purchases"][doc.id] = doc;
  void persist();
}

/** Changes a kept bill (e.g. what has been returned from it, while the return waits to sync). */
export function updateDeviceDocument<T extends { id: string }>(kind: DocKind, id: string, change: (doc: T) => T): void {
  const doc = deviceDocument<T>(kind, id);
  if (!doc || !kept) return;
  kept[kind === "invoice" ? "invoices" : "purchases"][id] = change(doc);
  void persist();
  emit();
}

/** Marks a bill that came from this device's copy (for a "saved copy" note on screen). */
export type MaybeDeviceCopy<T> = T & { deviceCopyAt?: string };

/**
 * The server's bill, or the one kept on this device when the server cannot
 * be reached. Bills read from the server are kept for next time.
 */
export async function serverOrDevice<T extends { id: string }>(kind: DocKind, id: string, fetch: () => Promise<T>): Promise<MaybeDeviceCopy<T>> {
  const fromDevice = () => {
    const doc = deviceDocument<T>(kind, id);
    return doc ? { ...doc, deviceCopyAt: kept!.savedAt } : undefined;
  };
  if (workingOffline()) {
    const doc = fromDevice();
    if (doc) return doc;
    throw new ApiError(0, "network");
  }
  try {
    const doc = await fetch();
    rememberDocument(kind, doc);
    return doc;
  } catch (e) {
    const doc = unreachable(e) ? fromDevice() : undefined;
    if (doc) return doc;
    throw e;
  }
}

/** Re-renders when the kept bills change. */
export function useDeviceDocuments(): number {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => version,
    () => version,
  );
}

/** Signing out wipes every kept bill on this device. */
export async function clearDeviceDocuments(): Promise<void> {
  kept = null;
  scope = null;
  for (const k of await idbKeys("kv")) if (k.startsWith("docs:")) await idbDelete("kv", k);
  emit();
}
