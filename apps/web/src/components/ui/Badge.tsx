import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type Tone = "neutral" | "accent" | "good" | "warn" | "danger";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  accent: "bg-accent-soft text-accent-ink border-transparent",
  good: "bg-good-soft text-good border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
};

const dots: Record<Tone, string> = {
  neutral: "bg-ink-3",
  accent: "bg-accent",
  good: "bg-good",
  warn: "bg-warn",
  danger: "bg-danger",
};

/**
 * Status badge. State is never colour alone: every badge carries a text label
 * and (optionally) an icon, so it reads in print, greyscale and for colour-blind users.
 */
export function Badge({
  tone = "neutral",
  icon,
  dot,
  children,
  className,
}: {
  tone?: Tone;
  icon?: ReactNode;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", dots[tone])} aria-hidden />}
      {icon}
      {children}
    </span>
  );
}
