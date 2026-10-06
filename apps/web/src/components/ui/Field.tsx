import { CalendarDays } from "lucide-react";
import { forwardRef, useEffect, useId, useRef, useState, type ChangeEvent, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const control =
  "w-full rounded-[var(--radius-control)] border bg-surface text-ink shadow-[inset_0_1px_1px_rgb(16_24_40/0.03)] placeholder:text-ink-3 " +
  "transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-4 disabled:bg-surface-2";
// The border's colours, one set or the other (cn does not drop a class another overrides).
const tone = "border-line hover:border-line-strong focus:border-accent focus:ring-accent/15";
const invalidTone = "border-danger focus:border-danger focus:ring-danger/20";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode;
  trailing?: ReactNode;
  inputSize?: "sm" | "md" | "lg";
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  // Dates are typed and shown as DD/MM/YYYY everywhere, whatever the browser's own language.
  if (props.type === "date") return <DateInput ref={ref} {...props} />;
  return <PlainInput ref={ref} {...props} />;
});

const PlainInput = forwardRef<HTMLInputElement, InputProps>(function PlainInput(
  { leading, trailing, inputSize = "md", invalid, className, ...rest },
  ref,
) {
  const height = inputSize === "sm" ? "h-8 text-[13px]" : inputSize === "lg" ? "h-12 text-[15px]" : "h-10 text-sm";
  return (
    <div className={cn("relative flex items-center", className)}>
      {leading && <span className="pointer-events-none absolute left-3 flex text-ink-3">{leading}</span>}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(control, invalid ? invalidTone : tone, height, leading ? "pl-9" : "pl-3", trailing ? "pr-10" : "pr-3")}
        {...rest}
      />
      {trailing && <span className="absolute right-2 flex items-center">{trailing}</span>}
    </div>
  );
});

/** 2026-09-24 -> 24/09/2026 (empty stays empty). */
export const isoToDmy = (iso: string | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

/**
 * What was typed, as a date: "24/09/2026", "24-09-2026", "24092026" or "2026-09-24" give
 * "2026-09-24"; anything not a real day gives null.
 */
export function dmyToIso(text: string): string | null {
  const t = text.trim();
  let d: number, m: number, y: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else {
    const digits = t.replace(/\D/g, "");
    if (digits.length !== 8) return null;
    [d, m, y] = [Number(digits.slice(0, 2)), Number(digits.slice(2, 4)), Number(digits.slice(4, 8))];
  }
  const at = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Digits as they are typed, with the slashes put in: "2409" -> "24/09", "24092026" -> "24/09/2026". */
function withSlashes(text: string): string {
  if (/^\d{4}-/.test(text)) return text;
  const digits = text.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join("/");
}

/**
 * A date as DD/MM/YYYY: typed (the slashes come by themselves) or picked from the calendar
 * button. Value and onChange stay ISO (2026-09-24), like the browser's own date box, so a
 * screen swaps one for the other without changing anything else.
 */
const DateInput = forwardRef<HTMLInputElement, InputProps>(function DateInput(
  { inputSize = "md", invalid, className, value, onChange, min, max, disabled, readOnly, id, onBlur, type: _type, leading: _leading, trailing: _trailing, ...rest },
  ref,
) {
  const iso = typeof value === "string" ? value : "";
  const [text, setText] = useState(() => isoToDmy(iso));
  const picker = useRef<HTMLInputElement>(null);
  // A new value from outside (a chip, a reset) shows at once; what is half typed stays.
  useEffect(() => {
    setText((current) => (dmyToIso(current) === iso ? current : isoToDmy(iso)));
  }, [iso]);
  const emit = (next: string) => onChange?.({ target: { value: next }, currentTarget: { value: next } } as ChangeEvent<HTMLInputElement>);
  const typed = (raw: string) => {
    const shown = withSlashes(raw);
    setText(/^\d{4}-/.test(shown) ? (dmyToIso(shown) ? isoToDmy(shown) : shown) : shown);
    const next = shown === "" ? "" : dmyToIso(shown);
    if (next !== null && next !== iso) emit(next);
  };
  const outOfRange = Boolean(iso && ((typeof min === "string" && min && iso < min) || (typeof max === "string" && max && iso > max)));
  const unfinished = text !== "" && dmyToIso(text) === null;
  const height = inputSize === "sm" ? "h-8 text-[13px]" : inputSize === "lg" ? "h-12 text-[15px]" : "h-10 text-sm";
  return (
    <div className={cn("relative flex items-center", className)}>
      <input
        ref={ref}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="DD/MM/YYYY"
        maxLength={10}
        value={text}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={invalid || outOfRange || undefined}
        className={cn(control, invalid || outOfRange ? invalidTone : tone, height, "num pr-10 pl-3")}
        onChange={(e) => typed(e.target.value)}
        onBlur={(e) => {
          // Left half typed: back to the date it still holds.
          if (unfinished) setText(isoToDmy(iso));
          onBlur?.(e);
        }}
        {...rest}
      />
      <span className="absolute right-1.5 flex items-center">
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || readOnly}
          aria-hidden
          className="flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          onClick={() => {
            const el = picker.current;
            if (!el) return;
            try {
              el.showPicker();
            } catch {
              el.focus();
              el.click();
            }
          }}
        >
          <CalendarDays size={16} />
        </button>
        {/* The browser's calendar, opened by the button above; only its value is used. */}
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute right-0 bottom-0 size-px opacity-0"
          value={iso}
          min={min}
          max={max}
          onChange={(e) => {
            setText(isoToDmy(e.target.value));
            emit(e.target.value);
          }}
        />
      </span>
    </div>
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(control, tone, "h-10 px-3 text-sm", className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}) {
  const fallback = useId();
  const id = htmlFor ?? fallback;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, disabled, className }: { label: ReactNode; checked: boolean; onChange(v: boolean): void; disabled?: boolean; className?: string }) {
  return (
    <label className={cn("inline-flex items-center gap-2 text-[14px] text-ink-2", disabled && "opacity-60", className)}>
      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
