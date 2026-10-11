import type { SchemeClaimLine, SchemeClaimRow, SchemeClaimView, SchemeView } from "@digitalbahi/contracts";
import { useQuery } from "@tanstack/react-query";
import { BadgePercent, Download, Plus, Search } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { DataTable, RowCard, type Column } from "../../components/ui/DataTable";
import { Input, Select } from "../../components/ui/Field";
import { ErrorNote, FilterBar, PageHeader, TAB_TRIGGER, Tile } from "../../components/ui/Page";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { allowed, BRANDS, productById, SUPPLIERS, TODAY, WORKSPACE } from "../../data/db";
import { api } from "../../lib/api";
import { downloadCsv } from "../../lib/download";
import { SchemeEditor } from "./SchemeEditor";

type Status = "running" | "upcoming" | "ended" | "all";

/** What a scheme gives, slab by slab: "From 10: 1 free · From 24: 3 free". */
export function useSchemeText() {
  const { t, number, money } = useI18n();
  return (s: Pick<SchemeView, "kind" | "measure" | "slabs" | "repeat" | "freeProductId">) => {
    const slabs = s.slabs.map((x) => {
      const from = s.measure === "value" ? money(Number(x.from), 0) : number(Number(x.from));
      if (s.kind === "free_goods") {
        const product = s.freeProductId ? productById.get(s.freeProductId)?.name : null;
        return product ? t("schemes.describe.freeOf", { from, qty: number(Number(x.freeQty)), product }) : t("schemes.describe.free", { from, qty: number(Number(x.freeQty)) });
      }
      const parts = [x.discountPercent ? t("schemes.describe.percent", { percent: Number(x.discountPercent) }) : null, x.discountPerUnit ? t("schemes.describe.perUnit", { amount: money(Number(x.discountPerUnit)) }) : null].filter(Boolean);
      return t("schemes.describe.off", { from, off: parts.join(" + ") });
    });
    return [slabs.join(" · "), s.kind === "free_goods" && s.repeat ? t("schemes.describe.repeats") : null].filter(Boolean).join(" ");
  };
}

/** The products, brands and categories it is on, by name. */
function onWhat(s: SchemeView): string {
  const names = [
    ...s.productIds.map((id) => productById.get(id)?.name),
    ...s.brandIds.map((id) => BRANDS.find((b) => b.id === id)?.name),
    ...s.categoryIds.map((id) => WORKSPACE.categories.find((c) => c.id === id)?.name),
  ].filter((x): x is string => Boolean(x));
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
}

const TONE: Record<SchemeView["status"], "good" | "accent" | "neutral" | "warn"> = { running: "good", upcoming: "accent", ended: "neutral", off: "warn" };

