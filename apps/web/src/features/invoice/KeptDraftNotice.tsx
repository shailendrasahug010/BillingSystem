import { History } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { customerById } from "../../data/db";
import { draftOutlivesReload, dropKeptDraft, keepDraft, loadKeptDraft, type KeptDraft } from "./keptDraft";
import type { DraftView } from "./useInvoiceDraft";

export interface KeptDraftState {
  /** A bill left half made for another customer, offered while this one has no lines. */
  offered: KeptDraft | null;
  resume(): void;
  discard(): void;
  /** Changes when a kept bill is brought back or put away (the phone's steps follow the customer). */
  restoredAt: number;
}

/**
 * Keeps the bill being made while it is not saved, and brings it back on the
 * next visit to the bill screen (another screen and back, a reload, the app
 * reopened). Opened for another customer, the kept bill is offered instead.
 */
export function useKeptDraft(view: DraftView, routeCustomerId: string | null): KeptDraftState {
  const { t } = useI18n();
  const toast = useToast();
  const { draft, dispatch } = view;
  const [ready, setReady] = useState(false);
  const [offered, setOffered] = useState<KeptDraft | null>(null);
  const [restoredAt, setRestoredAt] = useState(0);
  const latest = useRef(draft);
  latest.current = draft;

  const describe = (kept: KeptDraft) =>
    [kept.draft.customerId ? customerById.get(kept.draft.customerId)?.businessName : null, t("common.items", { count: kept.draft.lines.length })].filter(Boolean).join(" · ");

  const restore = (kept: KeptDraft) => {
    dispatch({ type: "restore", draft: kept.draft });
    setRestoredAt(Date.now());
  };

  useEffect(() => {
    let active = true;
    void loadKeptDraft()
      .then((kept) => {
        if (!active || !kept || kept.draft.lines.length === 0 || latest.current.lines.length > 0) return;
        if (routeCustomerId && kept.draft.customerId !== routeCustomerId) {
          setOffered(kept);
          return;
        }
        restore(kept);
        toast({
          tone: "info",
          title: t("invoice.kept.restored"),
          body: describe(kept),
          action: {
            label: t("invoice.kept.startNew"),
            onClick: () => {
              void dropKeptDraft();
              dispatch({ type: "reset", customerId: routeCustomerId });
              setRestoredAt(Date.now());
            },
          },
        });
      })
      .catch(() => undefined)
      .finally(() => active && setReady(true));
    return () => {
      active = false;
    };
    // Once, when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each change kept a moment later. A bill whose lines were all removed is not kept; one never
  // started here leaves a kept bill alone (it may be another visit's, not read yet).
  const hadLines = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (draft.lines.length === 0) {
      if (hadLines.current) void dropKeptDraft();
      hadLines.current = false;
      return;
    }
    hadLines.current = true;
    if (offered) setOffered(null);
    // In memory at once (another screen and back), on the device a moment later.
    void keepDraft(draft, false);
    const timer = setTimeout(() => void keepDraft(draft), 300);
    return () => clearTimeout(timer);
  }, [ready, draft, offered]);

  // Leaving the page (a reload, the tab or app closed): the last change is kept at once.
  useEffect(() => {
    const flush = () => {
      if (latest.current.lines.length > 0) void keepDraft(latest.current);
    };
    // Where a reload would lose it (the demo, a device without its copy open), the browser asks first.
    const warn = (e: BeforeUnloadEvent) => {
      if (latest.current.lines.length > 0 && !draftOutlivesReload()) e.preventDefault();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", warn);
    };
  }, []);

  return {
    offered: draft.lines.length === 0 ? offered : null,
    resume: () => {
      if (!offered) return;
      restore(offered);
      setOffered(null);
    },
    discard: () => {
      setOffered(null);
      void dropKeptDraft();
    },
    restoredAt,
  };
}

/** The offer of a bill left half made for another customer. */
export function KeptDraftOffer({ state }: { state: KeptDraftState }) {
  const { t } = useI18n();
  const kept = state.offered;
  if (!kept) return null;
  const customer = kept.draft.customerId ? customerById.get(kept.draft.customerId)?.businessName : null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-accent-soft/60 px-3.5 py-2.5 text-[13.5px] text-ink">
      <History size={16} className="shrink-0 text-accent" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{t("invoice.kept.offer")}</span> {[customer, t("common.items", { count: kept.draft.lines.length })].filter(Boolean).join(" · ")}
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={state.discard}>
          {t("invoice.kept.discard")}
        </Button>
        <Button size="sm" variant="primary" onClick={state.resume}>
          {t("invoice.kept.resume")}
        </Button>
      </div>
    </div>
  );
}
