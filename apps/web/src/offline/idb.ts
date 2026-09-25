/**
 * The device's own storage (IndexedDB): a key-value store for the saved
 * workspace and the device record, and the queue of bills made offline.
 * Every call fails soft (private windows, blocked storage): the app then
 * simply works online-only.
 */
const DB_NAME = "digital-bahi";
const VERSION = 1;
export type StoreName = "kv" | "outbox";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e: unknown) => {
    opening = null;
    throw e;
  });
  return opening;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  try {
    return (await run<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>)) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function idbAll<T>(store: StoreName): Promise<T[]> {
  try {
    return ((await run<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>)) ?? []) as T[];
  } catch {
    return [];
  }
}

/** Writes a value; `key` is omitted for the outbox (its rows carry their id). Returns false if storage is unavailable. */
export async function idbPut(store: StoreName, value: unknown, key?: string): Promise<boolean> {
  try {
    await run(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key)));
    return true;
  } catch {
    return false;
  }
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  try {
    await run(store, "readwrite", (s) => s.delete(key));
  } catch {
    // Nothing stored, nothing to remove.
  }
}

export async function idbKeys(store: StoreName): Promise<string[]> {
  try {
    return ((await run<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys())) ?? []).map(String);
  } catch {
    return [];
  }
}
