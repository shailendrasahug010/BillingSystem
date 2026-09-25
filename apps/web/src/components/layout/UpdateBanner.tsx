import { useI18n } from "../../app/i18n";
import { cn } from "../../lib/cn";
import { applyUpdate, useUpdateReady } from "../../lib/pwa";

/** "A new version is ready · Reload now", shown only when an update is waiting. */
export function UpdateBanner({ className }: { className?: string }) {
  const { t } = useI18n();
  const ready = useUpdateReady();
  if (!ready) return null;
  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-info-soft px-4 py-1.5 text-[13px] text-ink", className)} role="status">
      <span>{t("app.updateReady")}</span>
      <button type="button" onClick={applyUpdate} className="rounded-md px-2 py-0.5 font-semibold text-accent underline-offset-2 hover:underline">
        {t("app.reload")}
      </button>
    </div>
  );
}
