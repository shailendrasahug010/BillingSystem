import { useQuery } from "@tanstack/react-query";
import type { TranslationKey } from "@digitalbahi/i18n";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/misc";
import { ErrorNote, FilterBar, LoadMore, PageHeader } from "../../components/ui/Page";
import { allowed } from "../../data/db";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { usePaged } from "../../lib/usePaged";

interface AuditRow {
  id: number;
  userId: string | null;
  userName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  changes: unknown;
  ip: string | null;
  createdAt: string;
}

const ENTITIES = [
  "invoice",
  "payment",
  "purchase",
  "purchase_order",
  "goods_receipt",
  "stock_adjustment",
  "product",
  "customer",
  "supplier",
  "member",
  "role",
  "setting",
  "business",
  "document_series",
  "scheme",
] as const;

const show = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** A change set as "field: old → new" lines (the API stores [old, new] pairs), anything else as-is. */
function Changes({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return <span className="text-ink-3">—</span>;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="text-ink-3">—</span>;
  return (
    <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1 text-[12.5px]">
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="font-mono text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink">
            {Array.isArray(v) && v.length === 2 ? (
              <>
                <span className="text-danger line-through decoration-danger/50">{show(v[0])}</span> → <span className="text-good">{show(v[1])}</span>
              </>
            ) : (
              show(v)
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Who did what, when: every posting, cancellation, price or role change and
 * setting is written by the API in the same transaction as the change.
 * Read-only; the table rejects updates and deletes.
 */
export function AuditLogPage() {
  const { t, dateTime } = useI18n();
  const [entityType, setEntityType] = useState("");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const list = usePaged<AuditRow>("audit", "/audit-logs", { entityType, userId, from, to });
  const members = useQuery({
    queryKey: ["team", "members"],
    queryFn: () => api.get<{ data: Array<{ userId: string; name: string }> }>("/members").then((r) => r.data),
    enabled: allowed("user.view"),
  });
  const time = (iso: string) => dateTime(iso);
  const entityLabel = (e: string | null) => (e && (ENTITIES as readonly string[]).includes(e) ? t(`audit.entities.${e}` as TranslationKey) : (e ?? "—"));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("audit.title")} subtitle={t("audit.subtitle")} />
      <FilterBar>
        <Select aria-label={t("audit.entity")} value={entityType} onChange={(e) => setEntityType(e.target.value)} className="md:w-52">
          <option value="">
            {t("audit.entity")}: {t("common.all")}
          </option>
          {ENTITIES.map((e) => (
            <option key={e} value={e}>
              {t(`audit.entities.${e}`)}
            </option>
          ))}
        </Select>
        {members.data && (
          <Select aria-label={t("audit.user")} value={userId} onChange={(e) => setUserId(e.target.value)} className="md:w-52">
            <option value="">
              {t("audit.user")}: {t("common.all")}
            </option>
            {members.data.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
        )}
        <Input type="date" aria-label={t("common.from")} value={from} onChange={(e) => setFrom(e.target.value)} className="md:w-40" />
        <Input type="date" aria-label={t("common.to")} value={to} onChange={(e) => setTo(e.target.value)} className="md:w-40" />
      </FilterBar>
      {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
        {list.loading ? (
          <div className="flex flex-col gap-3 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : list.rows.length === 0 ? (
          <p className="p-6 text-center text-[14px] text-ink-3">{t("audit.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.rows.map((r) => {
              const expanded = open === r.id;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : r.id)}
                    className={cn("flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-surface-2", expanded && "bg-surface-2")}
                  >
                    <span className="mt-0.5 text-ink-3">{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                    <span className="num w-28 shrink-0 text-[12.5px] text-ink-3">{time(r.createdAt)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] text-ink">
                        <span className="font-medium">{r.userName ?? t("audit.system")}</span> · <span className="font-mono text-[12.5px]">{r.action}</span>
                      </span>
                      <span className="block truncate text-[12.5px] text-ink-3">
                        {entityLabel(r.entityType)}
                        {r.entityLabel && ` · ${r.entityLabel}`}
                      </span>
                    </span>
                  </button>
                  {expanded && (
                    <div className="flex flex-col gap-2 bg-surface-2 px-4 pt-1 pb-3 pl-11">
                      <Changes value={r.changes} />
                      {r.ip && <p className="text-[12px] text-ink-3">IP {r.ip}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
    </div>
  );
}
