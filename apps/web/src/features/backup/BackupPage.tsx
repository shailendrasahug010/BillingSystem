import type { SessionResponse } from "@vyapaar/contracts";
import { translateError } from "@vyapaar/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, DatabaseBackup, Download, Eye, EyeOff, Mail, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useSession } from "../../app/session";
import { useChannels } from "../../components/messaging/SendDialog";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, PageHeader } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, BUSINESS, TODAY } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { downloadBlob } from "../../lib/download";

interface BackupRow {
  id: string;
  kind: "download" | "email" | "auto" | "restore";
  status: "queued" | "running" | "completed" | "failed";
  sizeBytes: number | null;
  sha256: string | null;
  schemaVersion: string | null;
  encrypted: boolean;
  error: string | null;
  createdAt: string;
  by: string | null;
}

interface Schedule {
  frequency: "off" | "daily" | "weekly";
  hour: number;
  weekday: number;
  to: string | null;
  defaultTo: string | null;
  hasPassword: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "sent" | "failed" | null;
  lastError: { code: string; params: Record<string, string | number> } | null;
  emailReady: boolean;
  setUpBy: string | null;
}

interface Manifest {
  schema: string;
  createdAt: string;
  business: { legalName: string; tradeName: string | null; gstin: string | null };
  counts: Record<string, number>;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "firm";

const size = (bytes: number | null) => (bytes === null ? "—" : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/** Password box with show / hide. */
function Secret({ id, label, hint, value, onChange }: { id: string; label: string; hint?: string; value: string; onChange(v: string): void }) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  return (
    <Field label={label} htmlFor={id} {...(hint ? { hint } : {})}>
      <div className="flex gap-2">
        <Input id={id} type={show ? "text" : "password"} autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} className="flex-1" />
        <Button variant="ghost" aria-label={show ? t("backup.hidePassword") : t("backup.showPassword")} icon={show ? <EyeOff size={16} /> : <Eye size={16} />} onClick={() => setShow((v) => !v)} />
      </div>
    </Field>
  );
}

/**
 * Backup & Restore for the owner: the whole firm as one file (optionally
 * password-protected), a protected copy by email, earlier backups, and
 * restoring a file as a NEW business (the current one is never touched).
 */
export function BackupPage() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("backup.title")} subtitle={t("backup.subtitle")} />
      {allowed("backup.download") && <DownloadCard />}
      {allowed("backup.download") && allowed("backup.configure") && <ScheduleCard />}
      <HistoryCard />
      {allowed("backup.restore") && <RestoreCard />}
    </div>
  );
}

function DownloadCard() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const channels = useChannels();
  const [password, setPassword] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [to, setTo] = useState(BUSINESS.email ?? "");
  const [busy, setBusy] = useState<"download" | "email" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const tooShort = (p: string) => p.length > 0 && p.length < 8;

  const download = async () => {
    setBusy("download");
    setError(null);
    try {
      const blob = await api.post<Blob>("/backups/download", password ? { passphrase: password } : {}, { raw: true });
      const name = `digital-bahi-${slug(BUSINESS.name)}-${TODAY}.dbbackup`;
      downloadBlob(name, blob);
      toast({ tone: "success", title: t("backup.downloaded"), body: `${name} · ${size(blob.size)}` });
      void qc.invalidateQueries({ queryKey: ["backups"] });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(null);
    }
  };
  const email = async () => {
    setBusy("email");
    setError(null);
    try {
      const res = await api.post<{ sentTo: string; sizeBytes: number }>("/backups/email", { passphrase: emailPassword, ...(to.trim() ? { to: to.trim() } : {}) });
      toast({ tone: "success", title: t("backup.emailed", { to: res.sentTo }), body: size(res.sizeBytes) });
      setEmailPassword("");
      void qc.invalidateQueries({ queryKey: ["backups"] });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
      void qc.invalidateQueries({ queryKey: ["backups"] });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader title={t("backup.downloadTitle")} subtitle={t("backup.downloadHint")} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Secret id="backup-password" label={t("backup.password")} hint={t("backup.passwordHint")} value={password} onChange={setPassword} />
          <Button variant="primary" icon={<Download size={16} />} disabled={busy !== null || tooShort(password)} onClick={() => void download()}>
            {busy === "download" ? t("backup.preparing") : t("backup.download")}
          </Button>
        </div>
        {!password && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">{t("backup.noPasswordWarning")}</p>}
        {channels.data?.email.ready && (
          <section className="flex flex-col gap-3 border-t border-line pt-4">
            <h3 className="text-[14px] font-semibold text-ink">{t("backup.emailTitle")}</h3>
            <p className="text-[13px] text-ink-3">{t("backup.emailHint")}</p>
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Field label={t("messages.to")} htmlFor="backup-to">
                <Input id="backup-to" type="email" value={to} placeholder="accounts@…" onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Secret id="backup-email-password" label={t("backup.password")} value={emailPassword} onChange={setEmailPassword} />
              <Button icon={<Mail size={16} />} disabled={busy !== null || emailPassword.length < 8 || !to.trim()} onClick={() => void email()}>
                {busy === "email" ? t("backup.preparing") : t("backup.emailSend")}
              </Button>
            </div>
          </section>
        )}
      </div>
    </Card>
  );
}

/** 1 Jan 2023 was a Sunday: weekday names and hours in the reader's language. */
const weekdayName = (day: number, locale: string) => new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + day)));
const hourName = (hour: number, locale: string) => new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1, hour)));

