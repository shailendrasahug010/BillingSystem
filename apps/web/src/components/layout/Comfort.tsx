import { CATALOGS, type TranslationKey } from "@digitalbahi/i18n";
import { CircleHelp, Type } from "lucide-react";
import { useState } from "react";
import { applyTextSize, setSimpleMenu, TEXT_SIZES, useSimpleMenu, useTextSize } from "../../app/comfort";
import { useI18n } from "../../app/i18n";
import { moduleForRoute } from "../../app/modules";
import { useRouter } from "../../app/router";
import { Dialog } from "../ui/Dialog";
import { Checkbox } from "../ui/Field";
import { Segmented } from "../ui/misc";

const ROUND = "press inline-flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink";

/** Text size and the simple menu, for whoever is using this device. */
export function ComfortControls({ userId }: { userId: string | null | undefined }) {
  const { t } = useI18n();
  const size = useTextSize();
  const simple = useSimpleMenu(userId);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div>
          <p className="text-[13.5px] font-medium text-ink">{t("comfort.textSize")}</p>
          <p className="text-[12.5px] text-ink-3">{t("comfort.textSizeHint")}</p>
        </div>
        <Segmented label={t("comfort.textSize")} value={size} onChange={applyTextSize} options={TEXT_SIZES.map((s) => ({ value: s.key, label: s.label }))} />
      </div>
      <div className="flex flex-col gap-1">
        <Checkbox label={<span className="font-medium text-ink">{t("comfort.simpleMenu")}</span>} checked={simple} onChange={(on) => setSimpleMenu(userId, on)} />
        <p className="pl-6 text-[12.5px] text-ink-3">{t("comfort.simpleMenuHint")}</p>
      </div>
    </div>
  );
}

/** The "Aa" button in the top bar. */
export function ComfortButton({ userId }: { userId: string | null | undefined }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={ROUND} aria-label={t("comfort.open")} title={t("comfort.open")} onClick={() => setOpen(true)}>
        <Type size={18} />
      </button>
      <Dialog open={open} onOpenChange={setOpen} title={t("comfort.title")} size="sm" closeLabel={t("common.close")}>
        <ComfortControls userId={userId} />
      </Dialog>
    </>
  );
}

/** Help topics written for these menu entries (help.<key>.s1…s4). */
const helpSteps = (key: string): TranslationKey[] => {
  const topic = (CATALOGS.en.help as Record<string, unknown>)[key];
  if (!topic || typeof topic !== "object") return [];
  return Object.keys(topic).map((s) => `help.${key}.${s}` as TranslationKey);
};

/** The "?" button in the top bar: a few steps for the screen open now, in the app's language. */
export function HelpButton({ onOpenShortcuts }: { onOpenShortcuts(): void }) {
  const { t } = useI18n();
  const { route } = useRouter();
  const [open, setOpen] = useState(false);
  const mod = moduleForRoute(route);
  const own = mod ? helpSteps(mod.key) : [];
  const steps = own.length ? own : helpSteps("general");
  return (
    <>
      <button type="button" className={ROUND} aria-label={t("comfort.help")} title={t("comfort.help")} onClick={() => setOpen(true)}>
        <CircleHelp size={18} />
      </button>
      <Dialog open={open} onOpenChange={setOpen} title={own.length && mod ? t("help.title", { screen: t(mod.label) }) : t("help.generalTitle")} closeLabel={t("common.close")}>
        <ol className="flex flex-col gap-3">
          {steps.map((key, i) => (
            <li key={key} className="flex gap-3 text-[14px] leading-relaxed text-ink">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12.5px] font-semibold text-accent-ink">{i + 1}</span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="mt-5 text-[13px] font-medium text-accent-ink hover:underline"
          onClick={() => {
            setOpen(false);
            onOpenShortcuts();
          }}
        >
          {t("help.shortcuts")}
        </button>
      </Dialog>
    </>
  );
}
