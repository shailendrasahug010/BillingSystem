import { GST_STATES } from "@vyapaar/core";
import { Building2, KeyRound, LockKeyhole, Smartphone, UserRound } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { UpdateBanner } from "../../components/layout/UpdateBanner";
import { useI18n } from "../../app/i18n";
import { useSession } from "../../app/session";
import { BrandMark, LanguageToggle } from "../../components/layout/AppShell";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { ApiError } from "../../lib/api";
import { translateError } from "@vyapaar/i18n";

type Mode = "password" | "otp" | "signup" | "reset";

export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-full grid-cols-1 bg-bg lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-accent p-10 text-ink-inverse lg:flex">
        <BrandMark inverse />
        <div className="max-w-md">
          <p className="font-display text-[40px] leading-[1.05] font-semibold">{t("app.tagline")}</p>
          <ul className="mt-6 flex flex-col gap-2 text-[15px] opacity-90">
            <li>GST · CGST / SGST / IGST · HSN</li>
            <li>English · हिन्दी</li>
            <li>Web · Windows · Mac · Android · iPhone</li>
          </ul>
        </div>
        <p className="text-[12.5px] opacity-75">{t("auth.secureNote")}</p>
        <div className="pointer-events-none absolute -right-24 -bottom-24 size-[420px] rounded-full border-[40px] border-white/10" aria-hidden />
        <div className="pointer-events-none absolute right-20 bottom-44 size-28 rounded-full bg-marigold/90" aria-hidden />
      </section>
      <section className="flex flex-col justify-center px-4 py-10 sm:px-10">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
          <UpdateBanner className="rounded-lg" />
          <div className="flex items-center justify-between">
            <span className="lg:hidden">
              <BrandMark />
            </span>
            <LanguageToggle className="ml-auto" />
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}

const STATES = GST_STATES.filter((s) => !s.legacy && s.code !== "97" && s.code !== "96");

/** Field-level message for an API error, if it names this field. */
function fieldError(error: ApiError | null, field: string, message: (e: ApiError) => string): string | null {
  return error && (error.field === field || error.field === `business.${field}`) ? message(error) : null;
}

/**
 * Sign in (password or OTP), self-service sign-up that creates the business,
 * and password reset by OTP. Errors come back as codes and are shown in the
 * user's language next to the field they concern.
 */
