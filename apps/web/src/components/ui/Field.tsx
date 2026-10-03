import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
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

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
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
