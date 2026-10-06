import type { SessionResponse } from "@digitalbahi/contracts";
import { isNative, nativePlugin } from "../platform/native";
import { serverOrigin } from "../platform/server";
import { uuid } from "./uuid";

/**
 * HTTP client for the Digital Bahi API. The access token lives only in memory; the
 * refresh token is an HttpOnly cookie the browser sends to /api/v1/auth, so no
 * script can read either from storage. A 401 triggers one shared refresh and
 * a retry; concurrent requests wait for the same refresh.
 *
 * In the Android app the pages come from the app and the API from the
 * business's server (its address asked for on first start): requests say
 * `X-Client: native`, carry no cookies, and the refresh token comes in the
 * body, kept in the phone's keystore-backed storage.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Record<string, string | number> = {},
    readonly field?: string,
    readonly details?: Array<{ field: string; code: string; params?: Record<string, string | number> }>,
    /** The server's reference for this request (its line in the error log, for a server failure). */
    readonly requestId?: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

let accessToken: string | null = null;
let refreshing: Promise<SessionResponse | null> | null = null;
const sessionListeners = new Set<(session: SessionResponse | null) => void>();

export function onSessionChange(listener: (session: SessionResponse | null) => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** The signed-in person's access token, for the error reporter (which avoids this client to never loop). */
export function currentAccessToken(): string | null {
  return accessToken;
}

interface SecureStore {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
}
const REFRESH_KEY = "refreshToken";
const secureStore = () => nativePlugin<SecureStore>("SecureStore");
/** The app's last write of the refresh token: a refresh reads it only after. */
let keeping: Promise<unknown> = Promise.resolve();

const native = () => isNative();
const credentials = (): RequestCredentials => (native() ? "omit" : "same-origin");
const clientHeaders = (): Record<string, string> => (native() ? { "x-client": "native" } : {});

/** Called with every login / refresh / switch response (null = signed out). */
export function setSession(session: SessionResponse | null): void {
  accessToken = session?.accessToken ?? null;
  const store = native() ? secureStore() : null;
  if (store && session === null) keeping = store.remove({ key: REFRESH_KEY }).catch(() => undefined);
  else if (store && session?.refreshToken) keeping = store.set({ key: REFRESH_KEY, value: session.refreshToken }).catch(() => undefined);
  // The refresh token stays here, out of the rest of the app.
  const shared = session && "refreshToken" in session ? (({ refreshToken: _, ...rest }) => rest)(session) : session;
  for (const l of sessionListeners) l(shared);
}

/** In the app: the refresh token kept on the phone (null when signed out). */
async function storedRefreshToken(): Promise<string | null> {
  await keeping;
  return (await secureStore()?.get({ key: REFRESH_KEY }).catch(() => null))?.value ?? null;
}

type Query = Record<string, string | number | boolean | null | undefined>;

function url(path: string, query?: Query): string {
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  return `${serverOrigin()}/api/v1${path}${qs ? `?${qs}` : ""}`;
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") ?? "";
  return type.includes("application/json") ? res.json() : res.text();
}

function toError(status: number, body: unknown): ApiError {
  const e = (body as { error?: { code?: string; params?: Record<string, string | number>; field?: string; details?: ApiError["details"]; requestId?: string } } | null)?.error;
  return new ApiError(status, e?.code ?? (status === 0 ? "network" : "generic"), e?.params ?? {}, e?.field, e?.details, e?.requestId);
}

/** Exchanges the refresh cookie for a new session. Shared by every caller that hits a 401. */
export function refreshSession(): Promise<SessionResponse | null> {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let body = "{}";
      if (native()) {
        const token = await storedRefreshToken();
        if (!token) break;
        body = JSON.stringify({ refreshToken: token });
      }
      let res: Response;
      try {
        res = await fetch(url("/auth/refresh"), { method: "POST", credentials: credentials(), headers: { "content-type": "application/json", ...clientHeaders() }, body });
      } catch {
        // No network: the session is not known to be over, so keep it.
        throw new ApiError(0, "network");
      }
      const answer = await parse(res);
      if (res.ok) {
        setSession(answer as SessionResponse);
        return answer as SessionResponse;
      }
      // Another tab rotated the cookie a moment ago: the browser now holds the new one.
      if (toError(res.status, answer).code !== "REFRESH_ROTATED") break;
    }
    setSession(null);
    return null;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** How long a save waits for the server before it is kept on the device instead. */
export const QUICK_SAVE_MS = 8_000;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Makes a POST safe to retry: the server returns the first result for the same key. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /**
   * Give up after this long without an answer and fail as "network" (as if the
   * connection had dropped). For saves that can be kept on the device and sent
   * again with the same Idempotency-Key: a weak signal then costs seconds, not minutes.
   */
  timeoutMs?: number;
  /** Return the response as a Blob (PDF and other files). */
  raw?: boolean;
  /** Send a file as it is (application/octet-stream) instead of JSON. */
  file?: Blob;
  headers?: Record<string, string>;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}, retried = false): Promise<T> {
  // A refresh under way brings the token this request needs: without it, the request would only get a 401 and wait for it anyway.
  if (refreshing && !path.startsWith("/auth/")) await refreshing.catch(() => null);
  const headers: Record<string, string> = { ...clientHeaders(), ...options.headers };
  if (options.file) headers["content-type"] = "application/octet-stream";
  else if (options.body !== undefined) headers["content-type"] = "application/json";
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  let res: Response;
  const timer = options.timeoutMs ? new AbortController() : null;
  const timeout = timer ? setTimeout(() => timer.abort(), options.timeoutMs) : undefined;
  const signal = timer && options.signal ? AbortSignal.any([timer.signal, options.signal]) : (timer?.signal ?? options.signal);
  try {
    res = await fetch(url(path, options.query), {
      method,
      headers,
      credentials: credentials(),
      ...(options.file ? { body: options.file } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError" && !timer?.signal.aborted) throw e;
    throw new ApiError(0, "network");
  } finally {
    clearTimeout(timeout);
  }
  if (options.raw && res.ok) return (await res.blob()) as T;
  const body = await parse(res);
  if (res.status === 401 && !retried && !path.startsWith("/auth/")) {
    const session = await refreshSession();
    if (session) return request<T>(method, path, options, true);
  }
  if (!res.ok) throw toError(res.status, body);
  return body as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>("GET", path, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) }),
  /** A file from the API (PDF exports). */
  blob: (path: string, query?: Query) => request<Blob>("GET", path, { ...(query ? { query } : {}), raw: true }),
  post: <T>(path: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}) => request<T>("POST", path, { ...options, body: body ?? {} }),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, { body }),
  patch: <T>(path: string, body: unknown, options: Omit<RequestOptions, "body"> = {}) => request<T>("PATCH", path, { ...options, body }),
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body === undefined ? {} : { body }),
  /** Uploads a file as it is (backups). */
  upload: <T>(path: string, file: Blob, options: { query?: Query; headers?: Record<string, string> } = {}) => request<T>("POST", path, { file, ...options }),
};

