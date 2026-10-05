import { useQuery } from "@tanstack/react-query";
import { DatabaseBackup } from "lucide-react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { allowed } from "../../data/db";
import { LIVE } from "../../data/source";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";

const WEEK_MS = 7 * 86_400_000;

/**
 * "Last backup: today 9:00 pm" for whoever looks after backups, louder when
 * there is none or the last one is more than a week old.
 */
export function BackupNote() {
  const { t, dateTime } = useI18n();
  const { navigate } = useRouter();
  const can = LIVE && allowed("backup.create");
  const q = useQuery({
    queryKey: ["backups"],
    queryFn: () => api.get<{ data: Array<{ kind: string; status: string; createdAt: string }> }>("/backups").then((r) => r.data),
    enabled: can,
  });
  if (!can || !q.data) return null;
  const last = q.data.find((b) => b.status === "completed" && b.kind !== "restore");
  const old = !last || Date.now() - Date.parse(last.createdAt) > WEEK_MS;
  const text = !last ? t("backupNote.none") : old ? t("backupNote.old", { when: dateTime(last.createdAt) }) : t("backupNote.last", { when: dateTime(last.createdAt) });
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl px-4 py-2.5 text-[13px]", old ? "bg-warn-soft text-warn" : "bg-surface-2 text-ink-2")} role={old ? "status" : undefined}>
      <DatabaseBackup size={16} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={() => navigate({ name: "planned", module: "backup" })} className="font-medium underline-offset-2 hover:underline">
        {t("backupNote.action")}
      </button>
    </div>
  );
}
