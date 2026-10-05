import { Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { customerById } from "../../data/db";
import { asKept, loadHeld, saveHeld, type KeptDraft } from "./keptDraft";
import type { DraftView } from "./useInvoiceDraft";

/** At most this many bills wait on hold at once. */
const MAX_HELD = 6;

export interface HeldBillsState {
  held: KeptDraft[];
  /** Puts the bill being made aside, for a fresh one. */
  hold(): void;
  /** Brings a held bill back; the one being made, if it has lines, goes on hold in its place. */
  resume(index: number): void;
}

/**
 * Bills put on hold: a half-made bill set aside while the next customer is
 * served, then picked up again. `onRestored` follows the customer (the
 * phone's steps).
 */
export function useHeldBills(view: DraftView, onRestored?: (hasCustomer: boolean) => void): HeldBillsState {
  const { t } = useI18n();
  const toast = useToast();
  const [held, setHeld] = useState<KeptDraft[]>([]);
  useEffect(() => {
    let active = true;
    void loadHeld()
      .then((h) => active && setHeld(h))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const store = (next: KeptDraft[]) => {
    setHeld(next);
    void saveHeld(next);
  };
  const { draft, dispatch } = view;
  return {
    held,
    hold: () => {
      if (draft.lines.length === 0) return;
      if (held.length >= MAX_HELD) {
        toast({ tone: "danger", title: t("invoice.held.full", { max: MAX_HELD }) });
        return;
      }
      store([asKept(draft), ...held]);
      dispatch({ type: "reset" });
      onRestored?.(false);
      toast({ tone: "info", title: t("invoice.held.done"), body: describe(t, asKept(draft)) });
    },
    resume: (index) => {
      const chosen = held[index];
      if (!chosen) return;
      const rest = held.filter((_, i) => i !== index);
      store(draft.lines.length > 0 ? [asKept(draft), ...rest] : rest);
      dispatch({ type: "restore", draft: chosen.draft });
      onRestored?.(Boolean(chosen.draft.customerId && customerById.has(chosen.draft.customerId)));
    },
  };
}

type Translate = ReturnType<typeof useI18n>["t"];
const describe = (t: Translate, kept: KeptDraft) =>
  [kept.draft.customerId ? customerById.get(kept.draft.customerId)?.businessName : t("invoice.held.noCustomer"), t("common.items", { count: kept.draft.lines.length })].join(" · ");

/** The Hold button, for a bill with lines. */
export function HoldButton({ state, hasLines }: { state: HeldBillsState; hasLines: boolean }) {
  const { t } = useI18n();
  if (!hasLines) return null;
  return (
    <Button size="sm" icon={<Pause size={15} />} onClick={state.hold} title={t("invoice.held.holdHint")}>
      {t("invoice.held.hold")}
    </Button>
  );
}

/** The bills on hold, each one tap to pick up again. */
export function HeldBillsBar({ state }: { state: HeldBillsState }) {
  const { t } = useI18n();
  if (state.held.length === 0) return null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-[13px]" role="group" aria-label={t("invoice.held.title")}>
      <span className="shrink-0 font-medium text-ink-2">{t("invoice.held.title")}</span>
      {state.held.map((kept, i) => (
        <button
          key={kept.savedAt + i}
          type="button"
          onClick={() => state.resume(i)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 font-medium text-ink hover:border-accent"
          title={t("invoice.held.resume")}
        >
          <Play size={13} className="text-accent" />
          {describe(t, kept)}
        </button>
      ))}
    </div>
  );
}
