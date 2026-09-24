import {
  Bell,
  Cloud,
  CloudOff,
  House,
  Keyboard,
  LayoutGrid,
  Menu,
  Moon,
  Package,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Sun,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { GROUP_LABELS, MODULES, moduleForRoute, phaseBadge, type ModuleDef } from "../../app/modules";
import { useI18n } from "../../app/i18n";
import { useRouter, type Route } from "../../app/router";
import { applyTheme, readTheme, type ThemeChoice } from "../../app/theme";
import { useSession } from "../../app/session";
import { BUSINESS, ORDERS, WORKSPACE } from "../../data/db";
import { LIVE } from "../../data/source";
import { getSyncState, useStoreVersion } from "../../data/store";
import { cn } from "../../lib/cn";
import { Dialog } from "../ui/Dialog";
import { Kbd } from "../ui/misc";

function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === "planned" && b.name === "planned") return a.module === b.module;
  return true;
}

export function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex size-8 items-center justify-center rounded-lg bg-accent font-display text-[17px] font-bold text-ink-inverse">
        व
        <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface bg-marigold" aria-hidden />
      </span>
      {!compact && (
        <span className="font-display text-[18px] leading-none font-semibold tracking-tight text-ink">
          Vyapaar<span className="text-ink-3"> CRM</span>
        </span>
      )}
    </div>
  );
}

export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t("common.language")} className={cn("rounded-lg border border-line bg-surface-2 p-0.5", className?.includes("hidden") ? "" : "inline-flex", className)}>
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
            "h-7 min-w-9 rounded-md px-2 text-[12.5px] font-semibold transition-colors",
            locale === code ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ThemeToggle() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const isDark =
    theme === "dark" || (theme === "system" && typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <button
      type="button"
      className="inline-flex size-9 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
      aria-label={isDark ? t("common.lightTheme") : t("common.darkTheme")}
      title={t("common.theme")}
      onClick={() => {
        const next = isDark ? "light" : "dark";
        applyTheme(next);
        setTheme(next);
      }}
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
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

function NavItem({ mod, active, onClick }: { mod: ModuleDef; active: boolean; onClick(): void }) {
  const { t } = useI18n();
  const Icon = mod.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13.5px] transition-colors",
        active ? "bg-accent-soft font-semibold text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
      )}
    >
      <Icon size={17} className={cn("shrink-0", active ? "text-accent" : "text-ink-3 group-hover:text-ink-2")} />
      <span className="min-w-0 flex-1 truncate">{t(mod.label)}</span>
      {phaseBadge(mod) && <span className="rounded bg-surface-2 px-1.5 text-[10.5px] font-medium text-ink-3">P{phaseBadge(mod)}</span>}
    </button>
  );
}

