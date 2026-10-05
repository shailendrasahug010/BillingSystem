import {
  BadgeIndianRupee,
  Bell,
  Boxes,
  CalendarCheck,
  CalendarPlus,
  ChevronDown,
  ClipboardList,
  Cloud,
  CloudOff,
  Download,
  House,
  Keyboard,
  LayoutGrid,
  LogOut,
  Menu,
  Moon,
  Package,
  Pin,
  PinOff,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  ShoppingCart,
  Sun,
  UserPlus,
  Wallet,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { GROUP_LABELS, homeRoute, menuModules, moduleForRoute, phaseBadge, type ModuleDef } from "../../app/modules";
import { setSimpleMenu, useSimpleMenu } from "../../app/comfort";
import { useI18n } from "../../app/i18n";
import { useRouter, type Route } from "../../app/router";
import { ACCENTS, applyAccent, applyTheme, useAppearance } from "../../app/theme";
import { useSession } from "../../app/session";
import { allowed, BUSINESS, ORDERS, WORKSPACE } from "../../data/db";
import { LIVE } from "../../data/source";
import { getSyncState, useStoreVersion } from "../../data/store";
import { cn } from "../../lib/cn";
import { installApp, useCanInstall } from "../../lib/pwa";
import { Dialog } from "../ui/Dialog";
import { Kbd, tintFor } from "../ui/misc";
import { UpdateBanner } from "./UpdateBanner";
import { NotificationBell } from "./NotificationBell";
import { OfflineBanner, OfflineChip } from "../offline/OfflineBills";
import { getOfflineState } from "../../offline/sync";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/Confirm";
import { BrandMark, FirmLogo } from "../brand/Brand";
import { ComfortButton, ComfortControls, HelpButton } from "./Comfort";

function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === "planned" && b.name === "planned") return a.module === b.module;
  return true;
}

