import { Bookmark, BookmarkPlus, Pencil, Save, Trash2, Users, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { cn } from "../../lib/cn";
import type { ReportSettings, ReportTab, SavedView } from "./views";

/** "This month · by brand", "1 Oct 2026 – 5 Nov 2026 · by customer", "Payable · by bill date". */
function useDescribe() {
  const { t, dateMedium } = useI18n();
  return (report: ReportTab, s: ReportSettings) =>
    [
      s.period === "custom" && s.from && s.to ? `${dateMedium(s.from)} – ${dateMedium(s.to)}` : s.period ? t(`dashboard.range.${s.period}`) : null,
      s.groupBy ? t("reportViews.by", { group: t(`reports.groups.${s.groupBy as "day"}`) }) : null,
      report === "outstanding" ? t(s.party === "supplier" ? "reports.payable" : "reports.receivable") : null,
      report === "outstanding" ? t(s.basis === "invoice_date" ? "reports.byBillDate" : "reports.byDueDate") : null,
      s.movement ? t(`analytics.movements.${s.movement}`) : null,
    ]
      .filter(Boolean)
      .join(" · ");
}

/** The saved views: this person's own first, then those the team shared. */
export function ViewsMenu({ views, activeId, onOpen }: { views: SavedView[]; activeId: string | null; onOpen(view: SavedView): void }) {
  const { t } = useI18n();
  const describe = useDescribe();
  const [open, setOpen] = useState(false);
  const mine = views.filter((v) => v.mine);
  const team = views.filter((v) => !v.mine);
  const item = (v: SavedView) => (
    <button
      key={v.id}
      type="button"
      onClick={() => {
        setOpen(false);
        onOpen(v);
      }}
      className={cn("flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-surface-2", v.id === activeId && "bg-accent-soft/60")}
    >
      <span className="flex items-center gap-1.5 font-medium text-ink">
        {v.name}
        {v.mine && v.shared && <Users size={13} className="text-ink-3" aria-label={t("reportViews.shared")} />}
      </span>
      <span className="text-[12px] text-ink-3">
        {t(`reports.tabs.${v.report}`)} · {describe(v.report, v.settings)}
        {v.ownerName ? ` · ${t("reportViews.sharedBy", { name: v.ownerName })}` : ""}
      </span>
    </button>
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button icon={<Bookmark size={16} />}>{views.length ? t("reportViews.menuCount", { count: views.length }) : t("reportViews.menu")}</Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 text-[13.5px] shadow-pop" aria-label={t("reportViews.menu")}>
          {views.length === 0 && <p className="px-3 py-3 text-ink-3">{t("reportViews.none")}</p>}
          {mine.length > 0 && <p className="px-3 pt-2 pb-1 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">{t("reportViews.mine")}</p>}
          {mine.map(item)}
          {team.length > 0 && <p className="px-3 pt-3 pb-1 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">{t("reportViews.team")}</p>}
          {team.map(item)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The open view: its name, and what can be done with it. */
export function ActiveViewBar({
  view,
  changed,
  busy,
  onSaveChanges,
  onEdit,
  onDelete,
  onCopy,
  onClose,
}: {
  view: SavedView;
  changed: boolean;
  busy: boolean;
  onSaveChanges(): void;
  onEdit(): void;
  onDelete(): void;
  onCopy(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-accent/30 bg-accent-soft/50 px-4 py-2.5 text-[13.5px]" role="status">
      <Bookmark size={16} className="shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium text-ink">{t("reportViews.viewing", { name: view.name })}</span>
        <span className="text-ink-3">
          {view.ownerName ? ` · ${t("reportViews.sharedBy", { name: view.ownerName })}` : view.shared ? ` · ${t("reportViews.shared")}` : ""}
          {changed ? ` · ${t("reportViews.changed")}` : ""}
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        {view.mine ? (
          <>
            <Button size="sm" variant={changed ? "primary" : "soft"} icon={<Save size={15} />} disabled={!changed || busy} onClick={onSaveChanges}>
              {t("reportViews.saveChanges")}
            </Button>
            <Button size="sm" icon={<Pencil size={15} />} disabled={busy} onClick={onEdit}>
              {t("reportViews.edit")}
            </Button>
            <Button size="sm" icon={<Trash2 size={15} />} disabled={busy} onClick={onDelete}>
              {t("common.delete")}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="soft" icon={<BookmarkPlus size={15} />} disabled={busy} onClick={onCopy}>
            {t("reportViews.saveAsMine")}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<X size={15} />} onClick={onClose} aria-label={t("reportViews.close")}>
          <span className="sr-only sm:not-sr-only">{t("reportViews.close")}</span>
        </Button>
      </div>
    </div>
  );
}

export type ViewDialogMode = { kind: "save" | "copy"; name: string } | { kind: "edit"; view: SavedView } | { kind: "delete"; view: SavedView };

/** Save a view (or a copy of someone's), rename or share one, or confirm deleting it. */
export function ViewDialog({
  mode,
  onClose,
  onSave,
  onDelete,
}: {
  mode: ViewDialogMode | null;
  onClose(): void;
  onSave(input: { name: string; shared: boolean }): Promise<void>;
  onDelete(view: SavedView): Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!mode) return;
    setName(mode.kind === "edit" || mode.kind === "delete" ? mode.view.name : mode.name);
    setShared(mode.kind === "edit" ? mode.view.shared : false);
    setError(null);
    setBusy(false);
  }, [mode]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (mode?.kind === "delete") {
    return (
      <Dialog
        open
        onOpenChange={(v) => !v && onClose()}
        title={t("reportViews.deleteTitle", { name: mode.view.name })}
        description={mode.view.shared ? t("reportViews.deleteShared") : t("reportViews.deleteHint")}
        size="sm"
        closeLabel={t("common.close")}
        footer={
          <>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void run(() => onDelete(mode.view))}>
              {t("common.delete")}
            </Button>
          </>
        }
      >
        {error ? <ErrorNote error={error} /> : null}
      </Dialog>
    );
  }

  const title = mode?.kind === "edit" ? t("reportViews.editTitle") : mode?.kind === "copy" ? t("reportViews.saveAsMine") : t("reportViews.save");
  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(v) => !v && onClose()}
      title={title}
      description={t("reportViews.saveHint")}
      size="sm"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="report-view-form" disabled={busy || !name.trim()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <form
        id="report-view-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void run(() => onSave({ name: name.trim(), shared }));
        }}
      >
        <Field label={t("reportViews.name")} htmlFor="rv-name">
          <Input id="rv-name" value={name} maxLength={60} autoFocus placeholder={t("reportViews.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1">
          <Checkbox label={t("reportViews.share")} checked={shared} onChange={setShared} />
          <p className="pl-7 text-[12.5px] text-ink-3">{t("reportViews.shareHint")}</p>
        </div>
        {error ? <ErrorNote error={error} /> : null}
      </form>
    </Dialog>
  );
}
