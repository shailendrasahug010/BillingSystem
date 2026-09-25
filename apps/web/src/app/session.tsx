import type { BusinessSummary, MeResponse, SessionResponse } from "@vyapaar/contracts";
import { todayIn } from "@vyapaar/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyMe, applyWorkspace, hydrateWorkspace, resetWorkspace, type WorkspaceData } from "../data/live";
import { LIVE } from "../data/source";
import { api, ApiError, onSessionChange, refreshSession, setSession } from "../lib/api";
import { ensureDevice } from "../offline/device";
import { clearSnapshots, loadLastSnapshot, loadSnapshot, saveSnapshot, type Snapshot } from "../offline/snapshot";
import { applyPendingEffects, clearOfflineScope, onSynced, refreshDevice, setOfflineMode, setOfflineScope, syncNow, useOffline } from "../offline/sync";

export type SessionStatus = "loading" | "signed-out" | "no-business" | "ready" | "error";

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
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Online: keeps a copy of the business on this device for offline starts,
 * registers the device for offline bills and sends any bills waiting.
 */
async function keepOnDevice(res: SessionResponse, me: MeResponse, data: WorkspaceData): Promise<void> {
  const userId = res.user.id;
  const businessId = me.business!.id;
  await setOfflineScope(userId, businessId);
  setOfflineMode(false);
  // Bills still waiting (or refused) stay out of the stock and balances just loaded.
  applyPendingEffects();
  void saveSnapshot({ user: res.user, business: res.business ?? me.business!, businesses: res.businesses, me, data, savedAt: new Date().toISOString() });
  if (me.permissions.includes("invoice.create")) void ensureDevice(userId, businessId).then(refreshDevice);
  void syncNow();
}

/** No server at start: opens the business from the copy on this device. */
async function openSaved(snapshot: Snapshot): Promise<MeResponse> {
  // The saved calendar date may be days old; bills made now carry today's date.
  const me = { ...snapshot.me, today: todayIn(snapshot.me.business!.timeZone) };
  applyMe(me);
  applyWorkspace(snapshot.data);
  await setOfflineScope(snapshot.user.id, snapshot.business.id);
  setOfflineMode(true);
  applyPendingEffects();
  return me;
}

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
  const offlineMode = useRef(false);
  const current = useRef<{ session: SessionResponse | null; me: MeResponse | null }>({ session: null, me: null });
  current.current = { session, me };

  const showSaved = useCallback(async (snapshot: Snapshot) => {
    const profile = await openSaved(snapshot);
    offlineMode.current = true;
    setSessionState(offlineSession(snapshot));
    setMe(profile);
    setError(null);
    setStatus("ready");
  }, []);

  const enter = useCallback(
    async (res: SessionResponse | null) => {
      setSessionState(res);
      queryClient.clear();
      offlineMode.current = false;
      if (!res) {
        // Signed out (or the session ended): forget the saved business; waiting bills stay for the next sign-in.
        void clearSnapshots();
        clearOfflineScope();
        resetWorkspace();
        setMe(null);
        setStatus("signed-out");
        return;
      }
      if (!res.business) {
        clearOfflineScope();
        resetWorkspace();
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
        const data = await hydrateWorkspace(profile);
        await keepOnDevice(res, profile, data);
        setMe(profile);
        setError(null);
        setStatus("ready");
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, "generic");
        const saved = err.code === "network" ? await loadSnapshot(res.user.id, res.business.id) : undefined;
        if (saved) return showSaved(saved);
        setError(err);
        setStatus("error");
      }
    },
    [showSaved],
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
      const data = await hydrateWorkspace(profile);
      offlineMode.current = false;
      await keepOnDevice(res, profile, data);
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
    void refreshSession().then(
      (res) => {
        if (!cancelled) void enter(res);
      },
      async (e: unknown) => {
        if (cancelled) return;
        const err = e instanceof ApiError ? e : new ApiError(0, "network");
        // No server: open the business saved on this device, if there is one.
        const saved = err.code === "network" ? await loadLastSnapshot() : undefined;
        if (cancelled) return;
        if (saved?.business) return showSaved(saved);
        setError(err);
        setStatus("error");
      },
    );
    // A failed background refresh (session revoked, cookie expired) signs out everywhere.
    const off = onSessionChange((res) => {
      if (!res) {
        void clearSnapshots();
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
  }, [enter, showSaved, attempt]);

  // Started without a network: try again as soon as the connection is back.
  useEffect(() => {
    if (status !== "error" || error?.code !== "network") return;
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
        void hydrateWorkspace(m)
          .then((data) => keepOnDevice(s, m, data))
          .then(() => queryClient.invalidateQueries())
          .catch(() => undefined);
      }),
    [],
  );

  const withSession = useCallback(
    async (call: () => Promise<SessionResponse>) => {
      const res = await call();
      setSession(res);
      await enter(res);
    },
    [enter],
  );

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user: session?.user ?? null,
      businesses: session?.businesses ?? [],
      me,
      error,
      login: (identifier, password) => withSession(() => api.post<SessionResponse>("/auth/login", { identifier, password })),
      requestOtp: (mobile, purpose) => api.post<{ devCode?: string }>("/auth/otp", { mobile, purpose }),
      loginWithOtp: (mobile, otp) => withSession(() => api.post<SessionResponse>("/auth/login/otp", { mobile, otp })),
      signup: (input) => withSession(() => api.post<SessionResponse>("/auth/signup", input)),
      resetPassword: async (mobile, otp, password) => {
        await api.post("/auth/password/reset", { mobile, otp, password });
      },
      switchBusiness: (businessId) => withSession(() => api.post<SessionResponse>("/auth/switch-business", { businessId })),
      createBusiness: (input) => withSession(() => api.post<SessionResponse>("/businesses", input)),
      adopt: (res) => withSession(() => Promise.resolve(res)),
      logout: async () => {
        // Signing out needs the server (it ends the session there too); the caller checks for a connection.
        try {
          await api.post("/auth/logout");
        } finally {
          setSession(null);
          await enter(null);
        }
      },
      retry: () => setAttempt((n) => n + 1),
    }),
    [status, session, me, error, withSession, enter],
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
