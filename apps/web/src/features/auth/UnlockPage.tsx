import { CloudOff, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useSession } from "../../app/session";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { AuthLayout } from "./AuthPage";

/**
 * No server at start: the copy of the business on this device is locked
 * (encrypted) and opens with the person's own Digital Bahi password.
 */
export function UnlockPage() {
  const { t } = useI18n();
  const session = useSession();
  const locked = session.locked!;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"wrong" | "none" | null>(null);

  const open = async () => {
    if (!password) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await session.unlock(password);
      if (r !== "ok") setResult(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void open();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <p className="inline-flex items-center gap-1.5 self-start rounded-full bg-warn-soft px-2.5 py-1 text-[12px] font-medium text-warn">
            <CloudOff size={13} aria-hidden />
            {t("sync.offline")}
          </p>
          <h1 className="text-[22px] leading-tight font-semibold text-ink">{t("unlock.title", { business: locked.businessName })}</h1>
          <p className="text-[14px] text-ink-2">{locked.passwordOpens ? t("unlock.hint", { name: locked.userName }) : t("unlock.noPassword")}</p>
        </div>
        {locked.passwordOpens && (
          <>
            <Field label={t("unlock.password", { name: locked.userName })} htmlFor="unlock-password" error={result === "wrong" ? t("unlock.wrong") : null}>
              <Input
                id="unlock-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                invalid={result === "wrong"}
                onChange={(e) => setPassword(e.target.value)}
                leading={<LockKeyhole size={15} />}
              />
            </Field>
            {result === "none" && (
              <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
                {t("unlock.noPassword")}
              </p>
            )}
            <Button type="submit" variant="primary" disabled={busy || !password}>
              {busy ? t("unlock.opening") : t("unlock.open")}
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={session.retry}>
          {t("unlock.retry")}
        </Button>
        <p className="text-[12.5px] text-ink-3">{t("unlock.why")}</p>
      </form>
    </AuthLayout>
  );
}
