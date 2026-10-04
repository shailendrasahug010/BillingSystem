import { idbDelete, idbGet, idbKeys, idbPut } from "../../offline/idb";
import { offlineScope } from "../../offline/sync";
import { isSealed, seal, unseal, vaultOpen, type Sealed } from "../../offline/vault";
import type { Draft } from "./useInvoiceDraft";

/** A bill being made, kept while it is not saved: what was on the screen, and when. */
export interface KeptDraft {
  savedAt: string;
  draft: Omit<Draft, "focusKey">;
}

/**
 * The bill left half made, one per person and business on this device. It is
 * kept in this page's memory (another screen and back) and, where the
 * device's copy is open, encrypted in IndexedDB like the rest of that copy
 * (a reload, the app closed by the phone); signing out deletes it. The demo
 * keeps it in memory only.
 */
const PREFIX = "invoice-draft:";
const memory = new Map<string, KeptDraft>();
// Writes and deletes reach the database in the order made: a bill saved just after
// an edit is never brought back by that edit's write finishing late.
let queue: Promise<unknown> = Promise.resolve();
const inOrder = (work: () => Promise<unknown>) => (queue = queue.then(work, work).catch(() => undefined));

function where(): { key: string; stored: boolean } {
  const scope = offlineScope();
  if (!scope) return { key: `${PREFIX}local`, stored: false };
  return { key: `${PREFIX}${scope.userId}:${scope.businessId}`, stored: vaultOpen(scope.userId) };
}

/** Whether a bill left half made outlives a reload here (else the page warns before leaving). */
export const draftOutlivesReload = () => where().stored;

export async function loadKeptDraft(): Promise<KeptDraft | null> {
  const { key, stored } = where();
  const inMemory = memory.get(key);
  if (inMemory || !stored) return inMemory ?? null;
  await queue;
  const row = await idbGet<{ sealed: Sealed }>("kv", key);
  if (!row || !isSealed(row.sealed)) return null;
  return (await unseal<KeptDraft>(row.sealed, key)) ?? null;
}

/** Keeps the bill in this page's memory at once; with `store`, on the device too. */
export async function keepDraft(draft: Draft, store = true): Promise<void> {
  const { key, stored } = where();
  const { focusKey: _focus, ...rest } = draft;
  const kept: KeptDraft = { savedAt: new Date().toISOString(), draft: rest };
  memory.set(key, kept);
  if (!stored || !store) return;
  await inOrder(async () => {
    const sealed = await seal(kept, key);
    if (sealed) await idbPut("kv", { sealed }, key);
  });
}

export async function dropKeptDraft(): Promise<void> {
  const { key, stored } = where();
  memory.delete(key);
  if (stored) await inOrder(() => idbDelete("kv", key));
}

/** Signing out: every bill left half made on this device goes. */
export async function clearKeptDrafts(): Promise<void> {
  memory.clear();
  await inOrder(async () => {
    for (const k of await idbKeys("kv")) if (k.startsWith(PREFIX)) await idbDelete("kv", k);
  });
}
