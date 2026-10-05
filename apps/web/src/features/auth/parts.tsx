import { Check } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useI18n } from "../../app/i18n";
import { cn } from "../../lib/cn";

const DIGITS = 6;

/**
 * The 6-digit code as six boxes. The first box takes the phone's SMS
 * autofill (and a pasted or filled code) and spreads it over the boxes;
 * typing moves on, Backspace moves back. onComplete runs when the sixth
 * digit is in.
 */
export function OtpBoxes({
  id,
  value,
  onChange,
  onComplete,
  invalid,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange(code: string): void;
  onComplete?(code: string): void;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const focus = (i: number) => boxes.current[Math.max(0, Math.min(DIGITS - 1, i))]?.focus();

  /** Puts what was typed at box `at` (a whole code starts at the first box) and moves on. */
  const put = (at: number, typed: string) => {
    const digits = typed.replace(/\D/g, "");
    const chars = Array.from({ length: DIGITS }, (_, k) => ((value[k] ?? "").trim() ? value[k]! : " "));
    if (!digits) chars[at] = " ";
    else {
      const start = digits.length >= DIGITS ? 0 : at;
      digits
        .slice(0, DIGITS - start)
        .split("")
        .forEach((d, k) => (chars[start + k] = d));
      focus(start + digits.length);
    }
    const code = chars.join("");
    onChange(code.trimEnd());
    if (/^\d{6}$/.test(code) && code !== value) onComplete?.(code);
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !(value[i] ?? "").trim() && i > 0) {
      e.preventDefault();
      put(i - 1, "");
      focus(i - 1);
    } else if (e.key === "ArrowLeft") focus(i - 1);
    else if (e.key === "ArrowRight") focus(i + 1);
  };
  const onPaste = (i: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    put(i, e.clipboardData.getData("text"));
  };

  return (
    <div className="flex gap-2" role="group">
      {Array.from({ length: DIGITS }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          id={i === 0 ? id : undefined}
          aria-label={t("auth.otpDigit", { n: i + 1 })}
          aria-invalid={invalid || undefined}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          // The first box takes a whole code; the others one digit.
          maxLength={i === 0 ? DIGITS : 1}
          value={(value[i] ?? "").trim()}
          autoFocus={autoFocus && i === 0}
          onChange={(e) => put(i, e.target.value)}
          onKeyDown={onKeyDown(i)}
          onPaste={onPaste(i)}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "h-13 w-full min-w-0 rounded-[var(--radius-control)] border bg-surface text-center font-mono text-[22px] font-semibold text-ink tabular-nums",
            "transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-4",
            invalid ? "border-danger focus:ring-danger/20" : "border-line hover:border-line-strong focus:border-accent focus:ring-accent/15",
            (value[i] ?? "").trim() && !invalid && "border-accent/50 bg-accent-soft/40",
          )}
        />
      ))}
    </div>
  );
}

export type Strength = 0 | 1 | 2 | 3;

/** 0: too short (under 8); 1 weak; 2 okay; 3 strong (long, or letters, numbers and a symbol together). */
export function passwordStrength(password: string): Strength {
  if (password.length < 8) return 0;
  let points = 0;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) points++;
  if (/\d/.test(password)) points++;
  if (/[^A-Za-z0-9]/.test(password)) points++;
  if (password.length >= 12) points++;
  return points >= 3 ? 3 : points >= 1 ? 2 : 1;
}

/** Under a new password: a three-part bar and a tick once it is long enough. */
export function PasswordStrength({ password }: { password: string }) {
  const { t } = useI18n();
  const level = passwordStrength(password);
  const long = password.length >= 8;
  const names = ["", t("auth.strengthWeak"), t("auth.strengthOkay"), t("auth.strengthStrong")];
  const tone = level === 3 ? "bg-good" : level === 2 ? "bg-warn" : "bg-danger";
  return (
    <div className="flex flex-col gap-1.5" data-password-strength={level}>
      {password && (
        <div className="flex items-center gap-2">
          <div className="grid flex-1 grid-cols-3 gap-1" aria-hidden>
            {[1, 2, 3].map((n) => (
              <span key={n} className={cn("h-1.5 rounded-full transition-colors duration-300", Math.max(level, 1) >= n ? tone : "bg-surface-3")} />
            ))}
          </div>
          <span className="text-[12px] font-medium text-ink-2" role="status">
            {t("auth.strengthLabel", { level: names[Math.max(level, 1)] })}
          </span>
        </div>
      )}
      <p className={cn("inline-flex items-center gap-1 text-[12px]", long ? "text-good" : "text-ink-3")}>
        {long && <Check size={13} aria-hidden />}
        {t("auth.passwordHint")}
        {long && level < 3 && <span className="text-ink-3"> · {t("auth.strengthTip")}</span>}
      </p>
    </div>
  );
}

/** Seconds left until a time, ticking once a second. */
export function useCountdown(until: number): number {
  const [, tick] = useState(0);
  const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  useEffect(() => {
    if (until <= Date.now()) return;
    const id = window.setInterval(() => {
      tick((n) => n + 1);
      if (until <= Date.now()) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return left;
}

/** 9876569050 → 98••••9050, for "Code sent to …". */
export function maskMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? `${digits.slice(0, 2)}••••${digits.slice(-4)}` : mobile;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
