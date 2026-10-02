import { normalizeSearchText } from "@digitalbahi/core";
import { MapPin, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button, IconButton } from "../../components/ui/Button";
import { Checkbox, Input, Select } from "../../components/ui/Field";
import { CUSTOMERS } from "../../data/db";
import { customerRow } from "../../data/live";
import { useStoreVersion } from "../../data/store";
import { byCity, byPinThenName } from "../../lib/places";
import { useRoutes, type RouteShop } from "./data";

interface CityShop extends RouteShop {
  address: string;
  pincode: string;
  /** The route it is on now (adding it here takes it off that one). */
  routeId: string | null;
}

/** Above this many shops, the city's list can be searched. */
const FIND_FROM = 10;

/**
 * Adding a city's shops to a route at once: pick the city, and its shops
 * not on the list yet show by PIN code and name, ticked unless they are on
 * another route (ticking one of those moves it here). Made for a two-column
 * grid: the city's shops take its whole width.
 */
export function AddByCity({ routeId, listed, onAdd }: { routeId: string | null; listed: ReadonlySet<string>; onAdd(shops: RouteShop[]): void }) {
  const { t, locale } = useI18n();
  const routes = useRoutes();
  const version = useStoreVersion();
  const [city, setCity] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");

  const routeName = useMemo(() => new Map((routes.data ?? []).map((r) => [r.id, r.name])), [routes.data]);
  // The cities of the customers on this device, A to Z, the shops without a city last.
  const cities = useMemo(() => {
    const shops: CityShop[] = CUSTOMERS.map((c) => ({
      id: c.id,
      name: c.businessName || c.name,
      city: c.city.trim() || null,
      address: c.address,
      pincode: c.pincode,
      routeId: customerRow(c.id)?.routeId ?? null,
    }));
    const collator = new Intl.Collator(locale === "hi" ? "hi-IN" : "en-IN");
    return byCity(shops, (s) => s.city).sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : collator.compare(a.label ?? "", b.label ?? "")));
  }, [version, locale]); // eslint-disable-line react-hooks/exhaustive-deps

  const group = city === null ? undefined : cities.find((g) => g.key === city);
  const label = group ? (group.label ?? t("collect.noCity")) : "";
  /** On another route (one taken off this route while editing counts as on none). */
  const elsewhere = (s: CityShop) => s.routeId !== null && s.routeId !== routeId;
  // The city's shops not on the list, neighbours together.
  const candidates = useMemo(() => (group?.rows ?? []).filter((s) => !listed.has(s.id)).sort(byPinThenName), [group, listed]);
  const q = normalizeSearchText(query);
  const visible = q ? candidates.filter((s) => normalizeSearchText(`${s.name} ${s.address} ${s.pincode}`).includes(q)) : candidates;
  const chosen = candidates.filter((s) => picked.has(s.id));
  const already = (group?.rows.length ?? 0) - candidates.length;

  const choose = (key: string | null) => {
    setCity(key);
    setQuery("");
    const rows = key === null ? [] : (cities.find((g) => g.key === key)?.rows ?? []);
    setPicked(new Set(rows.filter((s) => !listed.has(s.id) && !elsewhere(s)).map((s) => s.id)));
  };
  const tick = (ids: string[], on: boolean) =>
    setPicked((before) => {
      const next = new Set(before);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const add = () => {
    onAdd(chosen.map((s) => ({ id: s.id, name: s.name, city: s.city })));
    choose(null);
  };

  return (
    <>
      {/* "city:" ahead of the key, so the shops without a city ("") are not the empty choice. */}
      <Select id="route-add-city" aria-label={t("beat.addCity")} value={city === null ? "" : `city:${city}`} onChange={(e) => choose(e.target.value ? e.target.value.slice("city:".length) : null)}>
        <option value="">{t("beat.addCity")}</option>
        {cities.map((g) => (
          <option key={g.key} value={`city:${g.key}`}>
            {`${g.label ?? t("collect.noCity")} · ${t("beat.shops", { count: g.rows.length })}`}
          </option>
        ))}
      </Select>
      {group && (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-3 sm:col-span-2" role="group" aria-label={label}>
          <div className="flex items-center gap-2">
            <MapPin size={15} className="shrink-0 text-ink-3" aria-hidden />
            <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{`${label} · ${t("beat.shops", { count: group.rows.length })}`}</p>
            <IconButton label={t("common.close")} onClick={() => choose(null)}>
              <X size={15} />
            </IconButton>
          </div>
          {candidates.length === 0 ? (
            <p className="text-[13px] text-ink-3">{t("beat.allHere", { city: label })}</p>
          ) : (
            <>
              {already > 0 && <p className="text-[12.5px] text-ink-3">{t("beat.alreadyHere", { count: already })}</p>}
              {candidates.length > FIND_FROM && (
                <Input inputSize="sm" leading={<Search size={14} />} placeholder={t("beat.findShops")} aria-label={t("beat.findShops")} value={query} onChange={(e) => setQuery(e.target.value)} />
              )}
              <Checkbox
                label={t("beat.tickAll", { n: visible.length })}
                checked={visible.length > 0 && visible.every((s) => picked.has(s.id))}
                disabled={visible.length === 0}
                onChange={(on) => tick(visible.map((s) => s.id), on)}
              />
              <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-xl border border-line bg-surface">
                {visible.map((s) => (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2">
                      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" checked={picked.has(s.id)} onChange={(e) => tick([s.id], e.target.checked)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-ink">{s.name}</span>
                        {(s.address || s.pincode) && <span className="block truncate text-[12px] text-ink-3">{[s.address, s.pincode].filter(Boolean).join(" · ")}</span>}
                        {elsewhere(s) && <span className="block truncate text-[12px] text-warn">{routeName.has(s.routeId ?? "") ? t("beat.onRoute", { route: routeName.get(s.routeId ?? "") }) : t("beat.onOtherRoute")}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end">
                <Button size="sm" variant="primary" icon={<Plus size={15} />} disabled={chosen.length === 0} onClick={add}>
                  {t("beat.addShops", { count: chosen.length })}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
