import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PurchaseDraft } from "../features/purchases/billImport";

/**
 * Minimal screen router for the prototype. The production app uses TanStack
 * Router (typed routes, loaders, code-splitting per module); screens only call
 * `navigate(...)`, so swapping the implementation does not touch them.
 */
export type Route =
  | { name: "login" }
  | { name: "dashboard" }
  | { name: "invoice-new"; customerId?: string }
  /** Every sales bill, with filters (date, payment, status, search). */
  | { name: "invoices" }
  /** print: open the print dialog once the bill is shown (Save & print). */
  | { name: "invoice-view"; invoiceId: string; print?: boolean }
  | { name: "customers" }
  | { name: "customer"; customerId: string }
  /** Money to collect, by city and route (collectors). */
  | { name: "outstanding" }
  /** Today's beat: the salesperson's routes and shops (Phase 5.4). */
  | { name: "beat" }
  | { name: "products" }
  | { name: "settings" }
  | { name: "design-system" }
  | { name: "purchase-new"; supplierId?: string; draft?: PurchaseDraft }
  | { name: "purchase-view"; purchaseId: string }
  | { name: "supplier"; supplierId: string }
  | { name: "order-view"; orderId: string }
  /** Module screens; live mode renders the real screen, demo mode the plan. */
  | { name: "planned"; module: PlannedModule; action?: "collect" | "pay" | "new"; partyId?: string };

export type PlannedModule =
  | "suppliers"
  | "orders"
  | "purchases"
  | "packing"
  | "dispatch"
  | "inventory"
  | "payments"
  | "employees"
  | "payroll"
  | "leave"
  | "gst"
  | "reports"
  | "productReports"
  | "companyReports"
  | "expenses"
  | "notifications"
  | "users"
  | "audit"
  | "messages"
  | "backup";

interface RouterValue {
  route: Route;
  navigate(route: Route): void;
}

const RouterContext = createContext<RouterValue | null>(null);

/** Top-level screens are reachable by a plain #token so a shared link can open them. */
const HASH_ROUTES: Record<string, Route> = {
  dashboard: { name: "dashboard" },
  invoice: { name: "invoice-new" },
  invoices: { name: "invoices" },
  customers: { name: "customers" },
  outstanding: { name: "outstanding" },
  beat: { name: "beat" },
  products: { name: "products" },
  settings: { name: "settings" },
  design: { name: "design-system" },
  login: { name: "login" },
};

function routeFromHash(): Route | null {
  const token = window.location.hash.replace(/^#/, "");
  return HASH_ROUTES[token] ?? null;
}

function hashFor(route: Route): string | null {
  const entry = Object.entries(HASH_ROUTES).find(([, r]) => r.name === route.name);
  return entry ? entry[0] : null;
}

/** Back to the screen before (the Android app's back button); false when there is none. */
let backFn: (() => boolean) | null = null;
export const goBack = (): boolean => backFn?.() ?? false;

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => routeFromHash() ?? { name: "dashboard" });
  const current = useRef(route);
  // The screens left, newest last.
  const left = useRef<Route[]>([]);

  const show = useCallback((next: Route) => {
    current.current = next;
    setRoute(next);
    const token = hashFor(next);
    try {
      history.replaceState(null, "", token ? `#${token}` : window.location.pathname);
    } catch {
      /* sandboxed frames may refuse history access */
    }
    window.scrollTo({ top: 0 });
  }, []);

  const navigate = useCallback(
    (next: Route) => {
      left.current = [...left.current, current.current].slice(-30);
      show(next);
    },
    [show],
  );

  useEffect(() => {
    backFn = () => {
      const previous = left.current.pop();
      if (!previous) return false;
      show(previous);
      return true;
    };
    return () => {
      backFn = null;
    };
  }, [show]);

  useEffect(() => {
    // A link to a screen (#customers) is a step like any other: back returns from it.
    const onHash = () => {
      const r = routeFromHash();
      if (!r) return;
      left.current = [...left.current, current.current].slice(-30);
      current.current = r;
      setRoute(r);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return <RouterContext.Provider value={{ route, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used inside RouterProvider");
  return ctx;
}
