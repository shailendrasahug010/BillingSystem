import { useEffect, useRef, useState } from "react";
import { idbDelete, idbGet, idbKeys, idbPut } from "./idb";
import { offlineScope } from "./sync";
import { isSealed, seal, unseal, vaultOpen, type Sealed } from "./vault";

/**
 * Forms left half filled (a purchase bill, an order), one of each kind per
 * person and business on this device, kept the way the half-made sales bill
 * is (see invoice/keptDraft.ts): in this page's memory at once and, where the
 * device's copy is open, encrypted in IndexedDB, so a reload or the phone
 * closing the app loses nothing. Signing out deletes them.
 */
const PREFIX = "form-draft:";
const memory = new Map<string, Kept<unknown>>();
let queue: Promise<unknown> = Promise.resolve();
const inOrder = (work: () => Promise<unknown>) => (queue = queue.then(work, work).catch(() => undefined));

export interface Kept<T> {
  savedAt: string;
  value: T;
}

function where(form: string): { key: string; stored: boolean } {
  const scope = offlineScope();
  if (!scope) return { key: `${PREFIX}${form}:local`, stored: false };
  return { key: `${PREFIX}${form}:${scope.userId}:${scope.businessId}`, stored: vaultOpen(scope.userId) };
}

export async function loadKeptForm<T>(form: string): Promise<Kept<T> | null> {
  const { key, stored } = where(form);
  const inMemory = memory.get(key) as Kept<T> | undefined;
  if (inMemory || !stored) return inMemory ?? null;
  await queue;
  const row = await idbGet<{ sealed: Sealed }>("kv", key);
  if (!row || !isSealed(row.sealed)) return null;
  return (await unseal<Kept<T>>(row.sealed, key)) ?? null;
}

export async function keepForm<T>(form: string, value: T, store = true): Promise<void> {
  const { key, stored } = where(form);
  const kept: Kept<T> = { savedAt: new Date().toISOString(), value };
  memory.set(key, kept);
  if (!stored || !store) return;
  await inOrder(async () => {
    const sealed = await seal(kept, key);
    if (sealed) await idbPut("kv", { sealed }, key);
  });
}

export async function dropKeptForm(form: string): Promise<void> {
  const { key, stored } = where(form);
  memory.delete(key);
  if (stored) await inOrder(() => idbDelete("kv", key));
}

/** Signing out: every half-filled form on this device goes. */
export async function clearKeptForms(): Promise<void> {
  memory.clear();
  await inOrder(async () => {
    for (const k of await idbKeys("kv")) if (k.startsWith(PREFIX)) await idbDelete("kv", k);
  });
}

/**
 * Keeps `value` while `filled` (a moment after each change, and at once when
 * the page goes away), and drops it when the form is emptied. On opening,
 * `restore` gets what was kept last time. With `enabled` false (a form opened
 * with its own content, such as a correction) nothing is kept or brought back.
 */
export function useKeptForm<T>(form: string, value: T, filled: boolean, restore: (kept: Kept<T>) => void, enabled = true): { ready: boolean; drop: () => void } {
  const [ready, setReady] = useState(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const latest = useRef({ value, filled });
  latest.current = { value, filled };
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadKeptForm<T>(form)
      .then((kept) => {
        if (active && kept && !latest.current.filled) restoreRef.current(kept);
      })
      .catch(() => undefined)
      .finally(() => active && setReady(true));
    return () => {
      active = false;
    };
  }, [form, enabled]);

  const hadContent = useRef(false);
  // Saved: nothing more is kept until the form is emptied and filled again.
  const dropped = useRef(false);
  useEffect(() => {
    if (!ready || !enabled) return;
    if (!filled) {
      if (hadContent.current) void dropKeptForm(form);
      hadContent.current = false;
      dropped.current = false;
      return;
    }
    if (dropped.current) return;
    hadContent.current = true;
    void keepForm(form, value, false);
    const timer = setTimeout(() => void keepForm(form, value), 300);
    return () => clearTimeout(timer);
  }, [form, value, filled, ready, enabled]);

  useEffect(() => {
    const flush = () => {
      if (readyRef.current && enabled && !dropped.current && latest.current.filled) void keepForm(form, latest.current.value);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [form, enabled]);

  return {
    ready,
    drop: () => {
      hadContent.current = false;
      dropped.current = true;
      void dropKeptForm(form);
    },
  };
}