export function AuthPage() {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const session = useSession();
  const [mode, setMode] = useState<Mode>("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [form, setForm] = useState({
    identifier: "",
    password: "",
    name: "",
    mobile: "",
    email: "",
    otp: "",
    legalName: "",
    stateCode: "23",
    gstin: "",
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const message = (e: ApiError) => translateError(i18n, e);

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

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setOtpSent(false);
    setDevCode(null);
    setForm((f) => ({ ...f, otp: "" }));
  };

  const sendOtp = (purpose: "signup" | "login" | "reset") =>
    run(async () => {
      const res = await session.requestOtp(form.mobile, purpose);
      setOtpSent(true);
      setDevCode(res.devCode ?? null);
    });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "password") return void run(() => session.login(form.identifier.trim(), form.password));
    if (mode === "otp") return void (otpSent ? run(() => session.loginWithOtp(form.mobile, form.otp)) : sendOtp("login"));
    if (mode === "reset") {
      if (!otpSent) return void sendOtp("reset");
      return void run(async () => {
        await session.resetPassword(form.mobile, form.otp, form.password);
        switchMode("password");
        setNotice(t("auth.resetDone"));
      });
    }
    if (!otpSent) return void sendOtp("signup");
    return void run(() =>
      session.signup({
        name: form.name.trim(),
        mobile: form.mobile,
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        password: form.password,
        otp: form.otp,
        preferredLocale: locale === "hi" ? "hi" : "en",
        business: { legalName: form.legalName.trim(), stateCode: form.stateCode, ...(form.gstin.trim() ? { gstin: form.gstin.trim().toUpperCase() } : {}) },
      }),
    );
  };

  const general = error && !error.field ? message(error) : null;
  const otpField = otpSent && (
    <Field label={t("auth.otp")} htmlFor="auth-otp" hint={devCode ? t("auth.devOtp", { code: devCode }) : t("auth.otpSentTo", { mobile: form.mobile })} error={fieldError(error, "otp", message)}>
      <Input id="auth-otp" inputSize="lg" inputMode="numeric" autoComplete="one-time-code" maxLength={6} leading={<KeyRound size={18} />} value={form.otp} onChange={set("otp")} autoFocus />
    </Field>
  );

  return (
    <AuthLayout>
      <div>
        <h1 className="text-[28px] font-semibold text-ink">{mode === "signup" ? t("auth.signUpTitle") : mode === "reset" ? t("auth.resetPassword") : t("auth.welcome")}</h1>
        <p className="mt-1 text-[14px] text-ink-3">{mode === "signup" ? t("auth.signUpSubtitle") : t("auth.subtitle")}</p>
      </div>
      {notice && <p className="rounded-lg bg-good-soft px-3 py-2 text-[13px] text-good" role="status">{notice}</p>}
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {mode === "password" && (
          <>
            <Field label={t("auth.mobileOrEmail")} htmlFor="auth-id">
              <Input id="auth-id" inputSize="lg" autoComplete="username" leading={<Smartphone size={18} />} value={form.identifier} onChange={set("identifier")} autoFocus />
            </Field>
            <Field label={t("auth.password")} htmlFor="auth-password">
              <Input id="auth-password" inputSize="lg" type="password" autoComplete="current-password" leading={<LockKeyhole size={18} />} value={form.password} onChange={set("password")} />
            </Field>
          </>
        )}

        {(mode === "otp" || mode === "reset") && (
          <Field label={t("auth.mobile")} htmlFor="auth-mobile" error={fieldError(error, "mobile", message)}>
            <Input id="auth-mobile" inputSize="lg" inputMode="tel" autoComplete="tel" leading={<Smartphone size={18} />} value={form.mobile} onChange={set("mobile")} disabled={otpSent} autoFocus />
          </Field>
        )}

        {mode === "signup" && !otpSent && (
          <>
            <Field label={t("auth.yourName")} htmlFor="su-name">
              <Input id="su-name" autoComplete="name" leading={<UserRound size={17} />} value={form.name} onChange={set("name")} autoFocus />
            </Field>
            <Field label={t("auth.mobile")} htmlFor="su-mobile" error={fieldError(error, "mobile", message)}>
              <Input id="su-mobile" inputMode="tel" autoComplete="tel" leading={<Smartphone size={17} />} value={form.mobile} onChange={set("mobile")} />
            </Field>
            <Field label={`${t("auth.email")} (${t("common.optional")})`} htmlFor="su-email" error={fieldError(error, "email", message)}>
              <Input id="su-email" type="email" autoComplete="email" value={form.email} onChange={set("email")} />
            </Field>
            <Field label={t("auth.newPassword")} htmlFor="su-password" hint={t("auth.passwordHint")}>
              <Input id="su-password" type="password" autoComplete="new-password" leading={<LockKeyhole size={17} />} value={form.password} onChange={set("password")} />
            </Field>
            <p className="eyebrow pt-1">{t("auth.businessDetails")}</p>
            <Field label={t("auth.businessName")} htmlFor="su-business">
              <Input id="su-business" leading={<Building2 size={17} />} value={form.legalName} onChange={set("legalName")} />
            </Field>
            <Field label={t("auth.state")} htmlFor="su-state" error={fieldError(error, "stateCode", message)}>
              <Select id="su-state" value={form.stateCode} onChange={set("stateCode")}>
                {STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {locale === "hi" ? s.nameHi : s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("auth.gstinOptional")} htmlFor="su-gstin" error={fieldError(error, "gstin", message)}>
              <Input id="su-gstin" className="font-mono uppercase" maxLength={15} value={form.gstin} onChange={set("gstin")} />
            </Field>
          </>
        )}

        {mode === "reset" && otpSent && (
          <Field label={t("auth.newPassword")} htmlFor="reset-password" hint={t("auth.passwordHint")}>
            <Input id="reset-password" type="password" autoComplete="new-password" leading={<LockKeyhole size={17} />} value={form.password} onChange={set("password")} />
          </Field>
        )}
        {otpField}

        {general && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {general}
          </p>
        )}
        {error?.details?.length ? (
          <p className="text-[12px] text-danger" role="alert">
            {error.details.map((d) => d.field).join(", ")}
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" block disabled={busy}>
          {mode === "password"
            ? t("auth.signIn")
            : !otpSent
              ? t("auth.sendOtp")
              : mode === "signup"
                ? t("auth.verifyAndCreate")
                : mode === "reset"
                  ? t("auth.resetPassword")
                  : t("auth.verifyAndSignIn")}
        </Button>
        {otpSent && (
          <Button type="button" variant="ghost" block disabled={busy} onClick={() => void sendOtp(mode === "signup" ? "signup" : mode === "reset" ? "reset" : "login")}>
            {t("auth.resendOtp")}
          </Button>
        )}
      </form>

      <div className="flex flex-col items-center gap-2 text-[13.5px]">
        {mode === "password" && (
          <>
            <button type="button" className="text-accent hover:underline" onClick={() => switchMode("otp")}>
              {t("auth.signInWithOtp")}
            </button>
            <button type="button" className="text-ink-3 hover:underline" onClick={() => switchMode("reset")}>
              {t("auth.forgotPassword")}
            </button>
          </>
        )}
        {(mode === "otp" || mode === "reset") && (
          <button type="button" className="text-accent hover:underline" onClick={() => switchMode("password")}>
            {mode === "otp" ? t("auth.signInWithPassword") : t("auth.backToSignIn")}
          </button>
        )}
        <p className="text-ink-3">
          {mode === "signup" ? t("auth.haveAccount") : t("auth.noAccount")}{" "}
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => switchMode(mode === "signup" ? "password" : "signup")}>
            {mode === "signup" ? t("auth.signIn") : t("auth.signUp")}
          </button>
        </p>
      </div>
    </AuthLayout>
  );
}
