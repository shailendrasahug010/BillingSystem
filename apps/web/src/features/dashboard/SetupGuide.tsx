import { Check, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter, type Route } from "../../app/router";
import { Card, CardHeader } from "../../components/ui/Card";
import { BUSINESS, WORKSPACE } from "../../data/db";
import { onPrinterChange, printerSettings } from "../../lib/thermal/printer";
import type { HomeData } from "./RoleHome";

type StepKey = "business" | "gst" | "payment" | "product" | "customer" | "printer" | "bill";

const hiddenKey = () => `digitalbahi.setupHidden.${WORKSPACE.businessId ?? ""}`;

function readHidden(): boolean {
  try {
    return localStorage.getItem(hiddenKey()) === "1";
  } catch {
    return false;
  }
}

/** Opens a screen and, for a settings card, scrolls to it once it is on the page. */
function useOpen() {
  const { navigate } = useRouter();
  return (route: Route, anchor?: string) => {
    navigate(route);
    if (!anchor) return;
    const until = Date.now() + 4000;
    const look = () => {
      const el = document.getElementById(anchor);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
      } else if (Date.now() < until) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  };
}

/**
 * The first-time checklist on the dashboard for whoever sets the business up:
 * firm details, GST, bank and UPI, the first product and customer, the
 * receipt printer and the first bill. Each step opens the screen that does it;
 * the card goes away once all are done, or when it is closed.
 */
export function SetupGuide({ setup }: { setup: HomeData["setup"] }) {
  const { t } = useI18n();
  const open = useOpen();
  const [hidden, setHidden] = useState(readHidden);
  const [printer, setPrinter] = useState(() => Boolean(printerSettings().printer));
  useEffect(() => onPrinterChange(() => setPrinter(Boolean(printerSettings().printer))), []);

  if (!setup || hidden) return null;
  const settings: Route = { name: "settings" };
  const steps: Array<{ key: StepKey; done: boolean; route: Route; anchor?: string }> = [
    { key: "business", done: Boolean(BUSINESS.address?.trim() && BUSINESS.phone?.trim()), route: settings, anchor: "settings-business" },
    { key: "gst", done: Boolean(BUSINESS.gstin) || !WORKSPACE.chargeTax, route: settings, anchor: "settings-business" },
    { key: "payment", done: Boolean(BUSINESS.bank.upi?.trim() || BUSINESS.bank.account?.trim()), route: settings, anchor: "settings-payment" },
    { key: "product", done: setup.products, route: { name: "products" } },
    { key: "customer", done: setup.customers, route: { name: "customers" } },
    { key: "printer", done: printer, route: settings, anchor: "settings-printer" },
    { key: "bill", done: setup.invoices, route: { name: "invoice-new" } },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const hide = () => {
    try {
      localStorage.setItem(hiddenKey(), "1");
    } catch {
      // Storage blocked: hidden until the page reloads.
    }
    setHidden(true);
  };

  return (
    <Card aria-labelledby="setup-title" data-setup-guide>
      <CardHeader
        title={<span id="setup-title">{t("setup.title")}</span>}
        subtitle={t("setup.progress", { done, total: steps.length })}
        action={
          <button type="button" onClick={hide} className="press rounded-lg p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={t("setup.hide")} title={t("setup.hide")}>
            <X size={18} />
          </button>
        }
      />
      <div className="px-4 pt-3 sm:px-5">
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label={t("setup.title")}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
      </div>
      <ol className="grid grid-cols-1 gap-1 p-2 sm:grid-cols-2 sm:p-3">
        {steps.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              data-step={s.key}
              data-done={s.done ? "true" : "false"}
              onClick={() => open(s.route, s.anchor)}
              className="press flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-surface-2"
            >
              <span
                className={
                  s.done
                    ? "flex size-7 shrink-0 items-center justify-center rounded-full bg-good-soft text-good"
                    : "flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-line-strong text-ink-3"
                }
                aria-hidden
              >
                {s.done && <Check size={15} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={s.done ? "block text-[14px] font-medium text-ink-3 line-through" : "block text-[14px] font-medium text-ink"}>{t(`setup.steps.${s.key}.title`)}</span>
                {!s.done && <span className="block text-[12.5px] text-ink-3">{t(`setup.steps.${s.key}.hint`)}</span>}
              </span>
              {!s.done && <ChevronRight size={16} className="shrink-0 text-ink-3" aria-hidden />}
              <span className="sr-only">{s.done ? t("setup.done") : t("setup.todo")}</span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  );
}
