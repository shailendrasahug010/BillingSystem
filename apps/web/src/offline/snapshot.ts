import type { BusinessSummary, MeResponse, SessionResponse } from "@vyapaar/contracts";
import type { WorkspaceData } from "../data/live";
import { idbDelete, idbGet, idbKeys, idbPut } from "./idb";
import { isSealed, seal, unseal, type Sealed } from "./vault";

/**
 * The business as last loaded from the server (profile, rules, catalogue,
 * customers), kept on the device so the app opens and bills without a
 * connection. Stored encrypted (see vault.ts); never holds a token or
 * password; signing out wipes it.
 */
export interface Snapshot {
  user: SessionResponse["user"];
  business: BusinessSummary;
  businesses: BusinessSummary[];
  me: MeResponse;
  data: WorkspaceData;
  savedAt: string;
}

/** Who and which business the saved copy is: readable while the copy is locked, for the unlock screen. */
export interface SnapshotMeta {
  userId: string;
  businessId: string;
  userName: string;
  businessName: string;
}

interface Stored {
  userId: string;
  businessId: string;
  sealed: Sealed;
}

const key = (userId: string, businessId: string) => `snapshot:${userId}:${businessId}`;
const LAST = "snapshot:last";
const isStored = (v: unknown): v is Stored => typeof v === "object" && v !== null && isSealed((v as Stored).sealed);

export async function saveSnapshot(snapshot: Snapshot): Promise<boolean> {
  const k = key(snapshot.user.id, snapshot.business.id);
  const sealed = await seal(snapshot, k);
  if (!sealed) return false;
  if (!(await idbPut("kv", { userId: snapshot.user.id, businessId: snapshot.business.id, sealed } satisfies Stored, k))) return false;
  const meta: SnapshotMeta = { userId: snapshot.user.id, businessId: snapshot.business.id, userName: snapshot.user.name, businessName: snapshot.business.tradeName ?? snapshot.business.legalName };
  return idbPut("kv", meta, LAST);
}

/** The person and business the app showed last on this device. */
export async function lastSnapshotMeta(): Promise<SnapshotMeta | undefined> {
  const last = await idbGet<SnapshotMeta | string>("kv", LAST);
  if (!last || typeof last === "string") return undefined; // Saved before the copy was locked: opens online only.
  return (await idbGet("kv", key(last.userId, last.businessId))) ? last : undefined;
}

/** Whether a copy of this business is kept here for this person (it may be locked). */
export async function hasSnapshot(userId: string, businessId: string): Promise<boolean> {
  return isStored(await idbGet<unknown>("kv", key(userId, businessId)));
}

/** The saved copy, if this person's copy is open (vault.ts). */
export async function loadSnapshot(userId: string, businessId: string): Promise<Snapshot | undefined> {
  const k = key(userId, businessId);
  const stored = await idbGet<unknown>("kv", k);
  return isStored(stored) ? unseal<Snapshot>(stored.sealed, k) : undefined;
}

/** Copies saved before the device copy was encrypted are dropped (the server has everything in them). */
export async function dropUnlockedSnapshots(): Promise<void> {
  for (const k of await idbKeys("kv")) {
    if (!k.startsWith("snapshot:") || k === LAST) continue;
    if (!isStored(await idbGet<unknown>("kv", k))) await idbDelete("kv", k);
  }
}

/** Signing out forgets every saved business on this device (work waiting to sync is kept, locked). */
export async function clearSnapshots(): Promise<void> {
  for (const k of await idbKeys("kv")) if (k.startsWith("snapshot:")) await idbDelete("kv", k);
}
