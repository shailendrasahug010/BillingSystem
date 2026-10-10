import type { SignedInSession, TwoStepSetup as SetupAnswer, TwoStepStatus } from "@digitalbahi/contracts";
import { translateError } from "@digitalbahi/i18n";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Download, KeyRound, Laptop, Loader2, LockKeyhole, ShieldCheck, Smartphone } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useI18n } from "../../app/i18n";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { QrCode } from "../../components/ui/QrCode";
import { useToast } from "../../components/ui/Toast";
import { api, ApiError } from "../../lib/api";
import { describeDevice } from "../../lib/device";
import { downloadText } from "../../lib/download";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { AuthLayout, PasswordInput } from "./AuthPage";
import { OtpBoxes, SecondStepField } from "./parts";

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "generic"));

/** Copies text, saying so on the button; without a clipboard (plain http) the text stays on screen to copy by hand. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  if (typeof navigator === "undefined" || !navigator.clipboard) return null;
  return (
    <Button
      size="sm"
      icon={copied ? <Check size={14} /> : <Copy size={14} />}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? t("twoStep.copied") : label}
    </Button>
  );
}

/** The recovery codes, shown once: to copy, save as a file or write down. */
function RecoveryCodes({ codes }: { codes: string[] }) {
  const { t } = useI18n();
  const text = codes.join("\n");
  return (
    <div className="flex flex-col gap-3">
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border border-line bg-surface-2/60 p-4 font-mono text-[15px] text-ink" data-recovery-codes>
        {codes.map((c) => (
          <li key={c} className="tabular-nums select-all">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={text} label={t("twoStep.copyCodes")} />
        <Button size="sm" icon={<Download size={14} />} onClick={() => downloadText("digital-bahi-recovery-codes.txt", `${t("twoStep.codesFileTitle")}\n\n${text}\n`, "text/plain;charset=utf-8")}>
          {t("twoStep.saveCodes")}
        </Button>
      </div>
    </div>
  );
}

/** "ABCD EFGH …": the key in groups of four, easier to type into an app. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

/**
 * Turning two-step sign-in on: the password, then the authenticator app is
 * set up from a QR code (or the key typed by hand) and its first code proves
 * it, then the recovery codes are shown once.
 */
export function TwoStepSetup({ onDone }: { onDone(): void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [stage, setStage] = useState<"password" | "scan" | "codes">("password");
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<SetupAnswer | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  // On a phone the app may be on this same phone: a link opens it with the key filled in.
  const touch = useMediaQuery("(pointer: coarse)");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  };
  const start = (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    void run(async () => {
      setSetup(await api.post<SetupAnswer>("/auth/two-step/setup", { password }));
      setPassword("");
      setStage("scan");
    });
  };
  const turnOn = (typed = code) => {
    if (!/^\d{6}$/.test(typed) || busy) return;
    void run(async () => {
      const res = await api.post<{ recoveryCodes: string[] }>("/auth/two-step/enable", { code: typed });
      setCodes(res.recoveryCodes);
      setStage("codes");
    });
  };
  const at = (field: string) => (error?.field === field ? translateError(i18n, error) : null);
  const general = error && !error.field ? error : null;

  if (stage === "password")
    return (
      <form className="flex flex-col gap-4" onSubmit={start} noValidate>
        <p className="text-[14px] text-ink-2">{t("twoStep.passwordFirst")}</p>
        <Field label={t("auth.password")} htmlFor="two-step-password" error={at("password")}>
          <PasswordInput id="two-step-password" autoComplete="current-password" leading={<LockKeyhole size={17} />} invalid={Boolean(at("password"))} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        {general && <ErrorNote error={general} />}
        <div>
          <Button type="submit" variant="primary" disabled={busy || !password} icon={busy ? <Loader2 size={16} className="animate-spin" /> : undefined}>
            {t("common.next")}
          </Button>
        </div>
      </form>
    );

  if (stage === "scan" && setup)
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          turnOn();
        }}
        noValidate
      >
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-[14px] text-ink-2">
          <li>{t("twoStep.stepInstall")}</li>
          <li>{t("twoStep.stepScan")}</li>
          <li>{t("twoStep.stepCode")}</li>
        </ol>
        <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface-2/50 p-4 sm:flex-row sm:items-start">
          <QrCode text={setup.uri} size={168} label={t("twoStep.qrLabel")} />
          <div className="flex min-w-0 flex-col gap-2 text-[13px] text-ink-3">
            <p>{t("twoStep.cantScan")}</p>
            <p className="font-mono text-[15px] break-all text-ink select-all" data-two-step-key>
              {grouped(setup.secret)}
            </p>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={setup.secret} label={t("twoStep.copyKey")} />
            </div>
            {touch && (
              <a href={setup.uri} className="font-medium text-accent hover:underline">
                {t("twoStep.openApp")}
              </a>
            )}
          </div>
        </div>
        <Field label={t("twoStep.codeLabel")} htmlFor="two-step-code" error={at("code")}>
          <OtpBoxes id="two-step-code" value={code} onChange={setCode} onComplete={(c) => turnOn(c)} invalid={Boolean(at("code"))} />
        </Field>
        {general && <ErrorNote error={general} />}
        <div>
          <Button type="submit" variant="primary" disabled={busy || !/^\d{6}$/.test(code)} icon={busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}>
            {t("twoStep.turnOn")}
          </Button>
        </div>
      </form>
    );

  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2 rounded-lg bg-good-soft px-3 py-2 text-[14px] font-medium text-good" role="status">
        <ShieldCheck size={17} className="shrink-0" aria-hidden />
        {t("twoStep.nowOn")}
      </p>
      <p className="text-[14px] text-ink-2">{t("twoStep.codesHelp")}</p>
      <RecoveryCodes codes={codes} />
      <Checkbox label={t("twoStep.keptCodes")} checked={kept} onChange={setKept} />
      <div>
        <Button variant="primary" disabled={!kept} onClick={onDone}>
          {t("common.done")}
        </Button>
      </div>
    </div>
  );
}

