import { useQueryClient } from "@tanstack/react-query";
import { translateError } from "@digitalbahi/i18n";
import { ArrowDown, ArrowUp, MapPinned, Pencil, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button, IconButton } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { EmptyState, Skeleton } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { allowed, CUSTOMERS, customerById } from "../../data/db";
import { customerRow, requestPull } from "../../data/live";
import { useStoreVersion } from "../../data/store";
import type { Customer } from "../../data/types";
import { api, ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { byCity } from "../../lib/places";
import { useOffline } from "../../offline/sync";
import { searchCustomers } from "../invoice/CustomerPicker";
import { useEmployeeOptions } from "../people/api";
import { AddByCity } from "./AddByCity";
import { ROUTE_MAX_SHOPS, useRoutes, weekdayName, type RouteRow, type RouteShop } from "./data";

const WEEK = [1, 2, 3, 4, 5, 6, 7];

/**
 * The routes (managers): on which weekdays each is worked, by whom, and its
 * shops in the order they are called on, added one by one or a city's at
 * once. A shop belongs to one route; adding it here moves it from the one it
 * was on.
 */
export function RoutesTab() {
  const { t, locale } = useI18n();
  const offline = useOffline();
  const routes = useRoutes();
  const employees = useEmployeeOptions();
  const [editing, setEditing] = useState<RouteRow | "new" | null>(null);
  const employeeName = useMemo(() => new Map((employees.data ?? []).map((e) => [e.id, e.name])), [employees.data]);
  // Each route's shops and their cities, from the customers on this device (they follow a change of route at the next pull).
  const version = useStoreVersion();
  const onRoutes = useMemo(() => {
    const byRoute = new Map<string, Customer[]>();
    for (const c of CUSTOMERS) {
      const routeId = customerRow(c.id)?.routeId;
      if (!routeId) continue;
      const shops = byRoute.get(routeId);
      if (shops) shops.push(c);
      else byRoute.set(routeId, [c]);
    }
    const places = (shops: Customer[]) => {
      // The cities with most of the route's shops first.
      const cities = byCity(shops, (c) => c.city)
        .sort((a, b) => b.rows.length - a.rows.length)
        .flatMap((g) => (g.label ? [g.label] : []));
      return cities.length > 3 ? `${cities.slice(0, 3).join(", ")} +${cities.length - 3}` : cities.join(", ");
    };
    return new Map([...byRoute].map(([id, shops]) => [id, { shops: shops.length, places: places(shops) }]));
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (offline.offlineMode || !offline.online) return <EmptyState icon={<MapPinned size={22} />} title={t("beat.routesOffline")} hint={t("common.connectHint")} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-ink-3">{t("beat.routesHint")}</p>
        <Button variant="primary" size="sm" icon={<Plus size={15} />} onClick={() => setEditing("new")}>
          {t("beat.newRoute")}
        </Button>
      </div>
      <ErrorNote error={routes.error} onRetry={() => void routes.refetch()} />
      {routes.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-label={t("common.loading")}>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : (routes.data ?? []).length === 0 ? (
        <EmptyState icon={<MapPinned size={22} />} title={t("beat.noRoutes")} hint={t("beat.noRoutesHint")} />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
          {(routes.data ?? []).map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setEditing(r)} className={cn("press flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2", !r.isActive && "opacity-60")}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-ink">
                    {r.name}
                    {!r.isActive && <span className="ml-2 text-[12px] font-normal text-ink-3">({t("beat.inactive")})</span>}
                  </p>
                  <p className="truncate text-[12.5px] text-ink-3">
                    {[r.salespersonId ? (employeeName.get(r.salespersonId) ?? "—") : t("beat.noSalesperson"), t("beat.shops", { count: onRoutes.get(r.id)?.shops ?? 0 }), onRoutes.get(r.id)?.places]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(r.visitDays ?? []).length === 0 ? (
                      <Badge>{t("beat.noDays")}</Badge>
                    ) : (
                      [...(r.visitDays ?? [])].sort().map((d) => (
                        <Badge key={d} tone="accent">
                          {weekdayName(d, locale, "short")}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <Pencil size={15} className="shrink-0 text-ink-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <RouteDialog route={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** A route's name, weekdays and salesperson, and its shops in calling order. */
function RouteDialog({ route, onClose }: { route: RouteRow | null; onClose(): void }) {
  const i18n = useI18n();
  const { t, locale, number } = i18n;
  const toast = useToast();
  const qc = useQueryClient();
  const employees = useEmployeeOptions();
  const [name, setName] = useState(route?.name ?? "");
  const [days, setDays] = useState<number[]>(route?.visitDays ?? []);
  const [salesperson, setSalesperson] = useState(route?.salespersonId ?? "");
  const [active, setActive] = useState(route?.isActive ?? true);
  const [shops, setShops] = useState<RouteShop[] | null>(route ? null : []);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The route's shops in their order, as the beat lists them.
  useEffect(() => {
    if (!route) return;
    let live = true;
    api
      .get<{ customers: Array<{ id: string; name: string; city: string | null }> }>("/beats/today", { routeId: route.id })
      .then((b) => live && setShops(b.customers.map((c) => ({ id: c.id, name: c.name, city: c.city }))))
      .catch((e: unknown) => live && (setError(e), setShops([])));
    return () => {
      live = false;
    };
  }, [route]);

  const change = (next: RouteShop[]) => {
    setShops(next);
    setTouched(true);
  };
  const move = (i: number, by: -1 | 1) => {
    if (!shops) return;
    const next = [...shops];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    change(next);
  };
  const add = (id: string | null) => {
    const c = id ? customerById.get(id) : undefined;
    if (!c || !shops || shops.some((s) => s.id === c.id)) return;
    change([...shops, { id: c.id, name: c.businessName || c.name, city: c.city.trim() || null }]);
  };
  const listed = useMemo(() => new Set((shops ?? []).map((s) => s.id)), [shops]);
  const tooMany = (shops?.length ?? 0) > ROUTE_MAX_SHOPS;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), visitDays: [...days].sort(), salespersonId: salesperson || null };
      const saved = route ? await api.patch<{ id: string }>(`/routes/${route.id}`, { ...body, isActive: active }) : await api.post<{ id: string }>("/routes", body);
      if (shops && (touched || !route)) await api.put(`/routes/${saved.id}/order`, { customerIds: shops.map((s) => s.id), others: "remove" });
      void qc.invalidateQueries({ queryKey: ["routes"] });
      void qc.invalidateQueries({ queryKey: ["beat"] });
      // The customers' routes changed: the copy on the device follows.
      if (touched) requestPull();
      toast({ tone: "success", title: t("beat.routeSaved"), body: body.name });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={route ? route.name : t("beat.newRoute")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !name.trim() || shops === null || tooMany} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error instanceof ApiError ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">{translateError(i18n, error)}</p> : <ErrorNote error={error} />}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("beat.routeName")} htmlFor="route-name">
            <Input id="route-name" autoFocus={!route} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("beat.salesperson")} htmlFor="route-salesperson" hint={allowed("employee.view") ? undefined : t("beat.salespersonHint")}>
            <Select id="route-salesperson" value={salesperson} disabled={!allowed("employee.view")} onChange={(e) => setSalesperson(e.target.value)}>
              <option value="">{t("beat.noSalesperson")}</option>
              {(employees.data ?? [])
                .filter((e) => e.status !== "terminated" || e.id === salesperson)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink-2">{t("beat.visitDays")}</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEK.map((d) => {
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setDays((ds) => (on ? ds.filter((x) => x !== d) : [...ds, d]))}
                  className={cn("press h-9 min-w-12 rounded-full border px-3 text-[13px] font-medium", on ? "border-accent bg-accent text-ink-inverse" : "border-line bg-surface text-ink-2 hover:border-line-strong")}
                >
                  {weekdayName(d, locale, "short")}
                </button>
              );
            })}
          </div>
        </fieldset>
        {route && <Checkbox label={t("beat.routeActive")} checked={active} onChange={setActive} />}

        <section aria-label={t("beat.shopsInOrder")}>
          <h3 className="mb-1 text-[13px] font-semibold text-ink">{t("beat.shopsInOrder")}</h3>
          <p className="mb-2 text-[12.5px] text-ink-3">{t("beat.shopsInOrderHint")}</p>
          {shops === null ? (
            <Skeleton className="h-24 w-full rounded-2xl" />
          ) : (
            <>
              {shops.length > 0 && (
                <ol className="mb-2 divide-y divide-line overflow-hidden rounded-2xl border border-line">
                  {shops.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
                      <span className="num w-6 text-[13px] font-semibold text-ink-3">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] text-ink">{s.name}</p>
                        {s.city && <p className="truncate text-[12px] text-ink-3">{s.city}</p>}
                      </div>
                      <IconButton label={t("beat.moveUp", { name: s.name })} disabled={i === 0} onClick={() => move(i, -1)}>
                        <ArrowUp size={15} />
                      </IconButton>
                      <IconButton label={t("beat.moveDown", { name: s.name })} disabled={i === shops.length - 1} onClick={() => move(i, 1)}>
                        <ArrowDown size={15} />
                      </IconButton>
                      <IconButton label={t("beat.removeShop", { name: s.name })} onClick={() => change(shops.filter((x) => x.id !== s.id))}>
                        <X size={15} />
                      </IconButton>
                    </li>
                  ))}
                </ol>
              )}
              {tooMany && (
                <p className="mb-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
                  {t("beat.tooManyShops", { max: number(ROUTE_MAX_SHOPS, 0), shops: number(shops.length, 0) })}
                </p>
              )}
              <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
                <SearchSelect
                  id="route-add-shop"
                  value={null}
                  onChange={add}
                  placeholder={t("beat.addShop")}
                  clearLabel={t("common.clear")}
                  emptyText={t("search.noResults")}
                  search={(q) =>
                    searchCustomers(q)
                      .filter((c) => !listed.has(c.id))
                      .map((c) => ({ id: c.id, label: c.businessName || c.name, sub: [c.code, c.city, c.route].filter(Boolean).join(" · ") }))
                  }
                />
                <AddByCity routeId={route?.id ?? null} listed={listed} onAdd={(added) => change([...shops, ...added])} />
              </div>
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
