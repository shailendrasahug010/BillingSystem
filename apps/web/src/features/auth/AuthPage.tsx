import { ArrowLeft, Building2, Check, CircleCheck, CloudOff, Eye, EyeOff, Languages, KeyRound, Loader2, LockKeyhole, MessageCircle, Smartphone, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { UpdateBanner } from "../../components/layout/UpdateBanner";
import { useI18n } from "../../app/i18n";
import { useSession } from "../../app/session";
import { DIGITAL_BAHI_LOGO } from "../../components/brand/Brand";
import { LanguageToggle } from "../../components/layout/AppShell";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select, type InputProps } from "../../components/ui/Field";
import { ApiError } from "../../lib/api";
import { translateError } from "@digitalbahi/i18n";
import { validateEmail, validateGstin, validateMobile } from "@digitalbahi/core";
import { stateOptions } from "../../lib/states";
import { ServerLine } from "./ServerSetup";
import { clearSignedOut, lastSignIn, lastSignInName, rememberSignIn, setWelcomeBusiness, wasSignedOut } from "../../lib/lastSignIn";
import { cn } from "../../lib/cn";
import { tintFor } from "../../components/ui/misc";
import { initialsOf, maskMobile, OtpBoxes, PasswordStrength, useCountdown } from "./parts";

type Mode = "password" | "otp" | "signup" | "reset";

/** The server's wait before another code can be sent. */
const RESEND_AFTER_MS = 30_000;