/** Two-step sign-in on My profile: turn it on, make new recovery codes, turn it off. */
export function TwoStepCard() {
  const i18n = useI18n();
  const { t, dateTime } = i18n;
  const toast = useToast();
  const status = useQuery({ queryKey: ["two-step"], queryFn: () => api.get<TwoStepStatus>("/auth/two-step") });
  const [open, setOpen] = useState<null | "on" | "codes" | "off">(null);
  const [form, setForm] = useState({ password: "", code: "" });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const on = status.data?.enabled ?? false;
  const left = status.data?.recoveryCodesLeft ?? 0;

  const show = (which: typeof open) => {
    setForm({ password: "", code: "" });
    setCodes(null);
    setError(null);
    setOpen(which);
  };
  const close = () => {
    setOpen(null);
    void status.refetch();
  };
  const at = (field: string) => (error?.field === field ? translateError(i18n, error) : null);
  const send = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  };
  const newCodes = (e?: FormEvent) => {
    e?.preventDefault();
    if (!form.code.trim() || busy) return;
    void send(async () => {
      setCodes((await api.post<{ recoveryCodes: string[] }>("/auth/two-step/recovery-codes", { code: form.code.trim() })).recoveryCodes);
    });
  };
  const turnOff = (e: FormEvent) => {
    e.preventDefault();
    if (!form.password || !form.code.trim() || busy) return;
    void send(async () => {
      await api.post("/auth/two-step/disable", { password: form.password, code: form.code.trim() });
      close();
      toast({ tone: "success", title: t("twoStep.turnedOff") });
    });
  };

  return (
    <Card>
      <CardHeader
        title={t("twoStep.title")}
        subtitle={t("twoStep.subtitle")}
        action={status.data ? <Badge tone={on ? "good" : "neutral"} icon={on ? <ShieldCheck size={13} /> : undefined}>{on ? t("twoStep.on") : t("twoStep.off")}</Badge> : undefined}
      />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {status.error ? <ErrorNote error={status.error} onRetry={() => void status.refetch()} /> : null}
        {status.data &&
          (on ? (
            <>
              <p className="text-[13.5px] text-ink-2">
                {t("twoStep.onSince", { when: status.data.enabledAt ? dateTime(status.data.enabledAt) : "—" })} · {t("twoStep.codesLeft", { count: left })}
              </p>
              {left <= 3 && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("twoStep.fewCodes")}</p>}
              <div className="flex flex-wrap gap-2">
                <Button icon={<KeyRound size={16} />} onClick={() => show("codes")}>
                  {t("twoStep.newCodes")}
                </Button>
                <Button variant="ghost" onClick={() => show("off")}>
                  {t("twoStep.turnOff")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[13.5px] text-ink-2">{t("twoStep.offHelp")}</p>
              <div>
                <Button variant="primary" icon={<ShieldCheck size={16} />} onClick={() => show("on")}>
                  {t("twoStep.turnOn")}
                </Button>
              </div>
            </>
          ))}
      </div>

      <Dialog open={open === "on"} onOpenChange={(v) => !v && close()} title={t("twoStep.setupTitle")} closeLabel={t("common.close")}>
        {open === "on" && (
          <TwoStepSetup
            onDone={() => {
              close();
              toast({ tone: "success", title: t("twoStep.nowOn") });
            }}
          />
        )}
      </Dialog>

      <Dialog open={open === "codes"} onOpenChange={(v) => !v && close()} title={t("twoStep.newCodes")} closeLabel={t("common.close")}>
        {codes ? (
          <div className="flex flex-col gap-4">
            <p className="text-[14px] text-ink-2">{t("twoStep.newCodesDone")}</p>
            <RecoveryCodes codes={codes} />
            <div>
              <Button variant="primary" onClick={close}>
                {t("common.done")}
              </Button>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={newCodes} noValidate>
            <p className="text-[14px] text-ink-2">{t("twoStep.newCodesHelp")}</p>
            <SecondStepField id="two-step-new-codes" value={form.code} onChange={(code) => setForm((f) => ({ ...f, code }))} error={at("code")} />
            {error && !error.field && <ErrorNote error={error} />}
            <div>
              <Button type="submit" variant="primary" disabled={busy || !form.code.trim()}>
                {t("twoStep.makeCodes")}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog open={open === "off"} onOpenChange={(v) => !v && close()} title={t("twoStep.offTitle")} description={t("twoStep.offWarning")} closeLabel={t("common.close")}>
        <form className="flex flex-col gap-4" onSubmit={turnOff} noValidate>
          <Field label={t("auth.password")} htmlFor="two-step-off-password" error={at("password")}>
            <PasswordInput id="two-step-off-password" autoComplete="current-password" leading={<LockKeyhole size={17} />} invalid={Boolean(at("password"))} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} autoFocus />
          </Field>
          <SecondStepField id="two-step-off-code" value={form.code} onChange={(code) => setForm((f) => ({ ...f, code }))} error={at("code")} autoFocus={false} />
          {error && !error.field && <ErrorNote error={error} />}
          <div>
            <Button type="submit" variant="danger" disabled={busy || !form.password || !form.code.trim()}>
              {t("twoStep.turnOff")}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

/** "Chrome on Windows", "Digital Bahi app on Android". */
function deviceLabel(t: ReturnType<typeof useI18n>["t"], userAgent: string | null): string {
  const d = describeDevice(userAgent);
  if (d.app) return t("sessions.app", { os: d.os ?? "Android" });
  if (d.browser && d.os) return t("sessions.browserOn", { browser: d.browser, os: d.os });
  return d.browser ?? d.os ?? t("sessions.unknown");
}

/** Where the account is signed in, with a way to sign any of them out. */
export function SessionsCard() {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<{ data: SignedInSession[] }>("/auth/sessions").then((r) => r.data) });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const others = (list.data ?? []).filter((s) => !s.current);

  const end = async (s: SignedInSession) => {
    const name = deviceLabel(t, s.userAgent);
    const ok = await confirm({ title: t("sessions.endTitle"), body: t("sessions.endBody", { device: name }), confirmLabel: t("sessions.end"), danger: true });
    if (!ok) return;
    setBusy(s.id);
    setError(null);
    try {
      await api.delete(`/auth/sessions/${s.id}`);
      await list.refetch();
      toast({ tone: "success", title: t("sessions.ended"), body: name });
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(null);
    }
  };
  const endOthers = async () => {
    const ok = await confirm({ title: t("sessions.endOthersTitle"), body: t("sessions.endOthersBody", { count: others.length }), confirmLabel: t("sessions.endOthers"), danger: true });
    if (!ok) return;
    setBusy("others");
    setError(null);
    try {
      const res = await api.post<{ ended: number }>("/auth/sessions/end-others");
      await list.refetch();
      toast({ tone: "success", title: t("sessions.endedOthers", { count: res.ended }) });
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader title={t("sessions.title")} subtitle={t("sessions.subtitle")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {error ? <ErrorNote error={error} /> : null}
        {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
        {list.isPending && <p className="text-[13.5px] text-ink-3">{t("common.loading")}</p>}
        <ul className="flex flex-col divide-y divide-line" data-sessions>
          {(list.data ?? []).map((s) => {
            const d = describeDevice(s.userAgent);
            return (
              <li key={s.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0" data-session={s.current ? "current" : "other"}>
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-2" aria-hidden>
                  {d.phone || d.app ? <Smartphone size={17} /> : <Laptop size={17} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                    {deviceLabel(t, s.userAgent)}
                    {s.current && <Badge tone="good">{t("sessions.thisDevice")}</Badge>}
                  </p>
                  <p className="text-[12.5px] text-ink-3">
                    {t("sessions.signedIn", { when: dateTime(s.signedInAt) })} · {t("sessions.lastActive", { when: dateTime(s.lastSeenAt) })}
                    {s.ip ? ` · ${s.ip}` : ""}
                  </p>
                </div>
                {!s.current && (
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void end(s)}>
                    {t("sessions.end")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {others.length > 1 && (
          <div>
            <Button size="sm" disabled={busy !== null} onClick={() => void endOthers()}>
              {t("sessions.endOthers")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The business asks for two-step sign-in: it opens once it is on (or the person signs out). */
export function TwoStepRequiredPage() {
  const { t } = useI18n();
  const session = useSession();
  const business = session.me?.business;
  const [opening, setOpening] = useState(false);
  return (
    <AuthLayout>
      <div className="flex flex-col gap-2">
        <span className="inline-flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
          <ShieldCheck size={22} />
        </span>
        <h1 className="text-[24px] leading-tight font-semibold text-ink">{t("twoStep.requiredTitle", { business: business?.tradeName ?? business?.legalName ?? "" })}</h1>
        <p className="text-[14px] text-ink-2">{t("twoStep.requiredHelp")}</p>
      </div>
      <TwoStepSetup
        onDone={() => {
          setOpening(true);
          void session.reopen().finally(() => setOpening(false));
        }}
      />
      {opening && <p className="text-[13px] text-ink-3" role="status">{t("auth.loadingWorkspace")}</p>}
      <div className="flex justify-center">
        <Button variant="ghost" onClick={() => void session.logout()}>
          {t("auth.signOut")}
        </Button>
      </div>
    </AuthLayout>
  );
}
