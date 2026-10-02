import type { BusinessSummary, MeResponse, SessionResponse } from "@digitalbahi/contracts";
import { todayIn } from "@digitalbahi/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyMe, applyWorkspace, loadWorkspace, onPullRequest, pullWorkspace, resetWorkspace, type KeptWorkspace } from "../data/live";
import { LIVE } from "../data/source";
import { api, ApiError, onSessionChange, refreshSession, setSession } from "../lib/api";
import { ensureDevice, removedDevices } from "../offline/device";
import { clearDeviceDocuments, openDeviceDocuments, refreshDeviceDocuments } from "../offline/documents";
import { wipeBusinessCopy } from "../offline/wipe";
import { clearSnapshots, copyExpired, dropUnlockedSnapshots, hasSnapshot, lastSnapshotMeta, loadSnapshot, saveSnapshot, type Snapshot, type SnapshotMeta } from "../offline/snapshot";
import { applyPendingEffects, clearOfflineScope, onSynced, refreshDevice, setOfflineMode, setOfflineScope, syncNow, useOffline } from "../offline/sync";
import { lockVault, passwordOpens, rememberPassword, unlockOnline, unlockWithPassword, vaultOpen } from "../offline/vault";
import { stopPush } from "../platform/push";

/** "locked": no server, and the copy on this device waits for the person's password. */
export type SessionStatus = "loading" | "signed-out" | "no-business" | "ready" | "error" | "locked";

export interface SignupInput {
  name: string;
  mobile: string;
  email?: string;
  password: string;
  otp: string;
  preferredLocale: "en" | "hi";
  business: { legalName: string; stateCode: string; gstin?: string; city?: string };
}

