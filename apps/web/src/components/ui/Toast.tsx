import { CircleCheckBig, CloudOff, Info, TriangleAlert } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type ToastTone = "success" | "info" | "offline" | "danger";
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  action?: { label: string; onClick(): void };
}

const ToastContext = createContext<(t: Omit<ToastItem, "id">) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 5200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom,0px))] z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:px-6"
      >
        {items.map((t) => {
          const Icon = t.tone === "success" ? CircleCheckBig : t.tone === "offline" ? CloudOff : t.tone === "danger" ? TriangleAlert : Info;
          return (
            <div
              key={t.id}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-pop animate-pop"
              role="status"
            >
              <Icon size={18} className={cn("mt-0.5 shrink-0", t.tone === "success" ? "text-good" : t.tone === "offline" ? "text-warn" : t.tone === "danger" ? "text-danger" : "text-accent")} />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-ink">{t.title}</p>
                {t.body && <p className="text-[13px] text-ink-3">{t.body}</p>}
              </div>
              {t.action && (
                <button type="button" onClick={t.action.onClick} className="shrink-0 text-[13px] font-semibold text-accent hover:underline">
                  {t.action.label}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