function SchemeList() {
  const { t, date: formatDate } = useI18n();
  const describe = useSchemeText();
  const [status, setStatus] = useState<Status>("running");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ scheme: SchemeView | null } | null>(null);
  const list = useQuery({
    queryKey: ["schemes", status, query.trim()],
    queryFn: () => api.get<{ data: SchemeView[] }>("/schemes", { status, ...(query.trim() ? { q: query.trim() } : {}) }).then((r) => r.data),
  });
  const rows = list.data ?? [];
  const period = (s: SchemeView) => (s.validTo ? `${formatDate(s.validFrom)} – ${formatDate(s.validTo)}` : t("schemes.fromOn", { date: formatDate(s.validFrom) }));
  const columns: Column<SchemeView>[] = [
    {
      key: "name",
      header: t("schemes.name"),
      sortValue: (s) => s.name,
      render: (s) => (
        <>
          <p className="font-medium text-ink">{s.name}</p>
          <p className="text-[12px] text-ink-3">{[t(`schemes.kinds.${s.kind}`), s.reference, s.supplierName].filter(Boolean).join(" · ")}</p>
        </>
      ),
    },
    { key: "gives", header: t("schemes.gives"), className: "text-ink-2", render: (s) => describe(s) },
    { key: "on", header: t("schemes.on"), className: "text-ink-2", render: (s) => onWhat(s) },
    { key: "period", header: t("schemes.period"), sortValue: (s) => s.validFrom, className: "text-ink-2", render: (s) => period(s) },
    { key: "for", header: t("schemes.for"), className: "text-ink-2", render: (s) => (s.customerCategoryIds.length || s.priceLevelIds.length ? t("schemes.someCustomers") : t("schemes.allCustomers")) },
    { key: "bills", header: t("schemes.bills"), align: "right", sortValue: (s) => s.bills, render: (s) => s.bills },
    { key: "status", header: t("common.status"), render: (s) => <Badge tone={TONE[s.status]}>{t(`schemes.status.${s.status}`)}</Badge> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        quick={
          <Segmented
            size="sm"
            label={t("common.status")}
            value={status}
            onChange={setStatus}
            options={(["running", "upcoming", "ended", "all"] as const).map((v) => ({ value: v, label: t(`schemes.filter.${v}`) }))}
          />
        }
        actions={
          allowed("product.update_price") ? (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing({ scheme: null })}>
              {t("schemes.new")}
            </Button>
          ) : undefined
        }
      >
        <Input id="scheme-filter" className="flex-1" leading={<Search size={16} />} placeholder={t("schemes.search")} aria-label={t("schemes.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </FilterBar>
      <ErrorNote error={list.error} />
      <DataTable<SchemeView>
        id="schemes"
        rows={rows}
        rowKey={(s) => s.id}
        loading={list.isLoading}
        onRowClick={(s) => setEditing({ scheme: s })}
        minWidth={900}
        columns={columns}
        mobile={(s) => <RowCard title={s.name} sub={describe(s)} value={<Badge tone={TONE[s.status]}>{t(`schemes.status.${s.status}`)}</Badge>} valueSub={period(s)} />}
        empty={<EmptyState icon={<BadgePercent size={20} />} title={t("schemes.none")} hint={t("schemes.noneHint")} />}
      />
      {editing && <SchemeEditor key={editing.scheme?.id ?? "new"} scheme={editing.scheme} open onOpenChange={(v) => !v && setEditing(null)} />}
    </div>
  );
}

const monthStart = () => `${TODAY.slice(0, 8)}01`;

/**
 * What the schemes cost over a period, scheme by scheme, to claim from the
 * companies: goods given free (at cost, and at the bills' rates) and
 * discounts, less returns; with each bill's lines, to send with the claim.
 */
function SchemeClaims() {
  const { t, money, number, date: formatDate } = useI18n();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(TODAY);
  const [supplierId, setSupplierId] = useState("");
  const claims = useQuery({
    queryKey: ["scheme-claims", from, to, supplierId],
    queryFn: () => api.get<SchemeClaimView>("/reports/scheme-claims", { from, to, ...(supplierId ? { supplierId } : {}) }),
    enabled: from !== "" && to !== "" && from <= to,
  });
  const data = claims.data;
  const showCost = data ? data.totals.claim !== null : true;
  const companies = SUPPLIERS.filter((s) => s.name);
  const rowColumns: Column<SchemeClaimRow>[] = [
    {
      key: "name",
      header: t("schemes.name"),
      sortValue: (r) => r.name,
      render: (r) => (
        <>
          <p className="font-medium text-ink">{r.name}</p>
          <p className="text-[12px] text-ink-3">{[r.reference, r.supplierName].filter(Boolean).join(" · ") || t(`schemes.kinds.${r.kind}`)}</p>
        </>
      ),
    },
    { key: "bills", header: t("schemes.bills"), align: "right", sortValue: (r) => r.bills, render: (r) => r.bills },
    ...(showCost ? [{ key: "freeCost", header: t("schemes.claims.freeCost"), align: "right" as const, sortValue: (r: SchemeClaimRow) => Number(r.freeCost), render: (r: SchemeClaimRow) => money(Number(r.freeCost)) }] : []),
    { key: "freeValue", header: t("schemes.claims.freeValue"), align: "right", sortValue: (r) => Number(r.freeValue), className: "text-ink-2", render: (r) => money(Number(r.freeValue)) },
    { key: "discount", header: t("schemes.claims.discount"), align: "right", sortValue: (r) => Number(r.discount), render: (r) => money(Number(r.discount)) },
    ...(showCost ? [{ key: "claim", header: t("schemes.claims.claim"), align: "right" as const, sortValue: (r: SchemeClaimRow) => Number(r.claim), render: (r: SchemeClaimRow) => <span className="font-semibold text-ink">{money(Number(r.claim))}</span> }] : []),
  ];
  const lineColumns: Column<SchemeClaimLine>[] = [
    { key: "date", header: t("common.date"), sortValue: (l) => l.invoiceDate, render: (l) => formatDate(l.invoiceDate) },
    { key: "bill", header: t("invoice.number"), sortValue: (l) => l.invoiceNumber, className: "font-mono text-[12.5px]", render: (l) => l.invoiceNumber },
    { key: "customer", header: t("invoice.customer"), sortValue: (l) => l.customerName, render: (l) => l.customerName },
    { key: "scheme", header: t("schemes.scheme"), sortValue: (l) => l.schemeName, className: "text-ink-2", render: (l) => l.schemeName },
    { key: "product", header: t("invoice.product"), sortValue: (l) => l.productName, render: (l) => l.productName },
    { key: "free", header: t("schemes.claims.freeQty"), align: "right", sortValue: (l) => Number(l.freeQty), render: (l) => (Number(l.freeQty) > 0 ? `${number(Number(l.freeQty))} ${l.unit}` : "—") },
    { key: "discount", header: t("schemes.claims.discount"), align: "right", sortValue: (l) => Number(l.discount), render: (l) => (Number(l.discount) > 0 ? money(Number(l.discount)) : "—") },
  ];
  const download = () => {
    if (!data) return;
    downloadCsv(
      `scheme-claims-${from}-${to}.csv`,
      [
        { label: t("common.date"), value: (l: SchemeClaimLine) => l.invoiceDate },
        { label: t("invoice.number"), value: (l) => l.invoiceNumber },
        { label: t("invoice.customer"), value: (l) => l.customerName },
        { label: t("schemes.scheme"), value: (l) => l.schemeName },
        { label: t("invoice.product"), value: (l) => l.productName },
        { label: t("schemes.claims.freeQty"), value: (l) => l.freeQty },
        { label: t("invoice.unit"), value: (l) => l.unit },
        ...(showCost ? [{ label: t("schemes.claims.freeCost"), value: (l: SchemeClaimLine) => l.freeCost }] : []),
        { label: t("schemes.claims.freeValue"), value: (l) => l.freeValue },
        { label: t("schemes.claims.discount"), value: (l) => l.discount },
      ],
      data.lines,
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        actions={
          <Button icon={<Download size={16} />} disabled={!data?.lines.length} onClick={download}>
            {t("common.export")}
          </Button>
        }
      >
        <Input type="date" aria-label={t("common.from")} value={from} onChange={(e) => setFrom(e.target.value)} className="md:w-40" />
        <Input type="date" aria-label={t("common.to")} value={to} onChange={(e) => setTo(e.target.value)} className="md:w-40" />
        {companies.length > 0 && (
          <Select aria-label={t("schemes.company")} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="md:w-56">
            <option value="">
              {t("schemes.company")}: {t("common.all")}
            </option>
            {companies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </FilterBar>
      <ErrorNote error={claims.error} />
      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-claim-totals>
          {showCost && <Tile label={t("schemes.claims.freeCost")} value={money(Number(data.totals.freeCost))} />}
          <Tile label={t("schemes.claims.freeValue")} value={money(Number(data.totals.freeValue))} />
          <Tile label={t("schemes.claims.discount")} value={money(Number(data.totals.discount))} />
          {showCost && <Tile label={t("schemes.claims.claim")} value={money(Number(data.totals.claim))} tone="good" />}
        </div>
      )}
      <DataTable<SchemeClaimRow>
        id="scheme-claims"
        rows={data?.rows ?? []}
        rowKey={(r) => r.schemeId}
        loading={claims.isLoading}
        minWidth={760}
        columns={rowColumns}
        mobile={(r) => <RowCard title={r.name} sub={t("schemes.claims.billsCount", { count: r.bills })} value={money(Number(r.claim ?? r.freeValue) + (r.claim === null ? Number(r.discount) : 0))} valueSub={r.supplierName ?? undefined} />}
        empty={<EmptyState icon={<BadgePercent size={20} />} title={t("schemes.claims.none")} />}
      />
      {data && data.lines.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-[15px] font-semibold text-ink">{t("schemes.claims.lines")}</h2>
          <DataTable<SchemeClaimLine>
            id="scheme-claim-lines"
            rows={data.lines}
            rowKey={(l) => `${l.invoiceId}|${l.schemeId}|${l.productName}|${l.freeQty}|${l.discount}`}
            pageSize={50}
            minWidth={860}
            columns={lineColumns}
            mobile={(l) => (
              <RowCard
                title={`${l.invoiceNumber} · ${l.customerName}`}
                sub={`${l.schemeName} · ${l.productName}`}
                value={Number(l.freeQty) > 0 ? `${number(Number(l.freeQty))} ${l.unit}` : money(Number(l.discount))}
                valueSub={formatDate(l.invoiceDate)}
              />
            )}
          />
        </section>
      )}
    </div>
  );
}

/**
 * Trade schemes: the ones running, coming and ended, kept by those who set
 * prices; bills give them by themselves. The claims tab adds up what each
 * cost, to claim from the company.
 */
export function SchemesPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState("schemes");
  const claims = allowed("report.view_sales");
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("schemes.title")} subtitle={t("schemes.subtitle")} />
      <Tabs.Root value={tab} onValueChange={setTab} className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("schemes.title")}>
          <Tabs.Trigger value="schemes" className={TAB_TRIGGER}>
            {t("schemes.tab")}
          </Tabs.Trigger>
          {claims && (
            <Tabs.Trigger value="claims" className={TAB_TRIGGER} data-tab="claims">
              {t("schemes.claims.tab")}
            </Tabs.Trigger>
          )}
        </Tabs.List>
        <Tabs.Content value="schemes">
          <SchemeList />
        </Tabs.Content>
        {claims && (
          <Tabs.Content value="claims">
            <SchemeClaims />
          </Tabs.Content>
        )}
      </Tabs.Root>
    </div>
  );
}
