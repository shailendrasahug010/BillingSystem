import { Delete, Fingerprint, LockKeyhole } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../app/i18n";
import { bioAvailable, checkBio, enrolBio, LOCK_AFTER, PIN, pinMatches, readPin, removePin, setPin, unlockScreen, updatePin, useScreenLocked } from "../../app/pinLock";
import { useSession } from "../../app/session";
import { BUSINESS } from "../../data/db";
import { useStoreVersion } from "../../data/store";
import { unlockWithPassword } from "../../offline/vault";
import { Button } from "../ui/Button";
import { Card, CardHeader } from "../ui/Card";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { Dialog } from "../ui/Dialog";
import { cn } from "../../lib/cn";

/** Four dots and a number pad; a desktop keyboard types into it too. */
function PinPad({ value, onChange, onDone, error, disabled }: { value: string; onChange(v: string): void; onDone(pin: string): void; error?: string | null; disabled?: boolean }) {
  const { t } = useI18n();
  const press = (d: string) => {
    if (disabled || value.length >= 4) return;
    const next = value + d;
    onChange(next);
    if (next.length === 4) onDone(next);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") onChange(value.slice(0, -1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <div className="flex flex-col items-center gap-4">
      <div className={cn("flex gap-3", error && "animate-shake")} aria-label={t("pinLock.digits", { count: value.length })} role="status">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn("size-3.5 rounded-full border-2 border-accent", i < value.length ? "bg-accent" : "bg-transparent")} />
        ))}
      </div>
      <p className="min-h-5 text-[13px] text-danger" role="alert">
        {error ?? ""}
      </p>
      <div className="grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" disabled={disabled} className="press size-16 rounded-full bg-surface-2 text-[22px] font-semibold text-ink hover:bg-surface-3 disabled:opacity-50" onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <span />
        <button type="button" disabled={disabled} className="press size-16 rounded-full bg-surface-2 text-[22px] font-semibold text-ink hover:bg-surface-3 disabled:opacity-50" onClick={() => press("0")}>
          0
        </button>
        <button type="button" aria-label={t("pinLock.backspace")} className="press inline-flex size-16 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2" onClick={() => onChange(value.slice(0, -1))}>
          <Delete size={22} />
        </button>
      </div>
    </div>
  );
}

const WAIT_AFTER = 5;
const WAIT_MS = 30_000;