/** The Digital Bahi side of the sign-in screen: the full logo with its tagline, and what the app does. */
export function AuthHero() {
  const { t } = useI18n();
  return (
    <section className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-accent-soft via-surface to-good-soft p-10 text-ink lg:flex">
      <div className="animate-drift pointer-events-none absolute -top-28 -right-28 size-[380px] rounded-full border-[36px] border-accent/10" aria-hidden />
      <div className="animate-drift-slow pointer-events-none absolute -bottom-24 -left-20 size-72 rounded-full bg-brand-green/10" aria-hidden />
      <div className="animate-drift-slow pointer-events-none absolute top-1/2 right-16 size-24 rounded-full bg-accent/5" aria-hidden />
      <div className="relative flex justify-center pt-4">
        <img src={DIGITAL_BAHI_LOGO} alt={`Digital Bahi · ${t("app.brandTagline")}`} width={480} height={431} className="animate-logo w-full max-w-[340px] rounded-3xl bg-white p-4 shadow-card" />
      </div>
      <div className="relative max-w-md">
        <p className="animate-page font-display text-[34px] leading-[1.1] font-semibold text-brand-navy [animation-delay:160ms]">{t("app.tagline")}</p>
        <ul className="stagger mt-5 flex flex-col gap-2 text-[15px] text-ink-2 [--stagger-start:280ms]">
          <li>GST · CGST / SGST / IGST · HSN</li>
          <li>English · हिन्दी</li>
          <li>Web · Windows · Mac · Android · iPhone</li>
        </ul>
      </div>
      <p className="animate-page relative text-[12.5px] text-ink-3 [animation-delay:480ms]">{t("auth.secureNote")}</p>
    </section>
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-full grid-cols-1 bg-bg lg:grid-cols-[1.05fr_1fr]">
      <AuthHero />
      <section className="flex flex-col justify-center px-4 py-10 sm:px-10">
        <div className="animate-page mx-auto flex w-full max-w-sm flex-col gap-6 lg:[animation-delay:120ms]">
          <UpdateBanner className="rounded-lg" />
          <div className="flex items-center justify-between">
            <img src={DIGITAL_BAHI_LOGO} alt="Digital Bahi" width={480} height={431} className="animate-logo w-36 lg:hidden" />
            <LanguageToggle className="ml-auto self-start" />
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}


/** Field-level message for an API error, if it names this field. */
function fieldError(error: ApiError | null, field: string, message: (e: ApiError) => string): string | null {
  return error && (error.field === field || error.field === `business.${field}`) ? message(error) : null;
}

/** The sign-up fields on the first panel (the server names the business's under "business."). */
const SIGNUP_FIELDS = ["name", "mobile", "email", "password", "legalName", "stateCode", "gstin"] as const;
type SignupField = (typeof SIGNUP_FIELDS)[number];
const SIGNUP_IDS: Record<SignupField, string> = { name: "su-name", mobile: "su-mobile", email: "su-email", password: "su-password", legalName: "su-business", stateCode: "su-state", gstin: "su-gstin" };
const signupField = (path: string | undefined): SignupField | undefined => SIGNUP_FIELDS.find((f) => path === f || path === `business.${f}`);

/** A password field with an eye to show what was typed. */
export function PasswordInput(props: InputProps) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return (
    <Input
      {...props}
      type={shown ? "text" : "password"}
      trailing={
        <button
          type="button"
          aria-label={shown ? t("auth.hidePassword") : t("auth.showPassword")}
          aria-pressed={shown}
          title={shown ? t("auth.hidePassword") : t("auth.showPassword")}
          onClick={() => setShown((v) => !v)}
          className="press flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          {shown ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      }
    />
  );
}

/**
 * Sign in (password or OTP), self-service sign-up that creates the business,
 * and password reset by OTP. Errors come back as codes and are shown in the
 * user's language next to the field they concern.
 */
/** Sign-up's steps: who you are, then the business, then the code. */
const SIGNUP_STEP: Record<SignupField, 0 | 1> = { name: 0, mobile: 0, email: 0, password: 0, legalName: 1, stateCode: 1, gstin: 1 };

/** Where sign-up is: You → Business → Verify. */
function StepBar({ step }: { step: 0 | 1 | 2 }) {
  const { t } = useI18n();
  const labels = [t("auth.stepYou"), t("auth.stepBusiness"), t("auth.stepVerify")];
  return (
    <div className="flex flex-col gap-2" data-signup-step={step + 1}>
      <p className="sr-only">{t("auth.stepOf", { step: step + 1, total: 3 })}</p>
      <ol className="grid grid-cols-3 gap-2" aria-hidden>
        {labels.map((label, i) => (
          <li key={label} className="flex flex-col gap-1.5">
            <span className={cn("h-1.5 rounded-full transition-colors duration-300", i <= step ? "bg-accent" : "bg-surface-3")} />
            <span className={cn("inline-flex items-center gap-1 text-[12px] font-medium", i === step ? "text-accent-ink" : i < step ? "text-ink-2" : "text-ink-3")}>
              {i < step && <Check size={12} />}
              {label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
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
  // Just signed out: a friendly goodbye in place of a blank form.
  const [notice, setNotice] = useState<string | null>(() => (wasSignedOut() ? t("auth.signedOut") : null));
  useEffect(() => clearSignedOut(), []);
  const [otpSent, setOtpSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  // A new code can be asked for from this time on (the server's wait between codes).
  const [resendAt, setResendAt] = useState(0);
  const resendIn = useCountdown(resendAt);
  // The number the last code went to (back from Change number with the same number, the wait still holds).
  const [sentTo, setSentTo] = useState("");
  // Sign-up: 0 you, 1 the business (the code comes after).
  const [step, setStep] = useState<0 | 1>(0);
  // The form was sent once: its fields show what is missing from then on.
  const [tried, setTried] = useState(false);
  const [remembered, setRemembered] = useState(lastSignIn);
  const [rememberedName, setRememberedName] = useState(() => (lastSignIn() ? lastSignInName() : ""));
  const [form, setForm] = useState({
    identifier: remembered,
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

  // Sign-in's own checks: nothing sent with an empty box.
  const loginIssues = {
    identifier: tried && mode === "password" && !form.identifier.trim() ? t("auth.enterIdentifier") : null,
    password: tried && mode === "password" && !form.password ? t("auth.enterPassword") : null,
  };

  // Sign-up's own checks (the server's rules: name and business name 2+ characters, password 8+).
  const required = (v: string, min: number) => (!v.trim() ? t("validation.required") : v.trim().length < min ? t("validation.tooShort", { min }) : undefined);
  const mobileIssue = validateMobile(form.mobile)[0];
  const gstinIssue = form.gstin.trim() ? validateGstin(form.gstin, { expectedStateCode: form.stateCode })[0] : undefined;
  const signupIssues: Partial<Record<SignupField, string>> = {
    name: required(form.name, 2),
    mobile: mobileIssue ? (mobileIssue === "required" ? t("validation.required") : t("validation.mobile")) : undefined,
    email: form.email.trim() && validateEmail(form.email).length ? t("validation.email") : undefined,
    password: !form.password ? t("validation.required") : form.password.length < 8 ? t("validation.passwordShort") : undefined,
    legalName: required(form.legalName, 2),
    gstin: gstinIssue ? t(`validation.${gstinIssue}`) : undefined,
  };
  /** What to show at a sign-up field: its own check once tried, else what the server said about it. */
  const signupError = (field: SignupField): string | null => {
    if (tried && SIGNUP_STEP[field] === step && signupIssues[field]) return signupIssues[field]!;
    const server = fieldError(error, field, message);
    if (server) return server;
    const detail = error?.details?.find((d) => signupField(d.field) === field);
    return detail ? (field === "password" ? t("validation.passwordShort") : t("validation.invalid_format")) : null;
  };

  // A refused attempt shakes the form.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const el = formRef.current;
    if (!error || !el) return;
    el.classList.remove("animate-shake");
    void el.offsetWidth;
    el.classList.add("animate-shake");
  }, [error]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "generic");
      // Asked for a code too soon: the Resend button counts down the wait.
      const wait = Number(err.params?.retryAfter);
      if (err.code === "OTP_TOO_SOON" && wait > 0) {
        setResendAt(Date.now() + wait * 1000);
        setSentTo(form.mobile.trim());
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode, prefill?: Partial<typeof form>) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setOtpSent(false);
    setDevCode(null);
    setTried(false);
    setStep(0);
    setForm((f) => ({ ...f, otp: "", ...prefill }));
  };
  /** The wrong person's number was remembered: a clean form for whoever is here. */
  const notMe = () => {
    rememberSignIn(null);
    setRemembered("");
    setRememberedName("");
    setForm((f) => ({ ...f, identifier: "", password: "" }));
    setNotice(null);
    window.setTimeout(() => document.getElementById("auth-id")?.focus(), 0);
  };
  /** Back from the code to the number (a typo in it). */
  const changeNumber = () => {
    setOtpSent(false);
    setDevCode(null);
    setError(null);
    setStep(0);
    setForm((f) => ({ ...f, otp: "" }));
    window.setTimeout(() => document.getElementById(mode === "signup" ? "su-mobile" : "auth-mobile")?.focus(), 0);
  };

  const sendOtp = (purpose: "signup" | "login" | "reset") =>
    run(async () => {
      const res = await session.requestOtp(form.mobile, purpose);
      setOtpSent(true);
      setDevCode(res.devCode ?? null);
      setForm((f) => ({ ...f, otp: "" }));
      setResendAt(Date.now() + RESEND_AFTER_MS);
      setSentTo(form.mobile.trim());
    });

  /** The sixth digit is in: sign in or create the account at once (reset still needs the new password). */
  const codeComplete = () => {
    if (busy || mode === "reset") {
      if (mode === "reset") window.setTimeout(() => document.getElementById("reset-password")?.focus(), 0);
      return;
    }
    window.setTimeout(() => formRef.current?.requestSubmit(), 0);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || mustWait) return;
    const code = form.otp.replace(/\s/g, "");
    if (mode === "password") {
      setTried(true);
      if (!form.identifier.trim()) return void document.getElementById("auth-id")?.focus();
      if (!form.password) return void document.getElementById("auth-password")?.focus();
      return void run(async () => {
        await session.login(form.identifier.trim(), form.password);
        rememberSignIn(form.identifier.trim());
      });
    }
    if (mode === "otp")
      return void (otpSent
        ? run(async () => {
            await session.loginWithOtp(form.mobile, code);
            rememberSignIn(form.mobile.trim());
          })
        : sendOtp("login"));
    if (mode === "reset") {
      if (!otpSent) return void sendOtp("reset");
      return void run(async () => {
        await session.resetPassword(form.mobile, code, form.password);
        switchMode("password", { identifier: form.mobile.trim(), password: "" });
        setNotice(t("auth.resetDone"));
      });
    }
    if (!otpSent) {
      // Each step's fields are checked on that step, before the next one (or the code).
      setTried(true);
      const first = SIGNUP_FIELDS.find((f) => SIGNUP_STEP[f] === step && signupIssues[f]);
      if (first) return void document.getElementById(SIGNUP_IDS[first])?.focus();
      if (step === 0) {
        setStep(1);
        setTried(false);
        setError(null);
        return void window.setTimeout(() => document.getElementById("su-business")?.focus(), 0);
      }
      return void sendOtp("signup");
    }
    return void run(async () => {
      try {
        await session.signup({
          name: form.name.trim(),
          mobile: form.mobile,
          ...(form.email.trim() ? { email: form.email.trim() } : {}),
          password: form.password,
          otp: code,
          preferredLocale: locale === "hi" ? "hi" : "en",
          business: { legalName: form.legalName.trim(), stateCode: form.stateCode, ...(form.gstin.trim() ? { gstin: form.gstin.trim().toUpperCase() } : {}) },
        });
        rememberSignIn(form.mobile.trim());
        // The first dashboard says the business is ready.
        setWelcomeBusiness(form.legalName.trim());
      } catch (e) {
        // Refused for a field of an earlier step (a GSTIN already registered…): back there, the message at the field.
        const field = e instanceof ApiError ? (signupField(e.field) ?? e.details?.map((d) => signupField(d.field)).find(Boolean)) : undefined;
        if (field) {
          setOtpSent(false);
          setDevCode(null);
          setStep(SIGNUP_STEP[field]);
          setForm((f) => ({ ...f, otp: "" }));
        }
        throw e;
      }
    });
  };

  const mustWait = !otpSent && (mode !== "signup" || step === 1) && mode !== "password" && form.mobile.trim() === sentTo && resendIn > 0;
  const general = error && !error.field && !error.details?.some((d) => signupField(d.field)) ? message(error) : null;
  const wrongPassword = mode === "password" && error?.code === "INVALID_CREDENTIALS";
  const asMobile = /^[+\d][\d\s-]{6,}$/.test(form.identifier.trim()) ? form.identifier.trim() : form.mobile;
  const otpField = otpSent && (
    <div className="flex flex-col gap-2">
      <Field label={t("auth.otp")} htmlFor="auth-otp" hint={devCode ? t("auth.devOtp", { code: devCode }) : undefined} error={fieldError(error, "otp", message)}>
        <OtpBoxes id="auth-otp" value={form.otp} onChange={(otp) => setForm((f) => ({ ...f, otp }))} onComplete={codeComplete} invalid={Boolean(fieldError(error, "otp", message))} autoFocus />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
        <p className="flex flex-wrap items-center gap-x-1.5 text-ink-3">
          <span>{t("auth.codeSentTo", { mobile: maskMobile(form.mobile) })}</span>
          <button type="button" className="font-medium text-accent hover:underline" onClick={changeNumber}>
            {t("auth.changeNumber")}
          </button>
        </p>
        <button
          type="button"
          className="font-medium text-accent tabular-nums hover:underline disabled:text-ink-3 disabled:no-underline"
          disabled={busy || resendIn > 0}
          onClick={() => void sendOtp(mode === "signup" ? "signup" : mode === "reset" ? "reset" : "login")}
        >
          {resendIn > 0 ? t("auth.resendIn", { seconds: resendIn }) : t("auth.resendOtp")}
        </button>
      </div>
    </div>
  );

  const greetName = mode === "password" && remembered && rememberedName ? rememberedName.split(/\s+/)[0] : "";
  const title =
    mode === "signup" ? t("auth.signUpTitle") : mode === "reset" ? (otpSent ? t("auth.setNewPassword") : t("auth.resetPassword")) : greetName ? t("auth.welcomeName", { name: greetName }) : t("auth.welcome");
  const subtitle =
    mode === "signup"
      ? otpSent
        ? t("auth.signUpVerifySubtitle")
        : step === 1
          ? t("auth.signUpBusinessSubtitle")
          : t("auth.signUpSubtitle")
      : mode === "reset"
        ? otpSent
          ? t("auth.resetCodeSubtitle")
          : t("auth.resetSubtitle")
        : mode === "otp"
          ? t("auth.otpSubtitle")
          : t("auth.subtitle");

  return (
    <AuthLayout>
      <div className="flex items-start gap-3">
        {greetName && (
          <span className={cn("mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full font-display text-[15px] font-semibold", tintFor(rememberedName))} aria-hidden>
            {initialsOf(rememberedName)}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-semibold text-ink">{title}</h1>
          <p className="mt-1 text-[14px] text-ink-3">
            {subtitle}
            {greetName && (
              <>
                {" · "}
                <button type="button" className="font-medium text-accent hover:underline" onClick={notMe}>
                  {t("auth.notYou")}
                </button>
              </>
            )}
          </p>
        </div>
      </div>
      {mode === "signup" && <StepBar step={otpSent ? 2 : step} />}
      {notice && (
        <p className="animate-page flex items-center gap-2 rounded-lg bg-good-soft px-3 py-2 text-[13px] text-good" role="status">
          <CircleCheck size={16} className="shrink-0" aria-hidden />
          {notice}
        </p>
      )}
      {session.wiped && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn" role="status">
          {t("offline.wiped", { business: session.wiped.business ?? t("offline.theBusiness") })}
          {session.wiped.waiting > 0 && ` ${t("offline.wipedWaiting", { count: session.wiped.waiting })}`}
        </p>
      )}
      <form ref={formRef} className="flex flex-col gap-4" onSubmit={onSubmit} onAnimationEnd={(e) => e.currentTarget.classList.remove("animate-shake")} noValidate>
        {mode === "password" && (
          <>
            <Field label={t("auth.mobileOrEmail")} htmlFor="auth-id" error={loginIssues.identifier}>
              <Input id="auth-id" inputSize="lg" invalid={Boolean(loginIssues.identifier)} autoComplete="username" leading={<Smartphone size={18} />} value={form.identifier} onChange={set("identifier")} autoFocus={!remembered} />
            </Field>
            <Field label={t("auth.password")} htmlFor="auth-password" error={loginIssues.password}>
              <PasswordInput id="auth-password" inputSize="lg" invalid={Boolean(loginIssues.password) || wrongPassword} autoComplete="current-password" leading={<LockKeyhole size={18} />} value={form.password} onChange={set("password")} autoFocus={Boolean(remembered)} />
            </Field>
          </>
        )}

        {(mode === "otp" || mode === "reset") && !otpSent && (
          <Field label={t("auth.mobile")} htmlFor="auth-mobile" error={fieldError(error, "mobile", message)}>
            <Input id="auth-mobile" inputSize="lg" inputMode="tel" autoComplete="tel" leading={<Smartphone size={18} />} value={form.mobile} onChange={set("mobile")} autoFocus />
          </Field>
        )}

        {mode === "signup" && !otpSent && step === 0 && (
          <div key="you" className="animate-page flex flex-col gap-4">
            <Field label={t("auth.yourName")} htmlFor="su-name" error={signupError("name")}>
              <Input id="su-name" invalid={Boolean(signupError("name"))} autoComplete="name" leading={<UserRound size={17} />} value={form.name} onChange={set("name")} autoFocus />
            </Field>
            <Field label={t("auth.mobile")} htmlFor="su-mobile" error={signupError("mobile")}>
              <Input id="su-mobile" invalid={Boolean(signupError("mobile"))} inputMode="tel" autoComplete="tel" leading={<Smartphone size={17} />} value={form.mobile} onChange={set("mobile")} />
            </Field>
            <Field label={`${t("auth.email")} (${t("common.optional")})`} htmlFor="su-email" error={signupError("email")}>
              <Input id="su-email" invalid={Boolean(signupError("email"))} type="email" autoComplete="email" value={form.email} onChange={set("email")} />
            </Field>
            <Field label={t("auth.newPassword")} htmlFor="su-password" error={signupError("password")}>
              <PasswordInput id="su-password" invalid={Boolean(signupError("password"))} autoComplete="new-password" leading={<LockKeyhole size={17} />} value={form.password} onChange={set("password")} />
            </Field>
            {!signupError("password") && <div className="-mt-2"><PasswordStrength password={form.password} /></div>}
          </div>
        )}

        {mode === "signup" && !otpSent && step === 1 && (
          <div key="business" className="animate-page flex flex-col gap-4">
            <Field label={t("auth.businessName")} htmlFor="su-business" error={signupError("legalName")}>
              <Input id="su-business" invalid={Boolean(signupError("legalName"))} leading={<Building2 size={17} />} value={form.legalName} onChange={set("legalName")} autoFocus />
            </Field>
            <Field label={t("auth.state")} htmlFor="su-state" error={signupError("stateCode")}>
              <Select id="su-state" value={form.stateCode} onChange={set("stateCode")}>
                {stateOptions(locale, { special: false }).map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("auth.gstinOptional")} htmlFor="su-gstin" error={signupError("gstin")}>
              <Input id="su-gstin" invalid={Boolean(signupError("gstin"))} className="font-mono uppercase" maxLength={15} value={form.gstin} onChange={set("gstin")} />
            </Field>
          </div>
        )}

        {otpField}
        {mode === "reset" && otpSent && (
          <div className="flex flex-col gap-2">
            <Field label={t("auth.newPassword")} htmlFor="reset-password">
              <PasswordInput id="reset-password" autoComplete="new-password" leading={<LockKeyhole size={17} />} value={form.password} onChange={set("password")} />
            </Field>
            <PasswordStrength password={form.password} />
          </div>
        )}

        {general && (
          <div className="flex flex-col gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            <p>{general}</p>
            {wrongPassword && (
              <>
                <p className="text-ink-2">{t("auth.wrongPasswordHelp")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="secondary" icon={<KeyRound size={15} />} onClick={() => switchMode("reset", { mobile: asMobile, password: "" })}>
                    {t("auth.resetPassword")}
                  </Button>
                  <Button type="button" size="sm" variant="secondary" icon={<MessageCircle size={15} />} onClick={() => switchMode("otp", { mobile: asMobile })}>
                    {t("auth.signInWithOtp")}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        {error?.details?.some((d) => !signupField(d.field)) && !general ? (
          <p className="text-[12px] text-danger" role="alert">
            {t("errors.VALIDATION_FAILED")}
          </p>
        ) : null}

        <div className="flex gap-2">
          {mode === "signup" && step === 1 && !otpSent && (
            <Button type="button" variant="secondary" size="lg" icon={<ArrowLeft size={18} />} onClick={() => setStep(0)} disabled={busy}>
              {t("common.back")}
            </Button>
          )}
          <Button type="submit" variant="primary" size="lg" block disabled={busy || mustWait} aria-busy={busy} icon={busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : undefined}>
            {mode === "password"
              ? t("auth.signIn")
              : mustWait
                ? t("auth.resendIn", { seconds: resendIn })
                : !otpSent
                ? mode === "signup" && step === 0
                  ? t("common.next")
                  : t("auth.sendOtp")
                : mode === "signup"
                  ? t("auth.verifyAndCreate")
                  : mode === "reset"
                    ? t("auth.setNewPassword")
                    : t("auth.verifyAndSignIn")}
          </Button>
        </div>
      </form>

      <div className="flex flex-col items-center gap-2 text-[13.5px]">
        {mode === "password" && (
          <>
            <button type="button" className="text-accent hover:underline" onClick={() => switchMode("otp", { mobile: asMobile })}>
              {t("auth.signInWithOtp")}
            </button>
            <button type="button" className="text-ink-3 hover:underline" onClick={() => switchMode("reset", { mobile: asMobile })}>
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
        <ServerLine />
      </div>
      {/* On a phone the hero is hidden: what the app does, in three lines under the form. */}
      <ul className="stagger flex flex-wrap justify-center gap-2 text-[12.5px] text-ink-2 [--stagger-start:240ms] lg:hidden">
        {[
          { icon: <CloudOff size={14} />, label: t("auth.perks.offline") },
          { icon: <MessageCircle size={14} />, label: t("auth.perks.whatsapp") },
          { icon: <Languages size={14} />, label: t("auth.perks.language") },
        ].map((p) => (
          <li key={p.label} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5">
            <span className="text-accent">{p.icon}</span>
            {p.label}
          </li>
        ))}
      </ul>
    </AuthLayout>
  );
}