interface SessionValue {
  status: SessionStatus;
  user: SessionResponse["user"] | null;
  businesses: BusinessSummary[];
  me: MeResponse | null;
  error: ApiError | null;
  login(identifier: string, password: string): Promise<void>;
  requestOtp(mobile: string, purpose: "signup" | "login" | "reset"): Promise<{ devCode?: string }>;
  loginWithOtp(mobile: string, otp: string): Promise<void>;
  signup(input: SignupInput): Promise<void>;
  resetPassword(mobile: string, otp: string, password: string): Promise<void>;
  switchBusiness(businessId: string): Promise<void>;
  createBusiness(input: SignupInput["business"]): Promise<void>;
  /** Moves into a session the server already switched (a restored business). */
  adopt(res: SessionResponse): Promise<void>;
  logout(): Promise<void>;
  retry(): void;
  /** Status "locked": whose copy it is, and whether their password can open it here. */
  locked: (SnapshotMeta & { passwordOpens: boolean }) | null;
  /** Opens the locked copy with the person's password. */
  unlock(password: string): Promise<"ok" | "wrong" | "none">;
  /** The owner removed this device: what was deleted from it at start. */
  wiped: { business: string | null; waiting: number } | null;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Online: keeps a copy of the business on this device for offline starts
 * (encrypted, opened with the person's device key from the server),
 * registers the device for offline bills and sends any work waiting.
 */
/** The business as last loaded, with where its pull feed stopped (to bring it up to date with only what changed). */
let kept: KeptWorkspace | undefined;

/** The copy saved on this device for this person and business, opened with the server's device key. */
async function savedCopy(userId: string, businessId: string): Promise<KeptWorkspace | undefined> {
  if (kept) return kept;
  if (!(await unlockOnline(userId))) return undefined;
  const saved = await loadSnapshot(userId, businessId);
  return saved?.feed ? { data: saved.data, feed: saved.feed } : undefined;
}

/** Loads the business (only what changed, when a copy is kept) and remembers it for the next pull. */
async function bringUpToDate(me: MeResponse, userId: string): Promise<KeptWorkspace> {
  const base = await savedCopy(userId, me.business!.id);
  kept = await loadWorkspace(me, base?.data && base.feed ? base : undefined);
  return kept;
}

async function keepOnDevice(res: SessionResponse, me: MeResponse, current: KeptWorkspace, password?: string): Promise<void> {
  const userId = res.user.id;
  const businessId = me.business!.id;
  if (await unlockOnline(userId)) {
    void dropUnlockedSnapshots();
    // Just typed at sign-in: from now on it also opens this copy without internet.
    if (password) await rememberPassword(userId, password).catch(() => false);
  }
  await setOfflineScope(userId, businessId);
  setOfflineMode(false);
  // Bills still waiting (or refused) stay out of the stock and balances just loaded.
  applyPendingEffects();
  // Recent bills for opening and returns without a connection, fetched in the background.
  await openDeviceDocuments(userId, businessId);
  void refreshDeviceDocuments(true);
  void saveSnapshot({ user: res.user, business: res.business ?? me.business!, businesses: res.businesses, me, data: current.data, ...(current.feed ? { feed: current.feed } : {}), savedAt: new Date().toISOString() });
  // Every device that keeps a copy is registered, so the owner can remove it (a series only for those who bill).
  void ensureDevice(userId, businessId).then(refreshDevice);
  void syncNow();
}

/** No server at start: opens the business from the copy on this device. */
async function openSaved(snapshot: Snapshot): Promise<MeResponse> {
  // The saved calendar date may be days old; bills made now carry today's date.
  const me = { ...snapshot.me, today: todayIn(snapshot.me.business!.timeZone) };
  applyMe(me);
  applyWorkspace(snapshot.data);
  // Back online, only what changed since this copy is loaded.
  kept = { data: snapshot.data, ...(snapshot.feed ? { feed: snapshot.feed } : {}) };
  await setOfflineScope(snapshot.user.id, snapshot.business.id);
  setOfflineMode(true);
  applyPendingEffects();
  await openDeviceDocuments(snapshot.user.id, snapshot.business.id);
  return me;
}

/** How often an open app asks what changed. */
const PULL_EVERY_MS = 3 * 60_000;

const offlineSession = (s: Snapshot): SessionResponse => ({ accessToken: "", expiresIn: 0, user: s.user, business: s.business, businesses: s.businesses });

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Who is signed in and in which business. In live mode the session is
 * restored from the refresh cookie on load; the workspace (catalogue,
 * customers, rules) is loaded before the app shows, so billing works at once.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>(LIVE ? "loading" : "ready");
  const [session, setSessionState] = useState<SessionResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [locked, setLocked] = useState<SessionValue["locked"]>(null);
  const [wiped, setWiped] = useState<SessionValue["wiped"]>(null);
  const offlineMode = useRef(false);
  const current = useRef<{ session: SessionResponse | null; me: MeResponse | null }>({ session: null, me: null });
  current.current = { session, me };

  const showSaved = useCallback(async (snapshot: Snapshot) => {
    const profile = await openSaved(snapshot);
    offlineMode.current = true;
    setLocked(null);
    setSessionState(offlineSession(snapshot));
    setMe(profile);
    setError(null);
    setStatus("ready");
  }, []);

  /** No server: opens the copy on this device if it is open already, else asks for the password. */
  const openOffline = useCallback(
    async (meta: SnapshotMeta) => {
      // Too long without connecting: the copy is deleted instead of opened (waiting work stays, encrypted, for the next sign-in).
      if (copyExpired(meta)) {
        await wipeBusinessCopy(meta.userId, meta.businessId, { removedDevice: false });
        setError(new ApiError(0, "OFFLINE_COPY_EXPIRED", { days: meta.wipeAfterDays!, business: meta.businessName }));
        setStatus("error");
        return;
      }
      const saved = vaultOpen(meta.userId) ? await loadSnapshot(meta.userId, meta.businessId) : undefined;
      if (saved) return showSaved(saved);
      setLocked({ ...meta, passwordOpens: await passwordOpens(meta.userId) });
      setError(null);
      setStatus("locked");
    },
    [showSaved],
  );

  const enter = useCallback(
    async (res: SessionResponse | null, password?: string) => {
      setSessionState(res);
      queryClient.clear();
      offlineMode.current = false;
      setLocked(null);
      if (!res) {
        // Signed out (or the session ended): forget the saved business; waiting work stays, locked, for the next sign-in.
        void clearSnapshots();
        void clearDeviceDocuments();
        lockVault();
        clearOfflineScope();
        resetWorkspace();
        kept = undefined;
        setMe(null);
        setStatus("signed-out");
        return;
      }
      if (!res.business) {
        clearOfflineScope();
        resetWorkspace();
        kept = undefined;
        setMe(null);
        setStatus("no-business");
        return;
      }
      setStatus("loading");
      try {
        const profile = await api.get<MeResponse>("/me");
        if (!profile.business) {
          setStatus("no-business");
          return;
        }
        // Another person or business: their copy is not this one.
        if (kept && (current.current.session?.user.id !== res.user.id || current.current.me?.business?.id !== profile.business.id)) kept = undefined;
        const loaded = await bringUpToDate(profile, res.user.id);
        await keepOnDevice(res, profile, loaded, password);
        setMe(profile);
        setError(null);
        setStatus("ready");
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, "generic");
        if (err.code === "network" && (await hasSnapshot(res.user.id, res.business.id))) {
          return openOffline({ userId: res.user.id, businessId: res.business.id, userName: res.user.name, businessName: res.business.tradeName ?? res.business.legalName });
        }
        setError(err);
        setStatus("error");
      }
    },
    [openOffline],
  );