/**
 * Automatic backups: a password-protected copy emailed every day or week,
 * so there is a copy away from this computer without anyone remembering.
 */
function ScheduleCard() {
  const i18n = useI18n();
  const { t, dateTime, locale } = i18n;
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["backup-schedule"], queryFn: () => api.get<Schedule>("/backups/schedule") });
  const [frequency, setFrequency] = useState<Schedule["frequency"]>("off");
  const [hour, setHour] = useState(21);
  const [weekday, setWeekday] = useState(0);
  const [to, setTo] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!q.data) return;
    setFrequency(q.data.frequency);
    setHour(q.data.hour);
    setWeekday(q.data.weekday);
    setTo(q.data.to ?? "");
  }, [q.data]);

  const s = q.data;
  const needsPassword = frequency !== "off" && !s?.hasPassword;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<Schedule>("/backups/schedule", { frequency, hour, weekday, to: to.trim(), ...(password ? { passphrase: password } : {}) });
      qc.setQueryData(["backup-schedule"], saved);
      setPassword("");
      toast({ tone: "success", title: saved.frequency === "off" ? t("backup.auto.turnedOff") : t("backup.auto.saved"), ...(saved.nextRunAt ? { body: t("backup.auto.next", { when: dateTime(saved.nextRunAt) }) } : {}) });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("backup.auto.title")} subtitle={t("backup.auto.hint")} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {q.error ? <ErrorNote error={q.error} /> : null}
        {error ? <ErrorNote error={error} /> : null}
        {s && !s.emailReady && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">{t("backup.auto.emailNotReady")}</p>}
        {s && (
          <>
            <Segmented
              label={t("backup.auto.frequency")}
              value={frequency}
              onChange={setFrequency}
              options={[
                { value: "off", label: t("backup.auto.off") },
                { value: "daily", label: t("backup.auto.daily") },
                { value: "weekly", label: t("backup.auto.weekly") },
              ]}
            />
            {frequency !== "off" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {frequency === "weekly" && (
                  <Field label={t("backup.auto.day")} htmlFor="auto-day">
                    <Select id="auto-day" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                      {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                        <option key={d} value={d}>
                          {weekdayName(d, locale)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label={t("backup.auto.time")} htmlFor="auto-hour">
                  <Select id="auto-hour" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {hourName(h, locale)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("messages.to")} htmlFor="auto-to" hint={s.defaultTo ? t("backup.auto.toHint", { email: s.defaultTo }) : t("backup.auto.toNeeded")}>
                  <Input id="auto-to" type="email" value={to} placeholder={s.defaultTo ?? "accounts@…"} onChange={(e) => setTo(e.target.value)} />
                </Field>
                <Secret
                  id="auto-password"
                  label={t("backup.password")}
                  hint={s.hasPassword ? t("backup.auto.passwordSaved") : t("backup.passwordHint")}
                  value={password}
                  onChange={setPassword}
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                icon={<CalendarClock size={16} />}
                disabled={busy || (frequency !== "off" && (!s.emailReady || (password.length > 0 && password.length < 8) || (needsPassword && !password) || (!to.trim() && !s.defaultTo)))}
                onClick={() => void save()}
              >
                {t("backup.auto.save")}
              </Button>
              {s.frequency !== "off" && s.nextRunAt && <span className="text-[13px] text-ink-2">{t("backup.auto.next", { when: dateTime(s.nextRunAt) })}</span>}
            </div>
            {s.lastRunAt && (
              <p className={s.lastStatus === "failed" ? "rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger" : "text-[12.5px] text-ink-3"} role={s.lastStatus === "failed" ? "alert" : undefined}>
                {s.lastStatus === "failed" ? t("backup.auto.lastFailed", { when: dateTime(s.lastRunAt), reason: translateError(i18n, s.lastError) }) : t("backup.auto.lastSent", { when: dateTime(s.lastRunAt) })}
              </p>
            )}
            {s.setUpBy && s.frequency !== "off" && <p className="text-[12px] text-ink-3">{t("backup.auto.setUpBy", { name: s.setUpBy })}</p>}
          </>
        )}
      </div>
    </Card>
  );
}

function HistoryCard() {
  const { t, dateTime } = useI18n();
  const q = useQuery({ queryKey: ["backups"], queryFn: () => api.get<{ data: BackupRow[] }>("/backups").then((r) => r.data) });
  return (
    <Card>
      <CardHeader title={t("backup.historyTitle")} subtitle={t("backup.historyHint")} />
      <div className="p-4 sm:p-5">
        {q.error ? <ErrorNote error={q.error} /> : null}
        <DataTable
          rows={q.data ?? []}
          loading={q.isPending}
          rowKey={(b) => b.id}
          minWidth={620}
          empty={<p className="p-4 text-[13.5px] text-ink-3">{t("backup.historyEmpty")}</p>}
          columns={[
            { key: "when", header: t("backup.when"), render: (b) => <span className="text-ink">{dateTime(b.createdAt)}</span> },
            {
              key: "kind",
              header: t("backup.kind"),
              render: (b) => (
                <span className="flex flex-wrap items-center gap-1.5">
                  {t(`backup.kinds.${b.kind}`)}
                  {b.encrypted && <Badge tone="good">{t("backup.protected")}</Badge>}
                  {b.status === "failed" && <Badge tone="danger">{t("messages.status.failed")}</Badge>}
                </span>
              ),
            },
            { key: "by", header: t("backup.by"), render: (b) => <span className="text-ink-2">{b.by ?? "—"}</span> },
            { key: "size", header: t("backup.size"), align: "right", render: (b) => size(b.sizeBytes) },
            { key: "sum", header: t("backup.checksum"), render: (b) => <span className="font-mono text-[12px] text-ink-3" title={b.sha256 ?? ""}>{b.sha256?.slice(0, 12) ?? "—"}</span> },
          ]}
        />
      </div>
    </Card>
  );
}

const SHOWN = ["customers", "suppliers", "products", "invoices", "purchases", "payments", "credit_debit_notes", "expenses", "employees"] as const;

function RestoreCard() {
  const { t, dateTime, date } = useI18n();
  const toast = useToast();
  const session = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const b64 = (v: string) => btoa(String.fromCharCode(...new TextEncoder().encode(v)));
  const headers = () => (password ? { "x-backup-passphrase": b64(password) } : undefined);

  const check = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setManifest(null);
    try {
      const res = await api.upload<{ manifest: Manifest }>("/backups/restore", file, { query: { dryRun: "true" }, ...(headers() ? { headers: headers()! } : {}) });
      setManifest(res.manifest);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (!file || !manifest) return;
    setBusy(true);
    setError(null);
    try {
      // The person's own sign-in password again: an open session alone cannot restore.
      const res = await api.upload<{ session: SessionResponse; counts: Record<string, number> }>("/backups/restore", file, { headers: { ...headers(), "x-account-password": b64(accountPassword) } });
      const rows = Object.values(res.counts).reduce((a, b) => a + b, 0);
      await session.adopt(res.session);
      toast({ tone: "success", title: t("backup.restored", { name: res.session.business?.tradeName ?? "" }), body: t("backup.restoredRows", { count: rows }) });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("backup.restoreTitle")} subtitle={t("backup.restoreHint")} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Field label={t("backup.file")} htmlFor="restore-file">
            <input
              id="restore-file"
              type="file"
              accept=".dbbackup,application/octet-stream"
              className="block w-full text-[13px] text-ink-2 file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-[13px] file:text-ink"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setManifest(null);
                setUnderstood(false);
              }}
            />
          </Field>
          <Secret id="restore-password" label={t("backup.passwordIfAny")} value={password} onChange={setPassword} />
          <Button icon={<Upload size={16} />} disabled={!file || busy} onClick={() => void check()}>
            {t("backup.check")}
          </Button>
        </div>
        {manifest && (
          <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <DatabaseBackup size={18} className="text-accent" />
              <span className="text-[15px] font-semibold text-ink">{manifest.business.tradeName ?? manifest.business.legalName}</span>
              {manifest.business.gstin && <span className="font-mono text-[12.5px] text-ink-3">{manifest.business.gstin}</span>}
              <span className="text-[13px] text-ink-3">· {t("backup.madeOn", { when: dateTime(manifest.createdAt) })}</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-3">
              {SHOWN.map((k) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-ink-3">{t(`backup.tables.${k}`)}</dt>
                  <dd className="num font-medium text-ink">{manifest.counts[k] ?? 0}</dd>
                </div>
              ))}
            </dl>
            <Checkbox label={t("backup.understand", { name: `${manifest.business.tradeName ?? manifest.business.legalName} (restored)`, today: date(TODAY) })} checked={understood} onChange={setUnderstood} />
            <div className="max-w-sm">
              <Secret id="restore-account-password" label={t("backup.accountPassword")} hint={t("backup.accountPasswordHint")} value={accountPassword} onChange={setAccountPassword} />
            </div>
            <div>
              <Button variant="primary" icon={<DatabaseBackup size={16} />} disabled={!understood || !accountPassword || busy} onClick={() => void restore()}>
                {busy ? t("backup.restoring") : t("backup.restore")}
              </Button>
            </div>
          </section>
        )}
      </div>
    </Card>
  );
}