function NavList({ onNavigate }: { onNavigate?(): void }) {
  const { route, navigate } = useRouter();
  const { t } = useI18n();
  const current = moduleForRoute(route);
  const groups = Object.keys(GROUP_LABELS) as ModuleDef["group"][];
  return (
    <nav className="flex flex-col gap-5" aria-label="Main">
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-0.5">
          <p className="eyebrow px-2.5 pb-1">{t(GROUP_LABELS[g])}</p>
          {MODULES.filter((m) => m.group === g).map((m) => (
            <NavItem
              key={m.key}
              mod={m}
              active={current?.key === m.key || sameRoute(route, m.route)}
              onClick={() => {
                navigate(m.route);
                onNavigate?.();
              }}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ children, onOpenSearch, onOpenShortcuts }: { children: ReactNode; onOpenSearch(): void; onOpenShortcuts(): void }) {
  const { t } = useI18n();
  const { route, navigate } = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const pendingOrders = ORDERS.filter((o) => o.status === "pending").length;
  const session = useSession();
  const userName = LIVE ? (session.user?.name ?? "") : "Anil Sharma";
  const initials = userName
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const roleLabel = LIVE ? WORKSPACE.role.replace(/^\w/, (c) => c.toUpperCase()) : "Admin";
  /** Live mode: switch business (when there are several) and sign out. */
  const accountActions = LIVE ? (
    <div className="flex flex-col gap-1 border-t border-line pt-2">
      {session.businesses.length > 1 && (
        <select
          aria-label={t("auth.switchBusiness")}
          value={WORKSPACE.businessId ?? ""}
          onChange={(e) => void session.switchBusiness(e.target.value)}
          className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-[13px] text-ink"
        >
          {session.businesses.map((b) => (
            <option key={b.id} value={b.id} disabled={b.status === "suspended" || b.status === "closed"}>
              {b.tradeName ?? b.legalName}
            </option>
          ))}
        </select>
      )}
      <button type="button" onClick={() => void session.logout()} className="h-9 rounded-lg px-2 text-left text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink">
        {t("auth.signOut")}
      </button>
    </div>
  ) : null;

  const quickActions: Array<{ label: string; route: Route; icon: ReactNode }> = [
    { label: t("dashboard.actions.createInvoice"), route: { name: "invoice-new" }, icon: <Receipt size={18} /> },
    { label: t("dashboard.actions.newOrder"), route: { name: "planned", module: "orders" }, icon: <Plus size={18} /> },
    { label: t("dashboard.actions.receivePayment"), route: { name: "planned", module: "payments" }, icon: <Plus size={18} /> },
    { label: t("dashboard.actions.addCustomer"), route: { name: "customers" }, icon: <Users size={18} /> },
    { label: t("dashboard.actions.purchaseEntry"), route: { name: "planned", module: "purchases" }, icon: <Plus size={18} /> },
    { label: t("dashboard.actions.addProduct"), route: { name: "products" }, icon: <Package size={18} /> },
  ];

  const bottomItems: Array<{ key: string; label: string; icon: ReactNode; route?: Route; onClick?(): void }> = [
    { key: "home", label: t("nav.home"), icon: <House size={20} />, route: { name: "dashboard" } },
    { key: "customers", label: t("nav.customers"), icon: <Users size={20} />, route: { name: "customers" } },
    { key: "create", label: t("nav.create"), icon: <Plus size={22} />, onClick: () => setCreateOpen(true) },
    { key: "products", label: t("nav.products"), icon: <Package size={20} />, route: { name: "products" } },
    { key: "more", label: t("nav.more"), icon: <LayoutGrid size={20} />, onClick: () => setMoreOpen(true) },
  ];

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[248px_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center px-5">
          <BrandMark />
        </div>
        <div className="mx-3 mb-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
          <p className="truncate text-[13px] font-semibold text-ink">{BUSINESS.name}</p>
          {BUSINESS.gstin && <p className="truncate font-mono text-[11px] text-ink-3">GSTIN {BUSINESS.gstin}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <NavList />
        </div>
        {accountActions && <div className="px-3 pb-2">{accountActions}</div>}
        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-surface-3 font-display text-[12px] font-semibold text-ink-2">{initials}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink">{userName}</p>
            <p className="text-[11.5px] text-ink-3">{roleLabel}</p>
          </div>
          <button
            type="button"
            onClick={onOpenShortcuts}
            className="inline-flex size-8 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
            aria-label={t("shortcuts.title")}
            title={t("shortcuts.title")}
          >
            <Keyboard size={16} />
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* Top bar */}
        <header className="sticky top-[env(safe-area-inset-top,0px)] z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-4 backdrop-blur lg:h-16 lg:px-6">
          <button
            type="button"
            className="-ml-1 inline-flex size-9 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2 lg:hidden"
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
            className="ml-1 flex h-9 items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 text-left text-[13px] text-ink-3 transition-colors hover:border-line-strong sm:min-w-0 sm:flex-1 sm:px-3 lg:max-w-md"
          >
            <Search size={16} className="shrink-0" />
            <span className="hidden min-w-0 flex-1 truncate sm:block">{t("search.placeholder")}</span>
            <Kbd keys="mod+k" className="hidden sm:inline-flex" />
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <SyncChip />
            <LanguageToggle />
            <ThemeToggle />
            <button
              type="button"
              className="relative inline-flex size-9 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2"
              aria-label={t("nav.notifications")}
              onClick={() => navigate({ name: "planned", module: "notifications" })}
            >
              <Bell size={18} />
              {pendingOrders > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger" aria-hidden />}
            </button>
            {route.name !== "invoice-new" && (
              <button
                type="button"
                onClick={() => navigate({ name: "invoice-new" })}
                className="ml-1 hidden h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-[13.5px] font-semibold text-ink-inverse shadow-card hover:bg-accent-hover lg:inline-flex"
              >
                <Plus size={16} />
                {t("invoice.new")}
                <Kbd keys="mod+i" className="opacity-80 [&_kbd]:border-white/30 [&_kbd]:bg-white/15 [&_kbd]:text-white" />
              </button>
            )}
          </div>
        </header>

        {!LIVE && (
          <div className="border-b border-line bg-accent-soft/60 px-4 py-1.5 text-center text-[12px] text-accent-ink lg:px-6">
            {t("app.prototypeBanner")}
          </div>
        )}

        <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 pt-5 pb-28 sm:px-5 lg:px-8 lg:pt-7 lg:pb-12">{children}</main>
      </div>

      {/* Mobile bottom navigation */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur lg:hidden"
        aria-label="Primary"
      >
        {bottomItems.map((item) => {
          const active = item.route ? sameRoute(route, item.route) : false;
          if (item.key === "create") {
            return (
              <button key={item.key} type="button" onClick={item.onClick} className="flex flex-col items-center justify-center gap-0.5 py-1.5" aria-label={item.label}>
                <span className="-mt-5 flex size-13 items-center justify-center rounded-2xl bg-accent text-ink-inverse shadow-pop">{item.icon}</span>
                <span className="text-[11px] font-medium text-ink-2">{item.label}</span>
              </button>
            );
          }
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => (item.route ? navigate(item.route) : item.onClick?.())}
              aria-current={active ? "page" : undefined}
              className={cn("flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium", active ? "text-accent" : "text-ink-3")}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen} title={BUSINESS.name} {...(BUSINESS.gstin ? { description: `GSTIN ${BUSINESS.gstin}` } : {})} closeLabel={t("common.close")}>
        <div className="mb-4 sm:hidden">
          <LanguageToggle />
        </div>
        <NavList onNavigate={() => setMoreOpen(false)} />
        {accountActions && <div className="mt-3">{accountActions}</div>}
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen} title={t("dashboard.quickActions")} closeLabel={t("common.close")}>
        <div className="grid grid-cols-2 gap-2.5">
          {quickActions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => {
                setCreateOpen(false);
                navigate(a.route);
              }}
              className="flex min-h-16 items-center gap-3 rounded-xl border border-line bg-surface px-3.5 text-left text-[14px] font-medium text-ink hover:border-accent"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
