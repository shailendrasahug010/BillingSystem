import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Accessible dialog (focus trap, Esc to close, labelled). On phones it renders
 * as a bottom sheet so primary actions stay within thumb reach.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  closeLabel = "Close",
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  closeLabel?: string;
}) {
  const width = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" }[size];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[rgb(8_20_22/0.45)] backdrop-blur-[2px]" />
        <D.Content
          className={cn(
            "fixed z-50 flex max-h-[92vh] w-full flex-col bg-surface text-ink shadow-pop animate-pop",
            "inset-x-0 bottom-0 rounded-t-2xl pb-[env(safe-area-inset-bottom,0px)]",
            "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
            width,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <D.Title className="font-display text-[18px] font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-[13px] text-ink-3">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === "string" ? title : ""}</D.Description>
              )}
            </div>
            <D.Close
              className="-mr-2 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
              aria-label={closeLabel}
            >
              <X size={18} />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
