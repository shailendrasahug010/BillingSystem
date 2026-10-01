import type { TranslationKey } from "@digitalbahi/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CloudOff } from "lucide-react";
import { useCallback, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api } from "../../lib/api";
import { displayParams } from "../notifications/notifications";

/** Why a bill made offline was held (invoices.review_reasons). */
export interface ReviewReason {
  code: string;
  params?: Record<string, string | number>;
}

export interface ReviewFields {
  id: string;
  reviewStatus?: "needs_review" | "reviewed" | null;
  reviewReasons?: ReviewReason[] | null;
  reviewNote?: string | null;
  reviewedAt?: string | null;
  reviewerName?: string | null;
}

/** A reason in the app's language ("Tea was billed at ₹100.00; the rate list says ₹120.00."). */
export function useReviewReasonText(): (r: ReviewReason) => string {
  const { t, has, locale } = useI18n();
  return useCallback(
    (r) => {
      const key = `notifications.review.${r.code}`;
      return has(key) ? t(key as TranslationKey, displayParams(r.params ?? {}, locale)) : r.code;
    },
    [t, has, locale],
  );
}

/**
 * A bill made offline that broke a rule by the time it reached the server:
 * posted (stock and the customer's balance have moved), and held until a
 * manager marks it reviewed, or cancels it. Shows why, and who reviewed it.
 */
export function InvoiceReviewCard({ invoice, cancelled }: { invoice: ReviewFields; cancelled: boolean }) {
  const { t, dateTime } = useI18n();
  const reasonText = useReviewReasonText();
  const toast = useToast();
  const client = useQueryClient();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!invoice.reviewStatus) return null;
  const held = invoice.reviewStatus === "needs_review";
  const reasons = invoice.reviewReasons ?? [];

  const markReviewed = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/invoices/${invoice.id}/review`, note.trim() ? { note: note.trim() } : {});
      toast({ tone: "success", title: t("invoice.review.done") });
      await Promise.all([client.invalidateQueries({ queryKey: ["invoice-raw", invoice.id] }), client.invalidateQueries({ queryKey: ["home"] })]);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label={t("invoice.review.title")}
      className={held ? "rounded-[var(--radius-card)] border border-warn/40 bg-warn-soft/60 p-4" : "rounded-[var(--radius-card)] border border-line bg-surface p-4"}
      data-review={invoice.reviewStatus}
    >
      <p className="flex items-center gap-2 text-[14.5px] font-semibold text-ink">
        {held ? <CloudOff size={16} className="text-warn" /> : <CheckCircle2 size={16} className="text-good" />}
        {held ? t("invoice.review.title") : t("invoice.review.reviewedTitle")}
      </p>
      <ul className="mt-2 list-disc pl-5 text-[13.5px] text-ink-2">
        {reasons.map((r, i) => (
          <li key={i}>{reasonText(r)}</li>
        ))}
      </ul>
      {held ? (
        <>
          <p className="mt-2 text-[12.5px] text-ink-3">{t("invoice.review.hint")}</p>
          {allowed("invoice.review") && !cancelled && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input aria-label={t("invoice.review.note")} placeholder={t("invoice.review.note")} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="sm:max-w-md" />
              <Button variant="primary" size="sm" disabled={saving} onClick={() => void markReviewed()}>
                {t("invoice.review.markReviewed")}
              </Button>
            </div>
          )}
          {error ? <ErrorNote error={error} className="mt-2" /> : null}
        </>
      ) : (
        <p className="mt-2 text-[12.5px] text-ink-3">
          {t("invoice.review.reviewedBy", { name: invoice.reviewerName ?? "—", when: invoice.reviewedAt ? dateTime(invoice.reviewedAt) : "—" })}
          {invoice.reviewNote && ` · ${invoice.reviewNote}`}
        </p>
      )}
    </section>
  );
}
