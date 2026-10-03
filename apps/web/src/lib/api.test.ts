import { afterEach, describe, expect, it, vi } from "vitest";
import { api, refreshSession, setSession } from "./api";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api client and the session refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("sends a request made during a refresh with the new token, not to a 401 first", async () => {
    let finishRefresh!: () => void;
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization ?? null });
      if (url.endsWith("/auth/refresh")) {
        await new Promise<void>((r) => (finishRefresh = r));
        return json(200, { accessToken: "fresh" });
      }
      return (init.headers as Record<string, string>).authorization === "Bearer fresh" ? json(200, { data: [] }) : json(401, { error: { code: "UNAUTHENTICATED" } });
    });

    const refresh = refreshSession();
    const list = api.get<{ data: unknown[] }>("/customers");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    finishRefresh();
    await refresh;
    expect(await list).toEqual({ data: [] });
    expect(calls).toEqual([
      { url: "/api/v1/auth/refresh", auth: null },
      { url: "/api/v1/customers", auth: "Bearer fresh" },
    ]);
  });

  it("still refreshes once and retries when the token has expired", async () => {
    setSession({ accessToken: "old" } as never);
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization ?? "";
      calls.push(`${url} ${auth}`.trim());
      if (url.endsWith("/auth/refresh")) return json(200, { accessToken: "new" });
      return auth === "Bearer new" ? json(200, { ok: true }) : json(401, { error: { code: "TOKEN_EXPIRED" } });
    });
    const both = await Promise.all([api.get("/a"), api.get("/b")]);
    expect(both).toEqual([{ ok: true }, { ok: true }]);
    // One refresh for both.
    expect(calls.filter((c) => c.includes("/auth/refresh"))).toHaveLength(1);
  });
});