  /**
   * Back online after an offline start: the session is restored, waiting
   * bills go to the server and the workspace reloads in the background (a
   * bill being typed stays on screen).
   */
  const resume = useCallback(async () => {
    let res: SessionResponse | null;
    try {
      res = await refreshSession();
    } catch {
      return; // Still no server.
    }
    if (!offlineMode.current) return;
    const was = current.current.session;
    if (!res || !res.business || res.user.id !== was?.user.id || res.business.id !== was.business?.id) return enter(res);
    try {
      const profile = await api.get<MeResponse>("/me");
      const loaded = await bringUpToDate(profile, res.user.id);
      offlineMode.current = false;
      await keepOnDevice(res, profile, loaded);
      setSessionState(res);
      setMe(profile);
      void queryClient.invalidateQueries();
    } catch {
      // Lost again on the way; the next attempt picks it up.
    }
  }, [enter]);

  useEffect(() => {
    if (!LIVE) return;
    let cancelled = false;
    // A device the owner removed deletes its copy and waiting work first (it asks the server, signed in or not).
    void removedDevices()
      .then(async (removed) => {
        if (!removed.length) return;
        const last = await lastSnapshotMeta();
        let waiting = 0;
        let business: string | null = null;
        for (const d of removed) {
          if (last?.userId === d.userId && last.businessId === d.businessId) business = last.businessName;
          waiting += await wipeBusinessCopy(d.userId, d.businessId, { removedDevice: true });
        }
        if (!cancelled) setWiped({ business, waiting });
      })
      .catch(() => undefined)
      .then(() => (cancelled ? Promise.reject(new Error("cancelled")) : refreshSession()))
      .then(
      (res) => {
        if (!cancelled) void enter(res);
      },
      async (e: unknown) => {
        if (cancelled) return;
        const err = e instanceof ApiError ? e : new ApiError(0, "network");
        // No server: open the business saved on this device, if there is one (with the password).
        const saved = err.code === "network" ? await lastSnapshotMeta() : undefined;
        if (cancelled) return;
        if (saved) return openOffline(saved);
        setError(err);
        setStatus("error");
      },
    );
    // A failed background refresh (session revoked, cookie expired) signs out everywhere.
    const off = onSessionChange((res) => {
      if (!res) {
        void clearSnapshots();
        void clearDeviceDocuments();
        lockVault();
        clearOfflineScope();
        offlineMode.current = false;
        setSessionState(null);
        setStatus("signed-out");
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [enter, openOffline, attempt]);

  // Started without a network (or waiting for the password): try again as soon as the connection is back.
  useEffect(() => {
    if (status !== "locked" && (status !== "error" || error?.code !== "network")) return;
    const again = () => setAttempt((n) => n + 1);
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [status, error]);

  // Working from the saved copy: look for the server when the network returns, and every 30 seconds.
  const { offlineMode: fromSavedCopy } = useOffline();
  const offline = status === "ready" && fromSavedCopy;
  useEffect(() => {
    if (!offline) return;
    const again = () => void resume();
    window.addEventListener("online", again);
    const timer = setInterval(again, 30_000);
    return () => {
      window.removeEventListener("online", again);
      clearInterval(timer);
    };
  }, [offline, resume]);

  // Bills sent: reload stock and balances from the server (keeping the copy on the device current).
  useEffect(
    () =>
      onSynced(() => {
        const { session: s, me: m } = current.current;
        if (!s || !m || offlineMode.current) return;
        void bringUpToDate(m, s.user.id)
          .then((loaded) => keepOnDevice(s, m, loaded))
          .then(() => queryClient.invalidateQueries())
          .catch(() => undefined);
      }),
    [],
  );

  // While online: what others changed (prices, stock, balances, new customers) comes every few minutes, when the app is shown again and when a notification arrives.
  useEffect(() => {
    if (!LIVE) return;
    let running = false;
    const pull = async () => {
      const { session: s, me: m } = current.current;
      if (running || !s?.business || !m?.business || offlineMode.current || !kept?.feed || document.visibilityState !== "visible") return;
      running = true;
      try {
        const next = await pullWorkspace(kept);
        if (!next) {
          kept = await loadWorkspace(m);
        } else {
          kept = { data: next.data, ...(next.feed ? { feed: next.feed } : {}) };
          if (!next.changed) return;
          applyWorkspace(next.data);
        }
        applyPendingEffects();
        void saveSnapshot({ user: s.user, business: s.business, businesses: s.businesses, me: m, data: kept.data, ...(kept.feed ? { feed: kept.feed } : {}), savedAt: new Date().toISOString() });
      } catch {
        // No connection just now: the next round tries again.
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void pull(), PULL_EVERY_MS);
    const shown = () => {
      if (document.visibilityState === "visible") void pull();
    };
    document.addEventListener("visibilitychange", shown);
    const asked = onPullRequest(() => void pull());
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
      asked();
    };
  }, []);

  /**
   * Moves into a session. With the password the person just typed, their
   * copy on this device can then also be opened with it without internet.
   */
  const withSession = useCallback(
    async (call: () => Promise<SessionResponse>, password?: string) => {
      const res = await call();
      setSession(res);
      await enter(res, password);
    },
    [enter],
  );

  const unlock = useCallback(
    async (password: string): Promise<"ok" | "wrong" | "none"> => {
      if (!locked) return "none";
      const result = await unlockWithPassword(locked.userId, password);
      if (result !== "ok") return result;
      const saved = await loadSnapshot(locked.userId, locked.businessId);
      if (!saved) return "none";
      await showSaved(saved);
      return "ok";
    },
    [locked, showSaved],
  );

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user: session?.user ?? null,
      businesses: session?.businesses ?? [],
      me,
      error,
      locked,
      unlock,
      wiped,
      login: (identifier, password) => withSession(() => api.post<SessionResponse>("/auth/login", { identifier, password }), password),
      requestOtp: (mobile, purpose) => api.post<{ devCode?: string }>("/auth/otp", { mobile, purpose }),
      loginWithOtp: (mobile, otp) => withSession(() => api.post<SessionResponse>("/auth/login/otp", { mobile, otp })),
      signup: (input) => withSession(() => api.post<SessionResponse>("/auth/signup", input), input.password),
      resetPassword: async (mobile, otp, password) => {
        await api.post("/auth/password/reset", { mobile, otp, password });
      },
      switchBusiness: (businessId) => withSession(() => api.post<SessionResponse>("/auth/switch-business", { businessId })),
      createBusiness: (input) => withSession(() => api.post<SessionResponse>("/businesses", input)),
      adopt: (res) => withSession(() => Promise.resolve(res)),
      logout: async () => {
        // Signing out needs the server (it ends the session there too); the caller checks for a connection.
        try {
          // In the Android app: this phone stops getting the person's notifications.
          await stopPush();
          await api.post("/auth/logout");
        } finally {
          setSession(null);
          await enter(null);
        }
      },
      retry: () => setAttempt((n) => n + 1),
    }),
    [status, session, me, error, locked, unlock, wiped, withSession, enter],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
    </QueryClientProvider>
  );
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
