import { LockKeyhole, Smartphone } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { BrandMark, LanguageToggle } from "../../components/layout/AppShell";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { BUSINESS } from "../../data/db";

/**
 * Login. Mobile number is the primary identifier (most shop staff have no
 * work email). Language can be switched before signing in.
 */
export function LoginPage() {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const [id, setId] = useState("98260 41234");
  const [password, setPassword] = useState("prototype");
  const [remember, setRemember] = useState(true);

  return (
    <div className="grid min-h-full grid-cols-1 bg-bg lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-accent p-10 text-ink-inverse lg:flex">
        <BrandMark />
        <div className="max-w-md">
          <p className="font-display text-[40px] leading-[1.05] font-semibold">{t("app.tagline")}</p>
          <ul className="mt-6 flex flex-col gap-2 text-[15px] opacity-90">
            <li>GST · CGST / SGST / IGST · HSN</li>
            <li>English · हिन्दी</li>
            <li>Web · Windows · Android · Offline</li>
          </ul>
        </div>
        <p className="text-[12.5px] opacity-75">{t("auth.secureNote")}</p>
        <div className="pointer-events-none absolute -right-24 -bottom-24 size-[420px] rounded-full border-[40px] border-white/10" aria-hidden />
        <div className="pointer-events-none absolute right-20 bottom-44 size-28 rounded-full bg-marigold/90" aria-hidden />
      </section>

      <section className="flex flex-col justify-center px-4 py-10 sm:px-10">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
          <div className="flex items-center justify-between">
            <span className="lg:hidden">
              <BrandMark />
            </span>
            <LanguageToggle className="ml-auto" />
          </div>
          <div>
            <h1 className="text-[28px] font-semibold text-ink">{t("auth.welcome")}</h1>
            <p className="mt-1 text-[14px] text-ink-3">{t("auth.subtitle")}</p>
          </div>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ name: "dashboard" });
            }}
          >
            <Field label={t("auth.mobileOrEmail")} htmlFor="login-id">
              <Input id="login-id" inputSize="lg" autoComplete="username" leading={<Smartphone size={18} />} value={id} onChange={(e) => setId(e.target.value)} />
            </Field>
            <Field label={t("auth.password")} htmlFor="login-password">
              <Input id="login-password" inputSize="lg" type="password" autoComplete="current-password" leading={<LockKeyhole size={18} />} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-[13.5px] text-ink-2" htmlFor="login-remember">
              <input id="login-remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-[var(--accent)]" />
              {t("auth.rememberDevice")}
            </label>
            <Button type="submit" variant="primary" size="lg" block>
              {t("auth.signIn")}
            </Button>
            <Button type="button" variant="ghost" block>
              {t("auth.signInWithOtp")}
            </Button>
          </form>
          <div className="rounded-xl border border-line bg-surface p-3.5">
            <p className="eyebrow">{t("auth.chooseBusiness")}</p>
            <p className="mt-1 text-[14px] font-medium text-ink">{BUSINESS.name}</p>
            <p className="font-mono text-[12px] text-ink-3">{BUSINESS.gstin}</p>
          </div>
          <p className="text-center text-[12px] text-ink-3">{t("auth.demoHint")}</p>
        </div>
      </section>
    </div>
  );
}
