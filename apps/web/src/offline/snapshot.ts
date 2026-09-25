import type { BusinessSummary, MeResponse, SessionResponse } from "@vyapaar/contracts";
import type { WorkspaceData } from "../data/live";
import { idbDelete, idbGet, idbKeys, idbPut } from "./idb";

/**
 * The business as last loaded from the server (profile, rules, catalogue,
 * customers), kept on the device so the app opens and bills without a
 * connection. Never holds a token or password; signing out wipes it.
 */
export interface Snapshot {
  user: SessionResponse["user"];
  business: BusinessSummary;
  businesses: BusinessSummary[];
  me: MeResponse;
  data: WorkspaceData;
  savedAt: string;
}

const key = (userId: string, businessId: string) => `snapshot:${userId}:${businessId}`;
const LAST = "snapshot:last";

export async function saveSnapshot(snapshot: Snapshot): Promise<boolean> {
  const k = key(snapshot.user.id, snapshot.business.id);
  if (!(await idbPut("kv", snapshot, k))) return false;
  return idbPut("kv", k, LAST);
}

/** The business the app showed last on this device. */
export async function loadLastSnapshot(): Promise<Snapshot | undefined> {
  const k = await idbGet<string>("kv", LAST);
  return k ? idbGet<Snapshot>("kv", k) : undefined;
}

export function loadSnapshot(userId: string, businessId: string): Promise<Snapshot | undefined> {
  return idbGet<Snapshot>("kv", key(userId, businessId));
}

/** Signing out forgets every saved business on this device (bills waiting to sync are kept). */
export async function clearSnapshots(): Promise<void> {
  for (const k of await idbKeys("kv")) if (k.startsWith("snapshot:")) await idbDelete("kv", k);
}
