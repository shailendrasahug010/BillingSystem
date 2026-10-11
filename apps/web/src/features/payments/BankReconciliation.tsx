import type { BankLineView, BankStatementView, BrsBookEntry, BrsView } from "@digitalbahi/contracts";
import { isStatementHeader, readBankStatement } from "@digitalbahi/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileUp, Landmark, Search, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { useConfirm } from "../../components/ui/Confirm";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { ErrorNote, FilterBar, LoadMore } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { allowed, customerById, supplierById } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { readSheetFile, SheetError } from "../../lib/sheet";
import { usePaged } from "../../lib/usePaged";
import { searchCustomers } from "../invoice/CustomerPicker";
import { searchSuppliers, supplierLabel } from "../suppliers/search";
import { invalidateMoney } from "./PaymentDialog";

interface Account {
  id: string;
  name: string;
  type: "cash" | "bank" | "upi" | "wallet" | "card";
  bankName: string | null;
  accountNumberLast4: string | null;
  isActive: boolean;
  isDefault: boolean;
}

type Action = "receipt" | "payment" | "link" | "bank_charge" | "interest" | "cash_deposit" | "cash_withdrawal" | "ignore";

/** What the person chose for an open line (starts from the suggestion). */
interface Choice {
  action: Action | "";
  partyId: string | null;
  documentId: string | null;
  picked: boolean;
}

const ACCEPT = ".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SUGGESTION_TONE: Record<string, Tone> = { matched: "good", likely: "accent", unmatched: "warn", recorded: "neutral" };
const IN_ACTIONS: Action[] = ["receipt", "link", "interest", "cash_deposit", "ignore"];
const OUT_ACTIONS: Action[] = ["payment", "link", "bank_charge", "interest", "cash_withdrawal", "ignore"];
const OWN_KINDS = new Set(["bank_charge", "interest", "cash_deposit", "cash_withdrawal"]);

/** The first choice for a line: the bank's own kind, else the customer or supplier found (ticked when sure). */
function suggested(line: BankLineView): Choice {
  const s = line.suggestion;
  const inflow = Number(line.amount) > 0;
  if (s?.kind && OWN_KINDS.has(s.kind) && s.status !== "matched") return { action: s.kind as Action, partyId: null, documentId: null, picked: true };
  if (s?.partyId && (s.status === "matched" || s.status === "likely")) return { action: inflow ? "receipt" : "payment", partyId: s.partyId, documentId: null, picked: s.status === "matched" };
  return { action: "", partyId: null, documentId: null, picked: false };
}

/** A choice that can be sent: an action, with the party or entry it needs. */
const complete = (c: Choice) => c.action !== "" && (c.action === "receipt" || c.action === "payment" ? Boolean(c.partyId) : c.action === "link" ? Boolean(c.documentId) : true);

/**
 * Payments → Bank: statements imported per bank account and reconciled line
 * by line (or the ticked ones in one go), with the bank reconciliation
 * statement above: the bank's balance, the books', and what explains the
 * difference.
 */
export function BankReconciliation() {
  const { t } = useI18n();
  const accounts = useQuery({ queryKey: ["payment-accounts"], queryFn: () => api.get<{ data: Account[] }>("/payment-accounts") });
  const banks = useMemo(() => (accounts.data?.data ?? []).filter((a) => a.type !== "cash" && a.isActive), [accounts.data]);
  const [accountId, setAccountId] = useState<string | null>(null);
  useEffect(() => {
    if (!banks.length) return;
    if (!accountId || !banks.some((a) => a.id === accountId)) setAccountId((banks.find((a) => a.isDefault) ?? banks[0]!).id);
  }, [banks, accountId]);

  if (accounts.error) return <ErrorNote error={accounts.error} onRetry={() => void accounts.refetch()} />;
  if (!accounts.data) {
    return (
      <p className="text-[13px] text-ink-3" role="status">
        {t("common.loading")}
      </p>
    );
  }
  if (!banks.length) return <AddBankAccount onAdded={(id) => (setAccountId(id), void accounts.refetch())} />;
  return (
    <div className="flex flex-col gap-4" data-bank-tab>
      {accountId && <AccountReconciliation key={accountId} accountId={accountId} banks={banks} onAccount={setAccountId} />}
    </div>
  );
}