/** Covers the app while the screen is locked; what was on it (a half-made bill) stays as it was underneath. */
export function PinLockScreen() {
  const { t } = useI18n();
  const session = useSession();
  useStoreVersion();
  const user = session.user;
  const locked = useScreenLocked(user?.id);
  const settings = readPin(user?.id);
  const [pin, setPinValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordResult, setPasswordResult] = useState<"wrong" | "none" | null>(null);

  const done = () => {
    setPinValue("");
    setError(null);
    setWrong(0);
    setUsePassword(false);
    setPassword("");
    setPasswordResult(null);
    unlockScreen();
  };

  // The device's own check is offered straight away when it was set up.
  useEffect(() => {
    if (locked && settings?.bio) void checkBio(settings.bio).then((ok) => ok && done());
    // When the lock comes on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  // Everything else on the page (the app, an open dialog) is out of reach while locked.
  const cover = useRef<HTMLDivElement>(null);
  const shown = locked && Boolean(user && settings);
  useEffect(() => {
    if (!shown) return;
    const others = [...document.body.children].filter((el) => el !== cover.current && !el.hasAttribute("inert"));
    others.forEach((el) => el.setAttribute("inert", ""));
    return () => others.forEach((el) => el.removeAttribute("inert"));
  }, [shown]);

  useEffect(() => {
    if (!waitUntil) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waitUntil]);

  if (!locked || !user || !settings) return null;
  const waiting = waitUntil > now;

  const tryPin = async (value: string) => {
    if (await pinMatches(user.id, value)) return done();
    const count = wrong + 1;
    setWrong(count);
    setPinValue("");
    if (count >= WAIT_AFTER) {
      setWaitUntil(Date.now() + WAIT_MS);
      setNow(Date.now());
      setWrong(0);
    }
    setError(t("pinLock.wrong"));
  };

  return createPortal(
    <div ref={cover} style={{ pointerEvents: "auto" }} className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-6 overflow-y-auto bg-bg px-4 py-10" role="dialog" aria-modal="true" aria-label={t("pinLock.title")}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <LockKeyhole size={22} />
        </span>
        <h1 className="text-[20px] font-semibold text-ink">{t("pinLock.title")}</h1>
        <p className="text-[14px] text-ink-2">{BUSINESS.name ? `${user.name} · ${BUSINESS.name}` : user.name}</p>
      </div>

      {usePassword ? (
        <form
          className="flex w-full max-w-xs flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void unlockWithPassword(user.id, password).then((r) => (r === "ok" ? done() : setPasswordResult(r)));
          }}
        >
          <Field label={t("pinLock.password")} htmlFor="pin-password" error={passwordResult === "wrong" ? t("pinLock.passwordWrong") : passwordResult === "none" ? t("pinLock.passwordNone") : null}>
            <Input id="pin-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={!password}>
            {t("pinLock.open")}
          </Button>
          {passwordResult === "none" && (
            <Button variant="ghost" onClick={() => void session.logout()}>
              {t("auth.signOut")}
            </Button>
          )}
          <Button variant="ghost" onClick={() => setUsePassword(false)}>
            {t("pinLock.usePin")}
          </Button>
        </form>
      ) : (
        <>
          <PinPad value={pin} onChange={setPinValue} onDone={(v) => void tryPin(v)} error={waiting ? t("pinLock.wait", { seconds: Math.ceil((waitUntil - now) / 1000) }) : error} disabled={waiting} />
          <div className="flex flex-col items-center gap-1">
            {settings.bio && (
              <Button variant="soft" icon={<Fingerprint size={18} />} onClick={() => void checkBio(settings.bio!).then((ok) => ok && done())}>
                {t("pinLock.bio")}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setUsePassword(true)}>
              {t("pinLock.forgot")}
            </Button>
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

/** Profile → "Lock this device": set, change or remove the PIN and how soon it locks. */
export function PinLockSettings() {
  const { t } = useI18n();
  const session = useSession();
  useStoreVersion();
  const user = session.user;
  // The PIN lives in localStorage: a change re-reads it.
  const [, setVersion] = useState(0);
  const settings = readPin(user?.id);
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState<string | null>(null);
  const [pin, setPinValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [canBio, setCanBio] = useState(false);
  useEffect(() => {
    void bioAvailable().then(setCanBio);
  }, []);
  if (!user) return null;
  const refresh = () => setVersion((v) => v + 1);

  const typed = async (value: string) => {
    if (!PIN.test(value)) return;
    if (first === null) {
      setFirst(value);
      setPinValue("");
      setError(null);
      return;
    }
    if (value !== first) {
      setFirst(null);
      setPinValue("");
      setError(t("pinLock.mismatch"));
      return;
    }
    await setPin(user.id, value, settings?.minutes ?? 5, settings?.bio);
    setOpen(false);
    refresh();
  };

  return (
    <Card>
      <CardHeader title={t("pinLock.settingsTitle")} subtitle={t("pinLock.settingsHint")} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {settings ? (
          <>
            <Field label={t("pinLock.after")} htmlFor="pin-after">
              <Select
                id="pin-after"
                value={String(settings.minutes)}
                onChange={(e) => {
                  updatePin(user.id, { minutes: Number(e.target.value) });
                  refresh();
                }}
              >
                {LOCK_AFTER.map((m) => (
                  <option key={m} value={m}>
                    {t("pinLock.minutes", { count: m })}
                  </option>
                ))}
              </Select>
            </Field>
            {canBio && (
              <Checkbox
                label={t("pinLock.useBio")}
                checked={Boolean(settings.bio)}
                onChange={(on) =>
                  void (on ? enrolBio(user.id, user.name) : Promise.resolve(null)).then((id) => {
                    updatePin(user.id, { bio: id ?? undefined });
                    refresh();
                  })
                }
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => (setFirst(null), setPinValue(""), setError(null), setOpen(true))}>{t("pinLock.change")}</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  removePin(user.id);
                  refresh();
                }}
              >
                {t("pinLock.remove")}
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Button variant="primary" icon={<LockKeyhole size={17} />} onClick={() => (setFirst(null), setPinValue(""), setError(null), setOpen(true))}>
              {t("pinLock.set")}
            </Button>
          </div>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen} title={first === null ? t("pinLock.choose") : t("pinLock.again")} size="sm" closeLabel={t("common.close")}>
        <div className="py-2">{open && <PinPad value={pin} onChange={setPinValue} onDone={(v) => void typed(v)} error={error} />}</div>
      </Dialog>
    </Card>
  );
}
