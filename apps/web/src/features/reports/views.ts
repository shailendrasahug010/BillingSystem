import { REPORT_VIEW_REPORTS, type ReportViewReportKey, type ReportViewSettings } from "@digitalbahi/contracts";
import { useQuery } from "@tanstack/react-query";
import { allowed } from "../../data/db";
import { api } from "../../lib/api";

/** A report tab on the Reports screen (and a report a view is saved for). */
export type ReportTab = ReportViewReportKey;
export type ReportSettings = ReportViewSettings;

export interface SavedView {
  id: string;
  name: string;
  report: ReportTab;
  settings: ReportSettings;
  shared: boolean;
  /** Saved by this person (only they change or delete it). */
  mine: boolean;
  /** Who shared it, for someone else's view. */
  ownerName: string | null;
  updatedAt: string;
}

/** How each report opens before anything is chosen. */
export const REPORT_DEFAULTS: Record<ReportTab, ReportSettings> = {
  insights: { period: "thisMonth", compare: "previous" },
  sales: { period: "thisMonth", groupBy: "day" },
  collections: { period: "thisMonth", groupBy: "day" },
  purchases: { period: "thisMonth", groupBy: "month" },
  outstanding: { party: "customer", basis: "due_date" },
  profit: { period: "thisMonth", groupBy: "product" },
  pnl: { period: "thisMonth" },
  products: { period: "thisMonth" },
};

/**
 * What a view keeps for this report: only its own grouping and filters, a
 * preset period as the preset ("this month" stays this month), a custom one
 * with its dates.
 */
export function savedSettings(report: ReportTab, s: ReportSettings): ReportSettings {
  const def = REPORT_VIEW_REPORTS[report];
  const filters: readonly string[] = def.filters;
  const out: ReportSettings = {};
  if (filters.includes("period")) {
    out.period = s.period ?? "thisMonth";
    if (out.period === "custom") {
      if (s.from) out.from = s.from;
      if (s.to) out.to = s.to;
    }
  }
  if (s.groupBy && (def.groups as readonly string[]).includes(s.groupBy)) out.groupBy = s.groupBy;
  if (filters.includes("party") && s.party) out.party = s.party;
  if (filters.includes("basis") && s.basis) out.basis = s.basis;
  if (filters.includes("movement") && s.movement) out.movement = s.movement;
  if (filters.includes("compare") && s.compare) out.compare = s.compare;
  return out;
}

/** The same report settings, whatever order or leftovers they carry. */
export function sameSettings(report: ReportTab, a: ReportSettings, b: ReportSettings): boolean {
  const key = (s: ReportSettings) => JSON.stringify(Object.entries({ ...REPORT_DEFAULTS[report], ...savedSettings(report, s) }).sort(([x], [y]) => x.localeCompare(y)));
  return key(a) === key(b);
}

/** Whether this person's role opens the report. */
export const opensReport = (report: ReportTab) => allowed(REPORT_VIEW_REPORTS[report].permission);

export function useReportViews() {
  return useQuery({ queryKey: ["report-views"], queryFn: () => api.get<{ data: SavedView[] }>("/report-views"), select: (r) => r.data });
}