/** No bank account yet: the one the statements are of, added here. */
function AddBankAccount({ onAdded }: { onAdded(id: string): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState("");
  const [bankName, setBankName] = useState("");
  const [last4, setLast4] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api.post<Account>("/payment-accounts", {
        name: name.trim(),
        type: "bank",
        ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
        ...(/^\d{4}$/.test(last4) ? { accountNumberLast4: last4 } : {}),
      }),
    onSuccess: (a) => {
      toast({ tone: "success", title: t("bank.accountAdded") });
      onAdded(a.id);
    },
  });
  return (
    <Card>
      <CardHeader title={t("bank.addAccount")} subtitle={t("bank.noAccount")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {allowed("settings.update") ? (
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && !add.isPending) add.mutate();
            }}
          >
            <Field label={t("bank.accountName")} htmlFor="bank-account-name">
              <Input id="bank-account-name" placeholder="SBI current" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t("bank.bankName")} htmlFor="bank-account-bank">
              <Input id="bank-account-bank" value={bankName} onChange={(e) => setBankName(e.target.value)} />
            </Field>
            <Field label={t("bank.last4")} htmlFor="bank-account-last4">
              <Input id="bank-account-last4" inputMode="numeric" value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} />
            </Field>
            <div className="flex items-center justify-end gap-3 sm:col-span-3">
              <ErrorNote error={add.error} />
              <Button type="submit" variant="primary" icon={<Landmark size={16} />} disabled={!name.trim() || add.isPending}>
                {t("bank.addAccount")}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-[13px] text-ink-2">{t("bank.noAccountRights")}</p>
        )}
      </div>
    </Card>
  );
}