export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t("common.language")} className={cn("rounded-full border border-line/70 bg-surface-2 p-0.5", className?.includes("hidden") ? "" : "inline-flex", className)}>
      {(
        [
          ["en", "EN"],
          ["hi", "हिं"],
        ] as const
      ).map(([code, label]) => (
        <button
          key={code}
          type="button"
          role="radio"
          aria-checked={locale === code}
          onClick={() => setLocale(code)}
          className={cn(
            "press h-7 min-w-9 rounded-full px-2.5 text-[12.5px] font-semibold transition-colors",
            locale === code ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ThemeToggle({ className }: { className?: string }) {
  const { t } = useI18n();
  const { theme } = useAppearance();
  const isDark =
    theme === "dark" || (theme === "system" && typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <button
      type="button"
      // Callers may hide it on phones ("hidden sm:inline-flex"); only add a display when they don't.
      className={cn("press size-9 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink", /(^|\s)hidden(\s|$)/.test(className ?? "") ? "" : "inline-flex", className)}
      aria-label={isDark ? t("common.lightTheme") : t("common.darkTheme")}
      title={t("common.theme")}
      onClick={() => applyTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

/** The accent colour, as swatches (Settings → Appearance has the same). */
export function AccentPicker({ className }: { className?: string }) {
  const { t } = useI18n();
  const { accent } = useAppearance();
  return (
    <div role="radiogroup" aria-label={t("settings.accent")} className={cn("flex flex-wrap items-center gap-2", className)}>
      {ACCENTS.map((a) => (
        <button
          key={a.key}
          type="button"
          role="radio"
          aria-checked={accent === a.key}
          aria-label={t(`settings.accents.${a.key}`)}
          title={t(`settings.accents.${a.key}`)}
          onClick={() => applyAccent(a.key)}
          className={cn(
            "press size-8 rounded-full ring-offset-2 ring-offset-surface transition-shadow",
            accent === a.key ? "ring-2 ring-ink" : "ring-1 ring-line hover:ring-line-strong",
          )}
          style={{ backgroundImage: `linear-gradient(135deg, ${a.swatch}, ${a.swatch2})` }}
        />
      ))}
    </div>
  );
}

export function SyncChip() {
  const { t } = useI18n();
  useStoreVersion();
  const { online, pending } = getSyncState();
  const label = !online ? t("sync.offline") : pending > 0 ? t("sync.syncing") : t("sync.online");
  const Icon = !online ? CloudOff : pending > 0 ? RefreshCw : Cloud;
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium",
        online ? "border-line bg-surface text-ink-2" : "border-transparent bg-warn-soft text-warn",
      )}
      title={pending > 0 ? t("sync.pending", { count: pending }) : t("sync.synced")}
    >
      <Icon size={14} className={cn(online ? "text-good" : "text-warn", pending > 0 && online && "animate-spin")} />
      <span className="hidden sm:inline">{label}</span>
      {pending > 0 && <span className="num rounded-full bg-warn px-1.5 text-[11px] text-white">{pending}</span>}
    </span>
  );
}

function NavItem({ mod, active, pinned, onPin, onClick }: { mod: ModuleDef; active: boolean; pinned: boolean; onPin(): void; onClick(): void }) {
  const { t } = useI18n();
  const Icon = mod.icon;
  const name = t(mod.label);
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={cn(
          "press flex h-10 w-full items-center gap-3 rounded-xl px-3 pr-9 text-left text-[13.5px] transition-[background-color,color,box-shadow] duration-200",
          active ? "animate-pill bg-accent bg-accent-grad font-semibold text-ink-inverse shadow-glow" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
        )}
      >
        <Icon size={17} className={cn("shrink-0 transition-transform duration-200", active ? "text-ink-inverse" : "text-ink-3 group-hover:scale-110 group-hover:text-ink")} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {phaseBadge(mod) && <span className="rounded-full bg-surface-2 px-1.5 text-[10.5px] font-medium text-ink-3 group-hover:hidden">P{phaseBadge(mod)}</span>}
      </button>
      {/* Pin to the top of the menu (shown on hover, or always once pinned). */}
      <button
        type="button"
        onClick={onPin}
        aria-label={pinned ? t("nav.unpin", { name }) : t("nav.pin", { name })}
        title={pinned ? t("nav.unpin", { name }) : t("nav.pin", { name })}
        aria-pressed={pinned}
        className={cn(
          "absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg transition-opacity focus-visible:opacity-100",
          active ? "text-ink-inverse/80 hover:text-ink-inverse" : "text-ink-3 hover:bg-surface-3 hover:text-ink",
          pinned ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
    </div>
  );
}

/** The menu's layout on this device: groups folded away, and entries pinned to the top. */
const MENU_KEY = "digitalbahi:menu";
interface MenuPrefs {
  collapsed: string[];
  pinned: string[];
}
function readMenu(): MenuPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(MENU_KEY) ?? "null") as Partial<MenuPrefs> | null;
    return { collapsed: Array.isArray(v?.collapsed) ? v.collapsed : [], pinned: Array.isArray(v?.pinned) ? v.pinned : [] };
  } catch {
    return { collapsed: [], pinned: [] };
  }
}
function useMenuPrefs(): [MenuPrefs, (change: (p: MenuPrefs) => MenuPrefs) => void] {
  const [prefs, setPrefs] = useState(readMenu);
  const update = (change: (p: MenuPrefs) => MenuPrefs) =>
    setPrefs((p) => {
      const next = change(p);
      try {
        localStorage.setItem(MENU_KEY, JSON.stringify(next));
      } catch {
        // A private window: kept until the page closes.
      }
      return next;
    });
  return [prefs, update];
}
const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

/** With the simple menu on: the way back to everything. */
function FullMenuButton({ userId }: { userId: string | null | undefined }) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={() => setSimpleMenu(userId, false)} className="press mt-1 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium text-accent-ink hover:bg-surface-2">
      {t("comfort.showFullMenu")}
    </button>
  );
}

function NavList({ onNavigate }: { onNavigate?(): void }) {
  const { route, navigate } = useRouter();
  const { t } = useI18n();
  const current = moduleForRoute(route);
  const [prefs, setPrefs] = useMenuPrefs();
  const userId = useSession().user?.id;
  const simple = useSimpleMenu(userId);
  // Only what this person's role opens (the everyday screens with the simple menu); a group with nothing left is not shown.
  const modules = menuModules(simple);
  const pinned = prefs.pinned.map((k) => modules.find((m) => m.key === k)).filter((m): m is ModuleDef => Boolean(m));
  const unpinned = modules.filter((m) => !prefs.pinned.includes(m.key));
  const groups = (Object.keys(GROUP_LABELS) as ModuleDef["group"][]).filter((g) => unpinned.some((m) => m.group === g));
  const isActive = (m: ModuleDef) => current?.key === m.key || sameRoute(route, m.route);
  const item = (m: ModuleDef) => (
    <NavItem
      key={m.key}
      mod={m}
      active={isActive(m)}
      pinned={prefs.pinned.includes(m.key)}
      onPin={() => setPrefs((p) => ({ ...p, pinned: toggle(p.pinned, m.key) }))}
      onClick={() => {
        navigate(m.route);
        onNavigate?.();
      }}
    />
  );
  return (
    <nav className="flex flex-col gap-4" aria-label="Main">
      {pinned.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="eyebrow flex items-center gap-1.5 px-2.5 pb-1">
            <Pin size={11} aria-hidden />
            {t("nav.pinned")}
          </p>
          {pinned.map(item)}
        </div>
      )}
      {groups.map((g) => {
        const entries = unpinned.filter((m) => m.group === g);
        // The group holding the screen open now stays open.
        const open = !prefs.collapsed.includes(g) || entries.some(isActive);
        return (
          <div key={g} className="flex flex-col gap-0.5">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setPrefs((p) => ({ ...p, collapsed: toggle(p.collapsed, g) }))}
              className="eyebrow group/head flex items-center justify-between rounded-md px-2.5 pb-1 text-left hover:text-ink"
            >
              {t(GROUP_LABELS[g])}
              <ChevronDown size={13} className={cn("transition-transform duration-200", !open && "-rotate-90")} aria-hidden />
            </button>
            {open && <div className="animate-pop flex flex-col gap-0.5">{entries.map(item)}</div>}
          </div>
        );
      })}
      {simple && <FullMenuButton userId={userId} />}
    </nav>
  );
}

