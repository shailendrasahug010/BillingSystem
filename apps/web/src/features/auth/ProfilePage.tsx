import { KeyRound, LockKeyhole, Mail, Smartphone, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { translateError } from "@digitalbahi/i18n";
import { validateEmail } from "@digitalbahi/core";
import { useI18n } from "../../app/i18n";
import { useSession } from "../../app/session";
import { PinLockSettings } from "../../components/layout/PinLock";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { tintFor } from "../../components/ui/misc";
import { BUSINESS, WORKSPACE } from "../../data/db";
import { ApiError } from "../../lib/api";
import { initialsOf, PasswordStrength } from "./parts";
import { PasswordInput } from "./AuthPage";
import { SessionsCard, TwoStepCard } from "./TwoStep";

/** The signed-in person's own page: their name and email, a new password, two-step sign-in and where they are signed in. */
export function ProfilePage() {
  const i18n = useI18n();
  const { t } = i18n;
  const session = useSession();
  const toast = useToast();
  const user = session.user;
  const [details, setDetails] = useState({ name: user?.name ?? "", email: user?.email ?? "" });
  const [detailsError, setDetailsError] = useState<ApiError | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "", again: "" });
  const [pwTried, setPwTried] = useState(false);
  const [pwError, setPwError] = useState<ApiError | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  if (!user) return null;

  const nameIssue = details.name.trim().length < 2 ? (details.name.trim() ? t("validation.tooShort", { min: 2 }) : t("validation.required")) : null;
  const emailIssue = details.email.trim() && validateEmail(details.email).length ? t("validation.email") : null;
  const serverAt = (error: ApiError | null, field: string) => (error?.field === field ? translateError(i18n, error) : null);
  const changed = details.name.trim() !== user.name || details.email.trim().toLowerCase() !== (user.email ?? "");

  const saveDetails = async (e: FormEvent) => {
    e.preventDefault();
    if (nameIssue || emailIssue || !changed) return;
    setSavingDetails(true);
    setDetailsError(null);
    try {
      await session.updateProfile({ name: details.name.trim(), email: details.email.trim() });
      toast({ tone: "success", title: t("profile.saved") });
    } catch (err) {
      setDetailsError(err instanceof ApiError ? err : new ApiError(0, "generic"));
    } finally {
      setSavingDetails(false);
    }
  };

  const pwIssues = {
    current: !pw.current ? t("validation.required") : null,
    next: !pw.next ? t("validation.required") : pw.next.length < 8 ? t("validation.passwordShort") : null,
    again: pw.again !== pw.next ? t("profile.mismatch") : null,
  };
  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwTried(true);
    if (pwIssues.current || pwIssues.next || pwIssues.again) return;
    setSavingPw(true);
    setPwError(null);
    try {
      await session.changePassword(pw.current, pw.next);
      setPw({ current: "", next: "", again: "" });
      setPwTried(false);
      toast({ tone: "success", title: t("profile.changed") });
    } catch (err) {
      setPwError(err instanceof ApiError ? err : new ApiError(0, "generic"));
    } finally {
      setSavingPw(false);
    }
  };
  const generalDetails = detailsError && !detailsError.field ? translateError(i18n, detailsError) : null;
  const generalPw = pwError && pwError.field !== "currentPassword" && pwError.field !== "newPassword" ? translateError(i18n, pwError) : null;
  const role = WORKSPACE.role.replace(/^\w/, (c) => c.toUpperCase());

  return (
    <div className="animate-page mx-auto flex w-full max-w-2xl flex-col gap-5">
      <PageHeader title={t("profile.title")} subtitle={t("profile.subtitle")} />

      <Card className="bg-hero on-dark relative overflow-hidden p-5">
        <div className="dots pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div className="relative flex items-center gap-4">
          <span className={`inline-flex size-16 shrink-0 items-center justify-center rounded-full font-display text-[22px] font-semibold ${tintFor(user.name)}`} aria-hidden>
            {initialsOf(user.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-display text-[20px] font-semibold text-ink">{user.name}</p>
            <p className="truncate text-[13px] text-ink-2">{t("profile.role", { business: BUSINESS.name })}: {role}</p>
            <p className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] text-ink-2">
              <Smartphone size={14} aria-hidden />
              {user.mobile}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("profile.details")} />
        <form className="flex flex-col gap-4 p-4 sm:p-5" onSubmit={(e) => void saveDetails(e)} noValidate>
          <Field label={t("profile.name")} htmlFor="profile-name" error={nameIssue ?? serverAt(detailsError, "name")}>
            <Input id="profile-name" autoComplete="name" leading={<UserRound size={17} />} invalid={Boolean(nameIssue)} value={details.name} onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))} />
          </Field>
          <Field label={`${t("profile.email")} (${t("common.optional")})`} htmlFor="profile-email" error={emailIssue ?? serverAt(detailsError, "email")}>
            <Input id="profile-email" type="email" autoComplete="email" leading={<Mail size={17} />} invalid={Boolean(emailIssue ?? serverAt(detailsError, "email"))} value={details.email} onChange={(e) => setDetails((d) => ({ ...d, email: e.target.value }))} />
          </Field>
          <Field label={t("profile.mobile")} htmlFor="profile-mobile">
            <Input id="profile-mobile" leading={<Smartphone size={17} />} value={user.mobile} disabled readOnly />
          </Field>
          {generalDetails && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
              {generalDetails}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={savingDetails || !changed || Boolean(nameIssue || emailIssue)}>
              {t("profile.save")}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title={t("profile.passwordTitle")} subtitle={t("profile.passwordSubtitle")} />
        <form className="flex flex-col gap-4 p-4 sm:p-5" onSubmit={(e) => void changePassword(e)} noValidate>
          <Field label={t("profile.current")} htmlFor="profile-current" error={(pwTried && pwIssues.current) || serverAt(pwError, "currentPassword")}>
            <PasswordInput id="profile-current" autoComplete="current-password" leading={<LockKeyhole size={17} />} invalid={Boolean((pwTried && pwIssues.current) || serverAt(pwError, "currentPassword"))} value={pw.current} onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} />
          </Field>
          <div className="flex flex-col gap-2">
            <Field label={t("profile.new")} htmlFor="profile-new" error={pwTried ? pwIssues.next : null}>
              <PasswordInput id="profile-new" autoComplete="new-password" leading={<KeyRound size={17} />} invalid={Boolean(pwTried && pwIssues.next)} value={pw.next} onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} />
            </Field>
            {!(pwTried && pwIssues.next) && <PasswordStrength password={pw.next} />}
          </div>
          <Field label={t("profile.confirm")} htmlFor="profile-again" error={pwTried || pw.again.length >= pw.next.length ? pwIssues.again : null}>
            <PasswordInput id="profile-again" autoComplete="new-password" leading={<KeyRound size={17} />} invalid={Boolean((pwTried || pw.again.length >= pw.next.length) && pwIssues.again)} value={pw.again} onChange={(e) => setPw((p) => ({ ...p, again: e.target.value }))} />
          </Field>
          {generalPw && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
              {generalPw}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={savingPw}>
              {t("profile.change")}
            </Button>
          </div>
        </form>
      </Card>

      <TwoStepCard />
      <SessionsCard />
      <PinLockSettings />
    </div>
  );
}