function AccountReconciliation({ accountId, banks, onAccount }: { accountId: string; banks: Account[]; onAccount(id: string): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"open" | "reconciled" | "ignored" | "all">("open");
  const [q, setQ] = useState("");
  const [statementId, setStatementId] = useState<string>("");
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canWork = allowed("payment.collect") || allowed("payment.pay");

  const statements = useQuery({ queryKey: ["bank-statements", accountId], queryFn: () => api.get<{ data: BankStatementView[] }>("/bank-statements", { accountId }) });
  const brs = useQuery({ queryKey: ["bank-brs", accountId, statementId], queryFn: () => api.get<BrsView>("/bank-statements/brs", { accountId, ...(statementId ? { statementId } : {}) }) });
  const lines = usePaged<BankLineView>("bank-lines", "/bank-statement-lines", { accountId, status, q: q.trim().length >= 2 ? q.trim() : undefined }, { pageSize: 100 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["bank-lines"] });
    void qc.invalidateQueries({ queryKey: ["bank-statements", accountId] });
    void qc.invalidateQueries({ queryKey: ["bank-brs", accountId] });
  };
  const choiceOf = (line: BankLineView) => choices[line.id] ?? suggested(line);
  const choose = (line: BankLineView, patch: Partial<Choice>) => setChoices((all) => ({ ...all, [line.id]: { ...choiceOf(line), ...patch } }));

  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const sheet = await readSheetFile(file, { isHeader: isStatementHeader });
      const read = readBankStatement(sheet.rows);
      if (!read || read.lines.length === 0) throw new ApiError(400, "BANK_STATEMENT_UNREADABLE");
      const done = await api.post<{ added: number; known: number; reconciled: number }>("/bank-statements", { paymentAccountId: accountId, fileName: file.name.slice(0, 200), lines: read.lines.slice(0, 5000) });
      toast({ tone: "success", title: t("bank.imported", { added: done.added, known: done.known, reconciled: done.reconciled }) });
      setStatementId("");
      setStatus("open");
      refresh();
      if (done.reconciled) invalidateMoney(qc);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(400, e instanceof SheetError ? e.code : "BANK_STATEMENT_UNREADABLE"));
    } finally {
      setBusy(false);
    }
  };

  const send = async (actions: Array<Record<string, unknown>>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ done: number; results: Array<{ lineId: string; ok: boolean; error?: { code: string; params: Record<string, string | number> } }> }>("/bank-statement-lines/reconcile", { actions });
      const failed = res.results.filter((r) => !r.ok);
      if (res.done) toast({ tone: "success", title: t("bank.reconciled", { count: res.done }) });
      if (failed.length) setError(new ApiError(409, failed[0]!.error?.code ?? "generic", failed[0]!.error?.params ?? {}));
      setChoices((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !res.results.some((r) => r.ok && r.lineId === id))));
      refresh();
      invalidateMoney(qc);
      return res;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const actionOf = (line: BankLineView, c: Choice): Record<string, unknown> => {
    switch (c.action) {
      case "receipt":
        return { lineId: line.id, action: "receipt", customerId: c.partyId };
      case "payment":
        return { lineId: line.id, action: "payment", supplierId: c.partyId };
      case "link": {
        const [type, id] = (c.documentId ?? "").split(":");
        return { lineId: line.id, action: "link", documentType: type, documentId: id };
      }
      default:
        return { lineId: line.id, action: c.action };
    }
  };
  const ready = lines.rows.filter((l) => l.status === "open" && choiceOf(l).picked && complete(choiceOf(l)));

  const removeStatement = (s: BankStatementView) =>
    void confirm({ title: t("bank.deleteTitle"), body: t("bank.deleteBody"), confirmLabel: t("bank.deleteStatement"), danger: true }).then(async (yes) => {
      if (!yes) return;
      try {
        await api.delete(`/bank-statements/${s.id}`);
        toast({ tone: "success", title: t("bank.deleted") });
        setStatementId("");
        refresh();
      } catch (e) {
        setError(e);
      }
    });

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1 sm:flex-none">
          <Field label={t("bank.account")} htmlFor="bank-account">
            <Select id="bank-account" value={accountId} onChange={(e) => onAccount(e.target.value)}>
              {banks.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.accountNumberLast4 ? ` ··${a.accountNumberLast4}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {canWork && (
          <>
            <input
              ref={input}
              id="bank-file"
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importFile(f);
              }}
            />
            <Button variant="primary" icon={<FileUp size={16} />} disabled={busy} onClick={() => input.current?.click()}>
              {busy ? t("bank.importing") : t("bank.import")}
            </Button>
          </>
        )}
      </div>
      <ErrorNote error={error} />
      <BrsCard
        accountId={accountId}
        brs={brs.data ?? null}
        error={brs.error}
        statements={statements.data?.data ?? []}
        statementId={statementId}
        onStatement={setStatementId}
        onDelete={canWork ? removeStatement : null}
        onChanged={() => void qc.invalidateQueries({ queryKey: ["bank-brs", accountId] })}
      />

      <FilterBar
        quick={
          <Segmented
            size="sm"
            label={t("common.status")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "open", label: t("bank.filters.open") },
              { value: "reconciled", label: t("bank.filters.reconciled") },
              { value: "ignored", label: t("bank.filters.ignored") },
              { value: "all", label: t("bank.filters.all") },
            ]}
          />
        }
      >
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("bank.search")} aria-label={t("bank.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      </FilterBar>
      {lines.error ? <ErrorNote error={lines.error} onRetry={() => void lines.refetch()} /> : null}
      {lines.rows.length === 0 && !lines.loading ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-ink-3">{(statements.data?.data.length ?? 0) > 0 ? t("bank.emptyOpen") : t("bank.emptyNone")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface" aria-label={t("bank.lines")}>
          {lines.rows.map((line) => (
            <LineRow
              key={line.id}
              line={line}
              choice={choiceOf(line)}
              busy={busy}
              canWork={canWork}
              onChoose={(patch) => choose(line, patch)}
              onUndo={() => void send([{ lineId: line.id, action: "undo" }]).then((r) => r?.done && toast({ tone: "info", title: t("bank.undone") }))}
            />
          ))}
        </ul>
      )}
      <LoadMore hasMore={lines.hasMore} loading={lines.loadingMore} onClick={lines.loadMore} />
      {canWork && status !== "reconciled" && status !== "ignored" && (
        <div className="sticky bottom-3 z-10 flex justify-end">
          <Button variant="primary" icon={<CheckCircle2 size={16} />} disabled={busy || ready.length === 0} onClick={() => void send(ready.map((l) => actionOf(l, choiceOf(l))))} data-reconcile>
            {t("bank.reconcile", { count: ready.length })}
          </Button>
        </div>
      )}
      <p className="text-[12.5px] text-ink-3">{t("bank.hintSaved")}</p>
    </>
  );
}

function BrsCard({
  accountId,
  brs,
  error,
  statements,
  statementId,
  onStatement,
  onDelete,
  onChanged,
}: {
  accountId: string;
  brs: BrsView | null;
  error: unknown;
  statements: BankStatementView[];
  statementId: string;
  onStatement(id: string): void;
  onDelete: ((s: BankStatementView) => void) | null;
  onChanged(): void;
}) {
  const { t, money, dateMedium } = useI18n();
  const toast = useToast();
  const [showEntries, setShowEntries] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const saveOpening = useMutation({
    mutationFn: (value: string) => api.patch(`/payment-accounts/${accountId}`, { openingBalance: value }),
    onSuccess: () => {
      setOpening(null);
      toast({ tone: "success", title: t("bank.brs.openingSaved") });
      onChanged();
    },
  });
  if (error) return <ErrorNote error={error} />;
  if (!brs) return null;
  const current = statements.find((s) => s.id === (statementId || brs.statementId));
  const agrees = brs.difference !== null && Number(brs.difference) === 0;
  const stat = (label: string, value: string, sub?: string, tone?: "good" | "danger") => (
    <div className="flex flex-col gap-0.5 rounded-xl bg-surface-2/60 px-3 py-2.5">
      <span className="text-[12px] text-ink-3">{label}</span>
      <span className={cn("num text-[16px] font-semibold text-ink", tone === "good" && "text-good", tone === "danger" && "text-danger")}>{value}</span>
      {sub && <span className="text-[12px] text-ink-3">{sub}</span>}
    </div>
  );
  return (
    <Card data-brs>
      <CardHeader title={t("bank.brs.title")} subtitle={brs.asOf ? t("bank.brs.asOf", { date: dateMedium(brs.asOf) }) : t("bank.brs.none")} />
      <div className="flex flex-col gap-3 p-4 pt-0 sm:p-5 sm:pt-0">
        {statements.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1 sm:flex-none">
              <Field label={t("bank.brs.statement")} htmlFor="bank-statement">
                <Select id="bank-statement" value={statementId || brs.statementId || ""} onChange={(e) => onStatement(e.target.value)}>
                  {statements.map((s) => (
                    <option key={s.id} value={s.id}>
                      {t("bank.statementLine", { from: dateMedium(s.periodFrom), to: dateMedium(s.periodTo), file: s.fileName ?? "" })}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {onDelete && current && (
              <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => onDelete(current)}>
                {t("bank.deleteStatement")}
              </Button>
            )}
          </div>
        )}
        {brs.asOf && (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              {stat(t("bank.brs.bankBalance"), brs.bankBalance === null ? "—" : money(brs.bankBalance), brs.bankBalance === null ? t("bank.brs.noBankBalance") : undefined)}
              {stat(t("bank.brs.notInBooks"), `+${money(brs.notInBooks.credits)} −${money(brs.notInBooks.debits)}`, t("bank.brs.lines", { count: brs.notInBooks.count }))}
              {stat(t("bank.brs.notInBank"), `+${money(brs.notInBank.receipts)} −${money(brs.notInBank.payments)}`, t("bank.brs.entries", { count: brs.notInBank.count }))}
              {stat(t("bank.brs.booksBalance"), money(brs.booksBalance))}
              {stat(
                t("bank.brs.difference"),
                brs.difference === null ? "—" : money(brs.difference),
                brs.difference === null ? undefined : agrees ? t("bank.brs.agrees") : t("bank.brs.differs"),
                brs.difference === null ? undefined : agrees ? "good" : "danger",
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3" data-opening>
              {opening === null ? (
                <>
                  <span>{t("bank.brs.opening", { amount: money(brs.openingBalance) })}</span>
                  {allowed("settings.update") && (
                    <button type="button" className="press font-medium text-accent hover:underline" onClick={() => setOpening(brs.openingBalance)}>
                      {t("bank.brs.changeOpening")}
                    </button>
                  )}
                </>
              ) : (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (/^-?\d{1,13}(\.\d{1,2})?$/.test(opening.trim())) saveOpening.mutate(opening.trim());
                  }}
                >
                  <Input aria-label={t("bank.brs.openingLabel")} inputMode="decimal" className="w-40" value={opening} onChange={(e) => setOpening(e.target.value)} />
                  <Button type="submit" size="sm" variant="primary" disabled={saveOpening.isPending}>
                    {t("common.save")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOpening(null)}>
                    {t("common.cancel")}
                  </Button>
                  <span>{t("bank.brs.openingHint")}</span>
                  <ErrorNote error={saveOpening.error} />
                </form>
              )}
            </div>
            {brs.notInBank.count > 0 && (
              <div>
                <button type="button" className="press text-[13px] font-medium text-accent hover:underline" aria-expanded={showEntries} onClick={() => setShowEntries((v) => !v)}>
                  {t("bank.brs.showEntries", { count: brs.notInBank.count })}
                </button>
                {showEntries && <BookEntries entries={brs.notInBank.entries} />}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function BookEntries({ entries }: { entries: BrsBookEntry[] }) {
  const { t, money, dateMedium } = useI18n();
  return (
    <ul className="mt-2 flex flex-col divide-y divide-line rounded-xl border border-line" data-brs-entries>
      {entries.map((e) => (
        <li key={`${e.type}-${e.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
          <span className="min-w-0">
            <span className="block truncate text-ink">
              {e.label ?? t(`bank.kinds.${e.type === "transfer" ? "other" : e.direction === "in" ? "receipt" : "payment"}`)}
              {e.number ? <span className="text-ink-3"> · {e.number}</span> : null}
            </span>
            <span className="text-[12px] text-ink-3">
              {dateMedium(e.date)}
              {e.reference ? ` · ${e.reference}` : ""}
            </span>
          </span>
          <span className={cn("num shrink-0 font-medium", e.direction === "in" ? "text-good" : "text-ink")}>
            {e.direction === "in" ? "+" : "−"}
            {money(e.amount)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LineRow({ line, choice, busy, canWork, onChoose, onUndo }: { line: BankLineView; choice: Choice; busy: boolean; canWork: boolean; onChoose(patch: Partial<Choice>): void; onUndo(): void }) {
  const { t, money, dateMedium } = useI18n();
  const inflow = Number(line.amount) > 0;
  const open = line.status === "open";
  const actions = inflow ? IN_ACTIONS : OUT_ACTIONS;
  const s = line.suggestion;
  const partyLabel = (id: string | null) => {
    if (!id) return null;
    if (inflow) {
      const c = customerById.get(id);
      return c ? c.businessName || c.name : s?.partyId === id ? s.partyName : null;
    }
    const sup = supplierById.get(id);
    return sup ? supplierLabel(sup) : s?.partyId === id ? s.partyName : null;
  };
  const candidates = useQuery({
    queryKey: ["bank-line-candidates", line.id],
    queryFn: () => api.get<{ data: BrsBookEntry[] }>(`/bank-statement-lines/${line.id}/candidates`),
    enabled: open && choice.action === "link",
  });
  const reasons = (s?.reasons ?? []).map((r) => t(`bank.reasons.${r}` as "bank.reasons.name")).join(", ");
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 lg:flex-row lg:items-center" data-line={line.row} data-line-status={line.status}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {open && canWork ? (
          <Checkbox checked={choice.picked && complete(choice)} disabled={!complete(choice)} onChange={(v) => onChoose({ picked: v })} label={<span className="sr-only">{t("bank.pick", { row: line.row })}</span>} />
        ) : (
          <span className="w-4" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={cn("num font-semibold", inflow ? "text-good" : "text-ink")}>
              {inflow ? "+" : "−"}
              {money(Math.abs(Number(line.amount)))}
            </span>
            <span className="text-[12.5px] text-ink-3">{dateMedium(line.date)}</span>
            {open ? (
              s && <Badge tone={SUGGESTION_TONE[s.status] ?? "neutral"}>{t(`bank.status.${s.status}`)}</Badge>
            ) : (
              <Badge tone={line.status === "reconciled" ? "good" : "neutral"}>{t(`bank.lineStatus.${line.status}`)}</Badge>
            )}
          </div>
          <p className="truncate text-[12.5px] text-ink-3" title={line.narration}>
            {line.narration || line.reference}
          </p>
          {open && reasons && s?.partyName && (
            <p className="text-[12px] text-ink-3">{t("bank.suggested", { party: s.partyName, reasons })}</p>
          )}
          {!open && line.document && (
            <p className="text-[12.5px] text-ink-2" data-line-document>
              {line.kind ? `${t(`bank.kinds.${line.kind}`)} · ` : ""}
              {[line.document.label, line.document.number].filter(Boolean).join(" · ")}
            </p>
          )}
          {!open && !line.document && line.note && <p className="text-[12.5px] text-ink-2">{line.note}</p>}
        </div>
      </div>
      {open && canWork ? (
        <div className="flex flex-col gap-2 sm:flex-row lg:w-[30rem]">
          <Select aria-label={t("bank.actions.choose")} className="sm:w-44" value={choice.action} onChange={(e) => onChoose({ action: e.target.value as Action | "", documentId: null, picked: e.target.value !== "" && e.target.value !== "receipt" && e.target.value !== "payment" && e.target.value !== "link" ? true : choice.picked })}>
            <option value="">{t("bank.actions.choose")}</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {t(`bank.actions.${a}`)}
              </option>
            ))}
          </Select>
          {(choice.action === "receipt" || choice.action === "payment") && (
            <div className="min-w-0 flex-1">
              <SearchSelect
                id={`bank-party-${line.row}`}
                value={choice.partyId}
                onChange={(id) => onChoose({ partyId: id, picked: Boolean(id) })}
                selectedLabel={partyLabel(choice.partyId)}
                placeholder={inflow ? t("bank.whoPaid") : t("bank.paidTo")}
                clearLabel={t("common.clear")}
                emptyText={t("search.noResults")}
                search={(text) =>
                  inflow
                    ? searchCustomers(text).map((c) => ({ id: c.id, label: c.businessName || c.name, sub: [c.code, c.city].filter(Boolean).join(" · ") }))
                    : searchSuppliers(text).map((x) => ({ id: x.id, label: supplierLabel(x), sub: [x.code, x.city].filter(Boolean).join(" · ") }))
                }
              />
            </div>
          )}
          {choice.action === "link" && (
            <Select
              aria-label={t("bank.pickEntry")}
              className="min-w-0 flex-1"
              value={choice.documentId ?? ""}
              onChange={(e) => onChoose({ documentId: e.target.value || null, picked: Boolean(e.target.value) })}
            >
              <option value="">{candidates.isPending ? t("common.loading") : candidates.data?.data.length ? t("bank.pickEntry") : t("bank.noEntries")}</option>
              {(candidates.data?.data ?? []).map((c) => (
                <option key={`${c.type}:${c.id}`} value={`${c.type}:${c.id}`}>
                  {[dateMedium(c.date), c.label, c.number].filter(Boolean).join(" · ")}
                </option>
              ))}
            </Select>
          )}
        </div>
      ) : (
        !open &&
        canWork && (
          <Button size="sm" variant="ghost" icon={<Undo2 size={15} />} disabled={busy} onClick={onUndo}>
            {t("bank.undo")}
          </Button>
        )
      )}
    </li>
  );
}
