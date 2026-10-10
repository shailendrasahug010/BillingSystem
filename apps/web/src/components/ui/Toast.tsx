import { CircleCheckBig, CloudOff, Info, TriangleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { cn } from "../../lib/cn";

type ToastTone = "success" | "info" | "offline" | "danger";
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  action?: { label: string; onClick(): void };
  /** A newer message of the same group takes the older one's place (one Undo at a time, not a pile). */
  group?: string;
  /** How long it stays, in ms, where the usual time does not suit (a "press again" hint). */
  life?: number;
}

const ToastContext = createContext<(t: Omit<ToastItem, "id">) => void>(() => undefined);

/**
 * How long a message stays: a problem longer (it may need reading twice), one with a button
 * (Undo, Details) long enough to reach it, the rest a few seconds. While the pointer rests on
 * it or a key has moved into it, it waits, but never more than PAUSE_LIMIT in all, so a
 * forgotten mouse cannot keep it over the screen.
 */
const lifeOf = (t: ToastItem) => t.life ?? (t.tone === "danger" ? 10_000 : t.action ? 8_000 : 5_200);
const PAUSE_LIMIT = 10_000;

function ToastCard({ toast, onClose }: { toast: ToastItem; onClose(): void }) {
  const { t } = useI18n();
  const [paused, setPaused] = useState(false);
  const left = useRef(lifeOf(toast));
  const pausedFor = useRef(0);
  useEffect(() => {
    const started = Date.now();
    if (paused) {
      // The pause runs out on its own as well.
      const timer = window.setTimeout(onClose, left.current + Math.max(0, PAUSE_LIMIT - pausedFor.current));
      return () => {
        pausedFor.current += Date.now() - started;
        window.clearTimeout(timer);
      };
    }
    const timer = window.setTimeout(onClose, left.current);
    return () => {
      left.current = Math.max(0, left.current - (Date.now() - started));
      window.clearTimeout(timer);
    };
  }, [paused, onClose]);
  const Icon = toast.tone === "success" ? CircleCheckBig : toast.tone === "offline" ? CloudOff : toast.tone === "danger" ? TriangleAlert : Info;
  return (
    <div
      className="glass pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-line/70 py-3 pr-1.5 pl-3.5 shadow-pop animate-sheet"
      // A problem is announced at once; the rest when the screen reader is free.
      role={toast.tone === "danger" ? "alert" : "status"}
      onPointerEnter={(e) => e.pointerType === "mouse" && setPaused(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setPaused(false)}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          toast.tone === "success" ? "bg-good-soft text-good" : toast.tone === "offline" ? "bg-warn-soft text-warn" : toast.tone === "danger" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent",
        )}
      >
        <Icon size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-ink">{toast.title}</p>
        {toast.body && <p className="text-[13px] text-ink-3">{toast.body}</p>}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action!.onClick();
            onClose();
          }}
          className="touch-40 shrink-0 self-center rounded-lg px-1.5 py-1 text-[13px] font-semibold text-accent hover:underline"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        title={t("common.close")}
        className="touch-40 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
      >
        <X size={15} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...(t.group ? xs.filter((x) => x.group !== t.group) : xs), { ...t, id }]);
  }, []);
  const close = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="toast-stack pointer-events-none fixed inset-x-0 bottom-[calc(92px+var(--inset-bottom))] z-[60] short:bottom-4 flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:px-6"
      >
        {items.map((t) => (
          <ToastCard key={t.id} toast={t} onClose={() => close(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
