import type { SessionResponse } from "@vyapaar/contracts";

/**
 * HTTP client for the Digital Bahi API. The access token lives only in memory; the
 * refresh token is an HttpOnly cookie the browser sends to /api/v1/auth, so no
 * script can read either from storage. A 401 triggers one shared refresh and
 * a retry; concurrent requests wait for the same refresh.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Record<string, string | number> = {},
    readonly field?: string,
    readonly details?: Array<{ field: string; code: string; params?: Record<string, string | number> }>,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

const BASE = "/api/v1";
let accessToken: string | null = null;
let refreshing: Promise<SessionResponse | null> | null = null;
const sessionListeners = new Set<(session: SessionResponse | null) => void>();

export function onSessionChange(listener: (session: SessionResponse | null) => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** Called with every login / refresh / switch response (null = signed out). */
export function setSession(session: SessionResponse | null): void {
  accessToken = session?.accessToken ?? null;
  for (const l of sessionListeners) l(session);
}

type Query = Record<string, string | number | boolean | null | undefined>;

function url(path: string, query?: Query): string {
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  return `${BASE}${path}${qs ? `?${qs}` : ""}`;
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") ?? "";
  return type.includes("application/json") ? res.json() : res.text();
}

function toError(status: number, body: unknown): ApiError {
  const e = (body as { error?: { code?: string; params?: Record<string, string | number>; field?: string; details?: ApiError["details"] } } | null)?.error;
  return new ApiError(status, e?.code ?? (status === 0 ? "network" : "generic"), e?.params ?? {}, e?.field, e?.details);
}

/** Exchanges the refresh cookie for a new session. Shared by every caller that hits a 401. */
export function refreshSession(): Promise<SessionResponse | null> {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetch(url("/auth/refresh"), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
      } catch {
        // No network: the session is not known to be over, so keep it.
        throw new ApiError(0, "network");
      }
      const body = await parse(res);
      if (res.ok) {
        setSession(body as SessionResponse);
        return body as SessionResponse;
      }
      // Another tab rotated the cookie a moment ago: the browser now holds the new one.
      if (toError(res.status, body).code !== "REFRESH_ROTATED") break;
    }
    setSession(null);
    return null;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Makes a POST safe to retry: the server returns the first result for the same key. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Return the response as a Blob (PDF and other files). */
  raw?: boolean;
  /** Send a file as it is (application/octet-stream) instead of JSON. */
  file?: Blob;
  headers?: Record<string, string>;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.file) headers["content-type"] = "application/octet-stream";
  else if (options.body !== undefined) headers["content-type"] = "application/json";
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url(path, options.query), {
      method,
      headers,
      credentials: "same-origin",
      ...(options.file ? { body: options.file } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network");
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
  delete: <T>(path: string) => request<T>("DELETE", path),
  /** Uploads a file as it is (backups). */
  upload: <T>(path: string, file: Blob, options: { query?: Query; headers?: Record<string, string> } = {}) => request<T>("POST", path, { file, ...options }),
};

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
  return crypto.randomUUID();
}
