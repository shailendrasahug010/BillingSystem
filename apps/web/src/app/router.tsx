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
  /** The signed-in person's own name, email and password. */
  | { name: "profile" }
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
  /** Opens a screen as a new step (the browser's Back returns from it); replace: in place of this one. */
  navigate(route: Route, options?: { replace?: boolean }): void;
  /** Whether the screen open now came forward (opened) or back (the browser's Back): phones slide it in from that side. */
  direction: "forward" | "back";
}

const RouterContext = createContext<RouterValue | null>(null);

const PLANNED_MODULES: readonly PlannedModule[] = [
  "suppliers",
  "orders",
  "purchases",
  "packing",
  "dispatch",
  "inventory",
  "payments",
  "employees",
  "payroll",
  "leave",
  "gst",
  "reports",
  "productReports",
  "companyReports",
  "expenses",
  "notifications",
  "users",
  "audit",
  "messages",
  "backup",
];

/** Screens without a record, reachable by a plain #token (the links shared before stay valid). */
const SIMPLE_ROUTES: Record<string, Route> = {
  dashboard: { name: "dashboard" },
  invoice: { name: "invoice-new" },
  invoices: { name: "invoices" },
  customers: { name: "customers" },
  outstanding: { name: "outstanding" },
  beat: { name: "beat" },
  products: { name: "products" },
  settings: { name: "settings" },
  profile: { name: "profile" },
  design: { name: "design-system" },
  login: { name: "login" },
  "purchase-new": { name: "purchase-new" },
};

/** Screens of one record: #<token>/<id>. */
const RECORD_ROUTES = {
  invoice: (id: string): Route => ({ name: "invoice-view", invoiceId: id }),
  customer: (id: string): Route => ({ name: "customer", customerId: id }),
  purchase: (id: string): Route => ({ name: "purchase-view", purchaseId: id }),
  supplier: (id: string): Route => ({ name: "supplier", supplierId: id }),
  order: (id: string): Route => ({ name: "order-view", orderId: id }),
} satisfies Record<string, (id: string) => Route>;

/**
 * The screen a link names: #customers, #invoice/<id>, #payments, #payments/collect/<partyId>,
 * #invoice/new/<customerId>, #purchase-new/<supplierId>. Null for anything else.
 */
export function routeFromHash(hash: string): Route | null {
  const [token = "", ...rest] = hash
    .replace(/^#\/?/, "")
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const [a, b] = rest;
  if (token === "invoice" && a === "new") return b ? { name: "invoice-new", customerId: b } : { name: "invoice-new" };
  if (token === "purchase-new" && a) return { name: "purchase-new", supplierId: a };
  if (!a && token in SIMPLE_ROUTES) return SIMPLE_ROUTES[token]!;
  if (a && token in RECORD_ROUTES) return RECORD_ROUTES[token as keyof typeof RECORD_ROUTES](a);
  const module = PLANNED_MODULES.find((m) => m === token);
  if (!module) return null;
  if (a === "collect" || a === "pay" || a === "new") return { name: "planned", module, action: a, ...(b ? { partyId: b } : {}) };
  return a ? { name: "planned", module, partyId: a } : { name: "planned", module };
}

/** The link of a screen (what routeFromHash reads back). */
export function hashFor(route: Route): string {
  const id = (v: string) => encodeURIComponent(v);
  switch (route.name) {
    case "invoice-new":
      return route.customerId ? `#invoice/new/${id(route.customerId)}` : "#invoice";
    case "invoice-view":
      return `#invoice/${id(route.invoiceId)}`;
    case "customer":
      return `#customer/${id(route.customerId)}`;
    case "purchase-new":
      return route.supplierId ? `#purchase-new/${id(route.supplierId)}` : "#purchase-new";
    case "purchase-view":
      return `#purchase/${id(route.purchaseId)}`;
    case "supplier":
      return `#supplier/${id(route.supplierId)}`;
    case "order-view":
      return `#order/${id(route.orderId)}`;
    case "planned":
      return `#${route.module}${route.action ? `/${route.action}` : ""}${route.partyId ? `/${id(route.partyId)}` : ""}`;
    default:
      return `#${Object.entries(SIMPLE_ROUTES).find(([, r]) => r.name === route.name)?.[0] ?? "dashboard"}`;
  }
}

/** What each browser history entry of the app keeps: its screen and how many steps in it is. */
interface HistoryState {
  digitalbahi: true;
  route: Route;
  step: number;
}

const isOurs = (state: unknown): state is HistoryState => typeof state === "object" && state !== null && (state as HistoryState).digitalbahi === true;

/** A screen as it is kept in history: opening the print dialog is for this visit only. */
function kept(route: Route): Route {
  if (route.name === "invoice-view" && route.print) return { name: "invoice-view", invoiceId: route.invoiceId };
  return route;
}

function writeHistory(mode: "push" | "replace", route: Route, step: number) {
  const state: HistoryState = { digitalbahi: true, route: kept(route), step };
  try {
    if (mode === "push") history.pushState(state, "", hashFor(route));
    else history.replaceState(state, "", hashFor(route));
  } catch {
    /* sandboxed frames may refuse history access */
  }
}

/** The screen to open at start: the one this history entry kept (a reload), else the link's. */
function startRoute(): { route: Route; step: number } {
  const state: unknown = history.state;
  if (isOurs(state) && hashFor(state.route) === hashFor(routeFromHash(window.location.hash) ?? state.route)) return { route: state.route, step: state.step };
  return { route: routeFromHash(window.location.hash) ?? { name: "dashboard" }, step: 0 };
}

/** Back to the screen before (the Android app's back button); false when there is none. */
let backFn: (() => boolean) | null = null;
export const goBack = (): boolean => backFn?.() ?? false;

export function RouterProvider({ children }: { children: ReactNode }) {
  const [start] = useState(startRoute);
  const [route, setRoute] = useState<Route>(start.route);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  // How many of the app's screens lie behind this one in the browser's history.
  const step = useRef(start.step);

  useEffect(() => {
    writeHistory("replace", start.route, start.step);
  }, [start]);

  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    // The screen already open (its menu entry clicked again) is not another step back.
    const replace = options.replace || hashFor(next) === window.location.hash;
    if (!replace) step.current += 1;
    writeHistory(replace ? "replace" : "push", next, step.current);
    setDirection("forward");
    setRoute(next);
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    backFn = () => {
      if (step.current <= 0) return false;
      history.back();
      return true;
    };
    // Back and Forward, and a link to a screen (#customers) followed inside the app.
    const onPop = (e: PopStateEvent) => {
      if (isOurs(e.state)) {
        setDirection(e.state.step < step.current ? "back" : "forward");
        step.current = e.state.step;
        setRoute(e.state.route);
        return;
      }
      const linked = routeFromHash(window.location.hash);
      if (!linked) return;
      step.current += 1;
      writeHistory("replace", linked, step.current);
      setDirection("forward");
      setRoute(linked);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("popstate", onPop);
    return () => {
      backFn = null;
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  return <RouterContext.Provider value={{ route, navigate, direction }}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used inside RouterProvider");
  return ctx;
}
