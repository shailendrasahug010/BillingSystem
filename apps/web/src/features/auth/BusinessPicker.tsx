import { GST_STATES } from "@vyapaar/core";
import { translateError } from "@vyapaar/i18n";
import { Building2, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { ApiError } from "../../lib/api";
import { AuthLayout } from "./AuthPage";

const STATES = GST_STATES.filter((s) => !s.legacy && s.code !== "97" && s.code !== "96");

/** Shown when the signed-in user has no active business selected (or all are suspended). */
export function BusinessPicker() {
  const i18n = useI18n();
  const { t, locale, date } = i18n;
  const session = useSession();
  const [creating, setCreating] = useState(session.businesses.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [form, setForm] = useState({ legalName: "", stateCode: "23", gstin: "" });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <div>
        <h1 className="text-[26px] font-semibold text-ink">{t("auth.chooseBusinessTitle")}</h1>
        {session.businesses.length === 0 && <p className="mt-1 text-[14px] text-ink-3">{t("auth.noBusinessBody")}</p>}
      </div>
      {session.businesses.length > 0 && (
        <ul className="flex flex-col gap-2">
          {session.businesses.map((b) => {
            const usable = b.status === "trial" || b.status === "active";
            return (
              <li key={b.id}>
                <button
                  type="button"
                  disabled={!usable || busy}
                  onClick={() => void run(() => session.switchBusiness(b.id))}
                  className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3.5 text-left hover:border-accent disabled:opacity-60"
                >
                  <Building2 size={20} className="text-ink-3" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-ink">{b.tradeName ?? b.legalName}</span>
                    <span className="block font-mono text-[12px] text-ink-3">{b.gstin ?? b.role}</span>
                  </span>
                  {!usable ? (
                    <Badge tone="danger">{t("auth.suspended")}</Badge>
                  ) : b.status === "trial" && b.trialEndsAt ? (
                    <Badge tone="warn">{t("auth.trialUntil", { date: date(b.trialEndsAt.slice(0, 10)) })}</Badge>
                  ) : null}
                  <ChevronRight size={18} className="text-ink-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {creating ? (
        <form
          className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => session.createBusiness({ legalName: form.legalName.trim(), stateCode: form.stateCode, ...(form.gstin.trim() ? { gstin: form.gstin.trim().toUpperCase() } : {}) }));
          }}
        >
          <Field label={t("auth.businessName")} htmlFor="nb-name">
            <Input id="nb-name" value={form.legalName} onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))} autoFocus />
          </Field>
          <Field label={t("auth.state")} htmlFor="nb-state">
            <Select id="nb-state" value={form.stateCode} onChange={(e) => setForm((f) => ({ ...f, stateCode: e.target.value }))}>
              {STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {locale === "hi" ? s.nameHi : s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("auth.gstinOptional")} htmlFor="nb-gstin" error={error?.field === "gstin" ? translateError(i18n, error) : null}>
            <Input id="nb-gstin" className="font-mono uppercase" maxLength={15} value={form.gstin} onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value }))} />
          </Field>
          <Button type="submit" variant="primary" block disabled={busy || form.legalName.trim().length < 2}>
            {t("auth.createBusiness")}
          </Button>
        </form>
      ) : (
        <Button variant="secondary" block onClick={() => setCreating(true)}>
          {t("auth.createBusiness")}
        </Button>
      )}
      {error && error.field !== "gstin" && (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
          {translateError(i18n, error)}
        </p>
      )}
      <Button variant="ghost" block onClick={() => void session.logout()}>
        {t("auth.signOut")}
      </Button>
    </AuthLayout>
  );
}
