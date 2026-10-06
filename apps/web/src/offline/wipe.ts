import { rememberSignIn } from "../lib/lastSignIn";
import { idbAll, idbDelete, idbGet, idbKeys } from "./idb";

/**
 * Deletes one business's copy from this device: the saved business, its kept
 * bills, a bill or form left half made and the day's beat and, for a device the owner removed, the device record and the work
 * still waiting to sync (and the person's key, when nothing else of theirs is
 * left here). A copy that expired keeps its waiting work, still encrypted, to
 * send at the next sign-in. Returns how many waiting entries were deleted.
 */
export async function wipeBusinessCopy(userId: string, businessId: string, options: { removedDevice: boolean }): Promise<number> {
  await idbDelete("kv", `snapshot:${userId}:${businessId}`);
  await idbDelete("kv", `docs:${userId}:${businessId}`);
  await idbDelete("kv", `beat:${userId}:${businessId}`);
  await idbDelete("kv", `invoice-draft:${userId}:${businessId}`);
  for (const k of await idbKeys("kv")) if (k.startsWith("form-draft:") && k.endsWith(`:${userId}:${businessId}`)) await idbDelete("kv", k);
  const last = await idbGet<{ userId?: string; businessId?: string } | string>("kv", "snapshot:last");
  if (last && typeof last === "object" && last.userId === userId && last.businessId === businessId) await idbDelete("kv", "snapshot:last");
  if (!options.removedDevice) return 0;

  // A device the owner removed no longer offers who signed in on it.
  rememberSignIn(null);

  await idbDelete("kv", `device:${userId}:${businessId}`);
  await idbDelete("kv", `synced:${userId}:${businessId}`);
  let waiting = 0;
  for (const row of await idbAll<{ id: string; userId: string; businessId: string }>("outbox")) {
    if (row.userId !== userId || row.businessId !== businessId) continue;
    await idbDelete("outbox", row.id);
    waiting++;
  }
  // Nothing else of this person's on the device: their key goes too.
  const keys = await idbKeys("kv");
  const more = keys.some((k) => k.startsWith(`snapshot:${userId}:`) || k.startsWith(`device:${userId}:`)) || (await idbAll<{ userId: string }>("outbox")).some((r) => r.userId === userId);
  if (!more) await idbDelete("kv", `vault:${userId}`);
  return waiting;
}