/**
 * Reads a server-sent event stream (EventSource cannot send the access token,
 * so this uses fetch). Calls `onEvent` for each event and resolves when the
 * server ends the stream; a 401 refreshes the session once, as requests do.
 */
export async function readEventStream(path: string, onEvent: (event: string, data: string) => void, signal: AbortSignal): Promise<void> {
  for (let retried = false; ; retried = true) {
    const headers: Record<string, string> = { accept: "text/event-stream", ...clientHeaders() };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    let res: Response;
    try {
      res = await fetch(url(path), { headers, credentials: credentials(), cache: "no-store", signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new ApiError(0, "network");
    }
    if (res.status === 401 && !retried && (await refreshSession())) continue;
    if (!res.ok || !res.body) throw toError(res.status, await parse(res).catch(() => null));
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value.replace(/\r\n?/g, "\n");
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length) onEvent(event, data.join("\n"));
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new ApiError(0, "network");
    } finally {
      reader.releaseLock();
    }
  }
}

/** Fetches every page of a keyset-paginated list (small master lists: customers, suppliers). */
export async function fetchAll<T>(path: string, query: Query = {}, pageSize = 200): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: T[]; nextCursor: string | null } = await api.get(path, { ...query, limit: pageSize, cursor });
    out.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export function newIdempotencyKey(): string {
  return uuid();
}
