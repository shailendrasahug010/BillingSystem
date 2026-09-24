import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Lock, LockOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import type { PeriodStatus } from "./Gstr1Tab";

type Step = "lock" | "unlock" | "file" | null;

/**
 * The month's GSTR-1 status with its actions: lock the month once the
 * return is prepared (its documents can then only be corrected with notes),
 * unlock while it is not filed, and record the filing with the ARN.
 */
export function PeriodActions({ period }: { period: string }) {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(null);
  const [arn, setArn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({
    queryKey: ["gst", "period", period],
    queryFn: () => api.get<{ period: string; GSTR1: PeriodStatus; GSTR3B: PeriodStatus }>(`/gst/periods/${period}`),
    enabled: /^\d{4}-\d{2}$/.test(period),
  });
  useEffect(() => {
    setArn("");
    setError(null);
  }, [step]);
  const s = q.data?.GSTR1;
  if (!s) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = step === "file" ? "filed" : step!;
      await api.post(`/gst/periods/${period}/${path}`, step === "file" ? { returnType: "GSTR1", arn: arn.trim() } : { returnType: "GSTR1" });
      void qc.invalidateQueries({ queryKey: ["gst"] });
      void qc.invalidateQueries({ queryKey: ["reports", "gst"] });
      toast({ tone: "success", title: t(`gstPage.period.${step!}Done`, { period }) });
      setStep(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 md:ml-auto">
      <Badge tone={s.status === "filed" ? "good" : s.status === "locked" ? "warn" : "neutral"}>
        GSTR-1: {t(`gstPage.status.${s.status}`)}
        {s.arn ? ` · ARN ${s.arn}` : ""}
      </Badge>
      {s.status === "open" && allowed("gst.lock_period") && (
        <Button size="sm" icon={<Lock size={14} />} onClick={() => setStep("lock")}>
          {t("gstPage.period.lock")}
        </Button>
      )}
      {s.status === "locked" && allowed("gst.lock_period") && (
        <Button size="sm" variant="ghost" icon={<LockOpen size={14} />} onClick={() => setStep("unlock")}>
          {t("gstPage.period.unlock")}
        </Button>
      )}
      {s.status !== "filed" && allowed("gst.file") && (
        <Button size="sm" icon={<CheckCircle2 size={14} />} onClick={() => setStep("file")}>
          {t("gstPage.period.markFiled")}
        </Button>
      )}
      <Dialog
        open={step !== null}
        onOpenChange={(v) => !v && setStep(null)}
        size="sm"
        title={step ? t(`gstPage.period.${step}Title`, { period }) : ""}
        description={step ? t(`gstPage.period.${step}Hint`) : undefined}
        closeLabel={t("common.close")}
        footer={
          <>
            <Button onClick={() => setStep(null)}>{t("common.cancel")}</Button>
            <Button variant={step === "unlock" ? "danger" : "primary"} disabled={busy || (step === "file" && arn.trim().length < 5)} onClick={() => void run()}>
              {step ? t(`gstPage.period.${step}`) : ""}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <ErrorNote error={error} /> : null}
          {s.lockedAt && step !== "lock" && <p className="text-[13px] text-ink-3">{t("gstPage.period.lockedAt", { when: dateTime(s.lockedAt) })}</p>}
          {step === "file" && (
            <Field label="ARN" htmlFor="gst-arn" hint={t("gstPage.period.arnHint")}>
              <Input id="gst-arn" autoFocus maxLength={30} value={arn} onChange={(e) => setArn(e.target.value.trim().toUpperCase())} />
            </Field>
          )}
        </div>
      </Dialog>
    </div>
  );
}
