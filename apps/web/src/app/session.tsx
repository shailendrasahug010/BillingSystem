import type { BusinessSummary, MeResponse, SessionResponse } from "@vyapaar/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { hydrateWorkspace, resetWorkspace } from "../data/live";
import { LIVE } from "../data/source";
import { api, ApiError, onSessionChange, refreshSession, setSession } from "../lib/api";

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
  logout(): Promise<void>;
  retry(): void;
}

const SessionContext = createContext<SessionValue | null>(null);

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

  const enter = useCallback(async (res: SessionResponse | null) => {
    setSessionState(res);
    queryClient.clear();
    if (!res) {
      resetWorkspace();
      setMe(null);
      setStatus("signed-out");
      return;
    }
    if (!res.business) {
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
      await hydrateWorkspace(profile);
      setMe(profile);
      setError(null);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (!LIVE) return;
    let cancelled = false;
    void refreshSession().then(
      (res) => {
        if (!cancelled) void enter(res);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e : new ApiError(0, "network"));
        setStatus("error");
      },
    );
    // A failed background refresh (session revoked, cookie expired) signs out everywhere.
    const off = onSessionChange((res) => {
      if (!res) {
        setSessionState(null);
        setStatus("signed-out");
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [enter, attempt]);

  // Started without a network: try again as soon as the connection is back.
  useEffect(() => {
    if (status !== "error" || error?.code !== "network") return;
    const again = () => setAttempt((n) => n + 1);
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [status, error]);

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
      logout: async () => {
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
