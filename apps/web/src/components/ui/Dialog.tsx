import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useRef, type PointerEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * A bottom sheet pulled down by its top (the handle and the title) with a finger closes, as
 * a phone's own sheets do; let go before it is far enough, it springs back. Touch only, and
 * only while the dialog is a bottom sheet (phones); its scrolling middle is left alone.
 */
function useSwipeToClose(onClose: () => void) {
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; y: number; at: number; dy: number; moving: boolean } | null>(null);
  const place = (dy: number, spring: boolean) => {
    const el = content.current;
    if (!el) return;
    el.style.transition = spring ? "transform 200ms var(--ease-out)" : "none";
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
  };
  const end = (e: PointerEvent<HTMLElement>, released: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moving) return;
    // Far enough, or flicked down: closed. Otherwise back up.
    const speed = d.dy / Math.max(1, e.timeStamp - d.at);
    if (released && (d.dy > 96 || speed > 0.6)) onClose();
    else place(0, true);
  };
  return {
    content,
    grip: {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (e.pointerType !== "touch" || !window.matchMedia("(max-width: 639.98px)").matches) return;
        drag.current = { id: e.pointerId, y: e.clientY, at: e.timeStamp, dy: 0, moving: false };
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dy = Math.max(0, e.clientY - d.y);
        if (!d.moving) {
          // A tap (the close button) stays a tap until the finger has really moved.
          if (dy < 8) return;
          d.moving = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        d.dy = dy;
        place(dy, false);
      },
      onPointerUp: (e: PointerEvent<HTMLElement>) => end(e, true),
      onPointerCancel: (e: PointerEvent<HTMLElement>) => end(e, false),
    },
  };
}

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
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  closeLabel?: string;
  /** Where focus goes once it closes (prevent the event to move it yourself). */
  onCloseAutoFocus?(event: Event): void;
}) {
  const width = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" }[size];
  const swipe = useSwipeToClose(() => onOpenChange(false));
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[rgb(6_12_28/0.5)] backdrop-blur-sm animate-pop" />
        <D.Content
          ref={swipe.content}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            "fixed z-50 flex max-h-app-sheet w-full flex-col border border-line/70 bg-surface text-ink shadow-pop animate-sheet",
            "inset-x-0 bottom-0 rounded-t-[28px] pb-[var(--inset-bottom)]",
            "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl",
            width,
          )}
        >
          {/* The grab handle of a bottom sheet (phones), and the title row: pulled down together, the sheet closes. */}
          <div className="flex shrink-0 flex-col max-sm:touch-none" {...swipe.grip}>
            <span className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-surface-3 sm:hidden" aria-hidden />
            <div className="flex items-start justify-between gap-4 border-b border-line/70 px-5 pt-3 pb-4 sm:pt-4">
              <div className="min-w-0">
                <D.Title className="font-display text-[18px] font-semibold">{title}</D.Title>
                {description ? (
                  <D.Description className="mt-0.5 text-[13px] text-ink-3">{description}</D.Description>
                ) : (
                  <D.Description className="sr-only">{typeof title === "string" ? title : ""}</D.Description>
                )}
              </div>
              <D.Close
                className="press touch-40 -mr-2 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3 hover:bg-surface-3 hover:text-ink"
                aria-label={closeLabel}
              >
                <X size={18} />
              </D.Close>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line/70 bg-surface-2/40 px-5 py-3 sm:rounded-b-3xl">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