/** Colour of each menu group's tiles in the phone launcher. */
const GROUP_TINT: Record<ModuleDef["group"], string> = {
  daily: "bg-tint-blue-soft text-tint-blue",
  stock: "bg-tint-orange-soft text-tint-orange",
  money: "bg-tint-green-soft text-tint-green",
  people: "bg-tint-violet-soft text-tint-violet",
  insights: "bg-tint-teal-soft text-tint-teal",
  admin: "bg-tint-rose-soft text-tint-rose",
};

/** Phones: the menu as a launcher, a grid of coloured tiles per group. */
function NavGrid({ onNavigate }: { onNavigate(): void }) {
  const { route, navigate } = useRouter();
  const { t } = useI18n();
  const current = moduleForRoute(route);
  const userId = useSession().user?.id;
  const simple = useSimpleMenu(userId);
  const modules = menuModules(simple);
  const groups = (Object.keys(GROUP_LABELS) as ModuleDef["group"][]).filter((g) => modules.some((m) => m.group === g));
  return (
    <nav className="flex flex-col gap-5" aria-label="Main">
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-2.5">
          <p className="eyebrow px-1">{t(GROUP_LABELS[g])}</p>
          <div className="stagger grid grid-cols-4 gap-x-1 gap-y-3">
            {modules.filter((m) => m.group === g).map((m) => {
              const Icon = m.icon;
              const active = current?.key === m.key || sameRoute(route, m.route);
              return (
                <button
                  key={m.key}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    navigate(m.route);
                    onNavigate();
                  }}
                  className="press flex flex-col items-center gap-1.5 rounded-2xl px-0.5 py-1 text-center"
                >
                  <span className={cn("flex size-12 items-center justify-center rounded-2xl transition-shadow", active ? "bg-accent bg-accent-grad text-ink-inverse shadow-glow" : GROUP_TINT[g])}>
                    <Icon size={21} />
                  </span>
                  <span className={cn("line-clamp-2 text-[11.5px] leading-tight", active ? "font-semibold text-ink" : "text-ink-2")}>{t(m.label)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {simple && <FullMenuButton userId={userId} />}
    </nav>
  );
}

export function AppShell({ children, onOpenSearch, onOpenShortcuts }: { children: ReactNode; onOpenSearch(): void; onOpenShortcuts(): void }) {
  const { t } = useI18n();
  const { route, navigate } = useRouter();
  // The bill screen on a phone has its own bar (total, Next, Save) where the tab bar would be.
  const billing = route.name === "invoice-new";
  const [moreOpen, setMoreOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const pendingOrders = ORDERS.filter((o) => o.status === "pending").length;
  const session = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  /** Signing out needs the server; bills still waiting stay on the device for the next sign-in. */
  const signOut = async () => {
    const { offlineMode, online, entries } = getOfflineState();
    if (offlineMode || !online) {
      toast({ tone: "offline", title: t("offline.signOutOffline") });
      return;
    }
    if (
      entries.length > 0 &&
      !(await confirm({ title: t("offline.signOutTitle"), body: t("offline.signOutPending", { count: entries.length }), confirmLabel: t("offline.signOutAnyway"), danger: true }))
    )
      return;
    void session.logout().catch(() => undefined);
  };
  const userName = LIVE ? (session.user?.name ?? "") : "Anil Sharma";
  const initials = userName
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const roleLabel = LIVE ? WORKSPACE.role.replace(/^\w/, (c) => c.toUpperCase()) : "Admin";
  const canInstall = useCanInstall();
  const installButton = canInstall ? (
    <button
      type="button"
      onClick={() => void installApp()}
      title={t("app.installHint")}
      className="press flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[13px] font-medium text-ink hover:bg-surface-2"
    >
      <Download size={16} className="text-accent-2" />
      {t("app.install")}
    </button>
  ) : null;
  /** Live mode: switch business (when there are several) and sign out. */
  const accountActions = LIVE ? (
    <div className="flex flex-col gap-1 border-t border-line pt-2">
      {session.businesses.length > 1 && (
        <select
          aria-label={t("auth.switchBusiness")}
          value={WORKSPACE.businessId ?? ""}
          onChange={(e) => void session.switchBusiness(e.target.value)}
          className="h-9 w-full rounded-xl border border-line bg-surface px-2 text-[13px] text-ink"
        >
          {session.businesses.map((b) => (
            <option key={b.id} value={b.id} disabled={b.status === "suspended" || b.status === "closed"}>
              {b.tradeName ?? b.legalName}
            </option>
          ))}
        </select>
      )}
      <button type="button" onClick={() => void signOut()} className="press flex h-9 items-center gap-2 rounded-xl px-2.5 text-left text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink">
        <LogOut size={15} className="text-ink-3" />
        {t("auth.signOut")}
      </button>
    </div>
  ) : null;

  const quickActions = (
    [
      { label: t("dashboard.actions.createInvoice"), route: { name: "invoice-new" }, icon: <Receipt size={22} />, tint: "bg-tint-blue-soft text-tint-blue", permission: "invoice.create" },
      { label: t("dashboard.actions.newOrder"), route: { name: "planned", module: "orders" }, icon: <ClipboardList size={22} />, tint: "bg-tint-violet-soft text-tint-violet", permission: "order.create" },
      { label: t("dashboard.actions.receivePayment"), route: { name: "planned", module: "payments" }, icon: <Wallet size={22} />, tint: "bg-tint-green-soft text-tint-green", permission: "payment.collect" },
      { label: t("dashboard.actions.addCustomer"), route: { name: "customers" }, icon: <UserPlus size={22} />, tint: "bg-tint-orange-soft text-tint-orange", permission: "customer.create" },
      { label: t("dashboard.actions.purchaseEntry"), route: { name: "planned", module: "purchases" }, icon: <ShoppingCart size={22} />, tint: "bg-tint-teal-soft text-tint-teal", permission: "purchase.create" },
      { label: t("dashboard.actions.addProduct"), route: { name: "products" }, icon: <Package size={22} />, tint: "bg-tint-amber-soft text-tint-amber", permission: "product.create" },
      { label: t("dashboard.actions.stockAdjustment"), route: { name: "planned", module: "inventory" }, icon: <Boxes size={22} />, tint: "bg-tint-amber-soft text-tint-amber", permission: "inventory.adjust" },
      { label: t("dashboard.actions.markAttendance"), route: { name: "planned", module: "employees" }, icon: <CalendarCheck size={22} />, tint: "bg-tint-green-soft text-tint-green", permission: "employee.update" },
      { label: t("dashboard.actions.applyLeave"), route: { name: "planned", module: "leave" }, icon: <CalendarPlus size={22} />, tint: "bg-tint-violet-soft text-tint-violet", permission: "leave.apply" },
      { label: t("dashboard.actions.addExpense"), route: { name: "planned", module: "expenses" }, icon: <BadgeIndianRupee size={22} />, tint: "bg-tint-rose-soft text-tint-rose", permission: "expense.create" },
    ] satisfies Array<{ label: string; route: Route; icon: ReactNode; tint: string; permission: string }>
  )
    .filter((a) => allowed(a.permission))
    .slice(0, 8);

  // The phone's bottom bar: Customers and Outstanding for the roles that have
  // them, otherwise that role's own main screens (Products, Packing, Leave…).
  const simple = useSimpleMenu(session.user?.id);
  const navModules = menuModules(simple);
  const used = new Set<string>();
  const slot = (prefs: string[]) => {
    const m = prefs.map((k) => navModules.find((x) => x.key === k)).find((x) => x && !used.has(x.key));
    if (m) used.add(m.key);
    return m;
  };
  const slotA = slot(["customers", "packing", "employees", "orders", "payments", "purchases", "expenses", "reports", "gst"]);
  const slotB = slot(["outstanding", "products", "dispatch", "leave", "inventory", "payroll", "suppliers", "reports", "audit", "settings"]);
  const fromModule = (m: ModuleDef | undefined) => m && { key: m.key, label: t(m.label), icon: <m.icon size={20} />, route: m.route };

  const bottomItems = (
    [
      { key: "home", label: t("nav.home"), icon: <House size={20} />, route: homeRoute() },
      fromModule(slotA),
      { key: "create", label: t("nav.create"), icon: <Plus size={24} strokeWidth={2.4} />, onClick: () => setCreateOpen(true), hidden: quickActions.length === 0 },
      fromModule(slotB),
      { key: "more", label: t("nav.more"), icon: <LayoutGrid size={20} />, onClick: () => setMoreOpen(true) },
    ] as Array<{ key: string; label: string; icon: ReactNode; route?: Route; onClick?(): void; hidden?: boolean } | undefined>
  ).filter((b): b is NonNullable<typeof b> => Boolean(b) && !b!.hidden);

  return (
    <div className="animate-fade min-h-full lg:grid lg:grid-cols-[256px_1fr]">
      {/* Desktop sidebar: the menu on the accent-tinted navy. */}
      <aside className="on-dark bg-side sticky top-0 hidden h-screen flex-col lg:flex">
        <div className="flex h-16 items-center px-4">
          <BrandMark tagline />
        </div>
        <div className="mx-3 mb-4 flex items-center gap-2.5 rounded-2xl border border-line bg-surface-2 px-2.5 py-2.5">
          <FirmLogo size={38} className="rounded-xl" />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-ink" title={BUSINESS.name}>
              {BUSINESS.name}
            </p>
            {BUSINESS.gstin ? (
              <p className="truncate font-mono text-[11px] text-ink-3">GSTIN {BUSINESS.gstin}</p>
            ) : (
              BUSINESS.city && <p className="truncate text-[11px] text-ink-3">{BUSINESS.city}</p>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 [scrollbar-color:rgb(255_255_255/0.15)_transparent] [scrollbar-width:thin]">
          <NavList />
        </div>
        {installButton && <div className="px-3 pb-1">{installButton}</div>}
        {accountActions && <div className="px-3 pb-2">{accountActions}</div>}
        <div className="mx-3 mb-3 flex items-center gap-3 rounded-2xl border border-line bg-surface-2 px-3 py-2.5">
          <span className={cn("inline-flex size-9 items-center justify-center rounded-full font-display text-[12.5px] font-semibold", tintFor(userName))}>{initials}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink">{userName}</p>
            <p className="text-[11.5px] text-ink-3">{roleLabel}</p>
          </div>
          <button
            type="button"
            onClick={onOpenShortcuts}
            className="press inline-flex size-8 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink"
            aria-label={t("shortcuts.title")}
            title={t("shortcuts.title")}
          >
            <Keyboard size={16} />
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* Top bar */}
        <header data-overlay="top" className="glass sticky top-[env(safe-area-inset-top,0px)] z-30 flex h-14 items-center gap-2 border-b border-line/60 px-4 lg:h-16 lg:px-6">
          <button
            type="button"
            className="press -ml-1 inline-flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 lg:hidden"
            onClick={() => setMoreOpen(true)}
            aria-label={t("nav.more")}
          >
            <Menu size={20} />
          </button>
          <div className="lg:hidden">
            <BrandMark compact />
          </div>
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label={t("search.placeholder")}
            className="press ml-auto flex h-9 items-center gap-2 rounded-full border border-line/70 bg-surface-2/80 px-2.5 text-left text-[13px] text-ink-3 transition-colors hover:border-line-strong hover:bg-surface sm:ml-1 sm:min-w-0 sm:flex-1 sm:px-3.5 lg:max-w-md"
          >
            <Search size={16} className="shrink-0" />
            <span className="hidden min-w-0 flex-1 truncate sm:block">{t("search.placeholder")}</span>
            <Kbd keys="mod+k" className="hidden sm:inline-flex" />
          </button>
          <div className="flex items-center gap-1 sm:ml-auto sm:gap-1.5">
            {LIVE ? <OfflineChip /> : <SyncChip />}
            <LanguageToggle className="hidden sm:inline-flex" />
            <ThemeToggle className="hidden sm:inline-flex" />
            <span className="hidden sm:inline-flex">
              <ComfortButton userId={session.user?.id} />
            </span>
            <HelpButton onOpenShortcuts={onOpenShortcuts} />
            {LIVE && allowed("notification.view") && <NotificationBell />}
            {!LIVE && allowed("notification.view") && <button
              type="button"
              className="press relative inline-flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2"
              aria-label={t("nav.notifications")}
              onClick={() => navigate({ name: "planned", module: "notifications" })}
            >
              <Bell size={18} />
              {pendingOrders > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger ring-2 ring-surface" aria-hidden />}
            </button>}
            {route.name !== "invoice-new" && allowed("invoice.create") && (
              <button
                type="button"
                onClick={() => navigate({ name: "invoice-new" })}
                className="press ml-1 hidden h-9 items-center gap-2 rounded-full bg-accent bg-accent-grad px-4 text-[13.5px] font-semibold text-ink-inverse shadow-glow transition-[filter,box-shadow] hover:shadow-lift hover:brightness-110 lg:inline-flex"
              >
                <Plus size={16} />
                {t("invoice.new")}
                <Kbd keys="mod+i" className="opacity-80 [&_kbd]:border-white/30 [&_kbd]:bg-white/15 [&_kbd]:text-white" />
              </button>
            )}
          </div>
        </header>

        <UpdateBanner className="border-b border-line lg:px-6" />
        {LIVE && <OfflineBanner />}
        {!LIVE && (
          <div className="border-b border-line bg-accent-soft/60 px-4 py-1.5 text-center text-[12px] text-accent-ink lg:px-6">
            {t("app.prototypeBanner")}
          </div>
        )}

        <main className={cn("mx-auto w-full max-w-[1920px] flex-1 px-4 pt-5 short:pb-8 sm:px-5 lg:px-8 lg:pt-7 lg:pb-12", billing ? "pb-8" : "pb-32")}>{children}</main>
      </div>

      {/* Phones: a floating tab bar with the Create button in the middle (not on the bill screen, which has its own bar with the total and Save). */}
      <nav
        data-overlay="bottom"
        className={cn("glass fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+10px)] z-30 grid h-16 grid-cols-5 rounded-[22px] border border-line/70 shadow-pop short:hidden lg:hidden", billing && "hidden")}
        style={{ gridTemplateColumns: `repeat(${bottomItems.length}, minmax(0, 1fr))` }}
        aria-label="Primary"
      >
        {bottomItems.map((item) => {
          const active = item.route ? sameRoute(route, item.route) : false;
          if (item.key === "create") {
            return (
              <button key={item.key} type="button" onClick={item.onClick} className="press flex flex-col items-center justify-end pb-1.5" aria-label={item.label}>
                <span className="-mt-7 mb-0.5 flex size-14 items-center justify-center rounded-[20px] bg-accent bg-accent-grad text-ink-inverse shadow-glow ring-4 ring-bg">{item.icon}</span>
                <span className="text-[10.5px] font-semibold text-ink-2">{item.label}</span>
              </button>
            );
          }
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => (item.route ? navigate(item.route) : item.onClick?.())}
              aria-current={active ? "page" : undefined}
              className={cn("press flex flex-col items-center justify-center gap-1 text-[10.5px] font-semibold", active ? "text-accent-ink" : "text-ink-3")}
            >
              <span className={cn("flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200", active ? "animate-pill-x bg-accent-soft text-accent" : "")}>{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen} title={BUSINESS.name} {...(BUSINESS.gstin ? { description: `GSTIN ${BUSINESS.gstin}` } : {})} closeLabel={t("common.close")}>
        <div className="bg-hero on-dark relative mb-5 overflow-hidden rounded-2xl p-3.5">
          <div className="dots pointer-events-none absolute inset-0 opacity-60" aria-hidden />
          <div className="relative flex items-center gap-3">
            <FirmLogo size={46} className="rounded-xl" />
            <div className="min-w-0 flex-1 text-[12.5px] text-ink-2">
              <p className="truncate text-[14px] font-semibold text-ink">{userName}</p>
              {[BUSINESS.address, BUSINESS.city].filter(Boolean).join(", ") && <p className="truncate">{[BUSINESS.address, BUSINESS.city].filter(Boolean).join(", ")}</p>}
              {[BUSINESS.phone, BUSINESS.email].filter(Boolean).length > 0 && <p className="truncate">{[BUSINESS.phone, BUSINESS.email].filter(Boolean).join(" · ")}</p>}
            </div>
          </div>
        </div>
        <div className="lg:hidden">
          <NavGrid onNavigate={() => setMoreOpen(false)} />
        </div>
        <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-line/70 bg-surface-2/60 px-3 py-3 lg:hidden">
          <div className="flex items-center justify-between gap-3">
            <LanguageToggle />
            <ThemeToggle className="bg-surface shadow-card" />
          </div>
          <AccentPicker className="justify-between" />
          <div className="border-t border-line/70 pt-3">
            <ComfortControls userId={session.user?.id} />
          </div>
        </div>
        <div className="hidden lg:block">
          <NavList onNavigate={() => setMoreOpen(false)} />
        </div>
        {installButton && <div className="mt-4">{installButton}</div>}
        {accountActions && <div className="mt-3">{accountActions}</div>}
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen} title={t("dashboard.quickActions")} closeLabel={t("common.close")}>
        <div className="stagger grid grid-cols-3 gap-x-2 gap-y-5 pb-2">
          {quickActions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => {
                setCreateOpen(false);
                navigate(a.route);
              }}
              className="press flex flex-col items-center gap-2 rounded-2xl px-1 py-1 text-center"
            >
              <span className={cn("flex size-14 items-center justify-center rounded-2xl shadow-card", a.tint)}>{a.icon}</span>
              <span className="text-[12.5px] leading-tight font-medium text-ink">{a.label}</span>
            </button>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
