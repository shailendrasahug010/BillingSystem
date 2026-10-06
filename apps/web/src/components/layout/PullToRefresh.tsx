import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { requestPull } from "../../data/live";
import { LIVE } from "../../data/source";
import { syncNow, workingOffline } from "../../offline/sync";

/** How far (px) the finger pulls before letting go refreshes. */
const PULL = 72;

/**
 * Phones: pulling down at the top of a screen sends what waits on the device,
 * brings in what changed on the server and reloads the lists on screen (in
 * place of the browser's own pull, which would reload the whole page).
 */
export function PullToRefresh({ off }: { off?: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [distance, setDistance] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<{ y: number; x: number } | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    // Touch events come only from a touch screen: no check of the pointer needed.
    if (off) return;
    const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;
    const down = (e: TouchEvent) => {
      const target = e.target as Element | null;
      // Not inside a dialog, a menu or a list that scrolls on its own.
      start.current = e.touches.length === 1 && atTop() && !target?.closest("[role=dialog], [role=menu], [data-no-pull], input, textarea, select") ? { y: e.touches[0]!.clientY, x: e.touches[0]!.clientX } : null;
    };
    const move = (e: TouchEvent) => {
      if (!start.current) return;
      const dy = e.touches[0]!.clientY - start.current.y;
      const dx = Math.abs(e.touches[0]!.clientX - start.current.x);
      if (dy <= 0 || dx > dy || !atTop()) {
        latest.current = 0;
        setDistance(0);
        return;
      }
      latest.current = Math.min(dy * 0.5, PULL * 1.4);
      setDistance(latest.current);
    };
    const up = () => {
      const pulled = latest.current >= PULL;
      start.current = null;
      latest.current = 0;
      setDistance(0);
      if (!pulled) return;
      setBusy(true);
      if (LIVE && !workingOffline()) {
        requestPull();
        void syncNow().catch(() => undefined);
      }
      void qc.invalidateQueries().finally(() => setTimeout(() => setBusy(false), 400));
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", up);
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [off, qc]);

  if (!busy && distance < 8) return null;
  const ready = distance >= PULL;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top,0px)+12px)] z-40 flex justify-center" role="status" aria-live="polite" aria-label={busy ? t("phone.refreshing") : ready ? t("phone.releaseToRefresh") : t("phone.pullToRefresh")}>
      <span
        className="inline-flex size-10 items-center justify-center rounded-full border border-line bg-surface text-accent-ink shadow-pop transition-transform"
        style={{ transform: `translateY(${busy ? 24 : distance * 0.6}px)` }}
      >
        <RefreshCw size={18} className={busy ? "animate-spin" : ""} style={busy ? undefined : { transform: `rotate(${distance * 4}deg)`, opacity: Math.min(1, distance / PULL) }} />
      </span>
    </div>
  );
}
