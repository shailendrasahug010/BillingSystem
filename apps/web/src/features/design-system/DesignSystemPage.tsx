import { ORDER_STATUSES } from "@digitalbahi/core";
import { Plus, Printer, Save, Search, Trash } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { GLOBAL_SHORTCUTS, INVOICE_SHORTCUTS } from "../../app/shortcuts";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Field";
import { EmptyState, ErrorState, Kbd, ProgressBar, Segmented, Skeleton } from "../../components/ui/misc";
import { ORDER_STATUS_TONE, PAYMENT_STATUS_TONE } from "../../lib/status";
import { BUSINESS, NEXT_INVOICE_NUMBER } from "../../data/db";

// A GSTIN with a deliberately wrong check character, to show the validation state.
const TYPO_GSTIN = BUSINESS.gstin.slice(0, 14) + (BUSINESS.gstin.endsWith("A") ? "B" : "A");

const SWATCHES: Array<[string, string]> = [
  ["--bg", "Page"],
  ["--surface", "Surface"],
  ["--surface-2", "Surface 2"],
  ["--border", "Border"],
  ["--ink", "Ink"],
  ["--ink-2", "Ink 2"],
  ["--ink-3", "Ink 3"],
  ["--accent", "Accent · peacock"],
  ["--accent-soft", "Accent soft"],
  ["--marigold", "Marigold (brand mark only)"],
  ["--good", "Good · paid"],
  ["--warn", "Warn · due / low"],
  ["--danger", "Danger · overdue / out"],
  ["--series-1", "Chart series 1"],
  ["--series-2", "Chart series 2"],
  ["--series-3", "Chart series 3"],
];

export function DesignSystemPage() {
  const { t, money } = useI18n();
  const [seg, setSeg] = useState("a");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[26px] font-semibold text-ink">{t("designSystem.title")}</h1>
        <p className="text-[14px] text-ink-3">{t("designSystem.subtitle")} · docs/05-design-system.md</p>
      </div>

      <Card>
        <CardHeader title={t("designSystem.colors")} subtitle="Tokens on :root; dark values for prefers-color-scheme and data-theme" />
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:p-5 lg:grid-cols-8">
          {SWATCHES.map(([token, name]) => (
            <div key={token} className="flex flex-col gap-1.5">
              <span className="h-14 rounded-lg border border-line" style={{ background: `var(${token})` }} />
              <span className="text-[12px] font-medium text-ink">{name}</span>
              <span className="font-mono text-[11px] text-ink-3">{token}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title={t("designSystem.typography")} subtitle="Anek (display) · IBM Plex Sans + Plex Sans Devanagari (UI) · IBM Plex Mono (GSTIN, HSN, numbers)" />
        <div className="flex flex-col gap-3 p-4 sm:p-5">
          <p className="font-display text-[30px] leading-tight font-semibold text-ink">Display 30 · आज की बिक्री ₹1,24,560</p>
          <p className="font-display text-[24px] font-semibold text-ink">H1 24 · नया इनवॉइस</p>
          <p className="font-display text-[18px] font-semibold text-ink">H2 18 · Smart suggestions · स्मार्ट सुझाव</p>
          <p className="text-[14px] text-ink">Body 14 · Usually every 7 days · last bought 6 days ago. आमतौर पर हर 7 दिन में · पिछली बार 6 दिन पहले</p>
          <p className="text-[12.5px] text-ink-3">Caption 12.5 · Secondary information and hints</p>
          <p className="font-mono text-[13px] text-ink-2">Mono 13 · {BUSINESS.gstin} · {NEXT_INVOICE_NUMBER} · HSN 1905</p>
          <p className="num text-[14px] text-ink">Tabular figures · {money(123456.5)} · {money(98.75)}</p>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("designSystem.buttons")} subtitle="sm 32 · md 40 · lg 48 (mobile primary)" />
          <div className="flex flex-col gap-3 p-4 sm:p-5">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={<Save size={16} />}>
                {t("invoice.save")}
              </Button>
              <Button icon={<Printer size={16} />}>{t("common.print")}</Button>
              <Button variant="soft" icon={<Plus size={16} />}>
                {t("suggestions.add")}
              </Button>
              <Button variant="ghost">{t("common.cancel")}</Button>
              <Button variant="danger" icon={<Trash size={16} />}>
                {t("common.delete")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg" variant="primary">
                Large
              </Button>
              <Button disabled>Disabled</Button>
            </div>
            <Segmented label="Segmented" value={seg} onChange={setSeg} options={[{ value: "a", label: t("dashboard.charts.daily") }, { value: "b", label: t("dashboard.charts.weekly") }, { value: "c", label: t("dashboard.charts.monthly") }]} />
          </div>
        </Card>

        <Card>
          <CardHeader title={t("designSystem.inputs")} />
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-5">
            <Field label={t("customer.name")} htmlFor="ds-name">
              <Input id="ds-name" placeholder="ABC General Store" />
            </Field>
            <Field label={t("common.search")} htmlFor="ds-search">
              <Input id="ds-search" leading={<Search size={16} />} placeholder={t("product.search")} />
            </Field>
            <Field label={t("customer.gstin")} htmlFor="ds-gstin" error={t("validation.invalid_checksum")}>
              <Input id="ds-gstin" className="[&_input]:font-mono" defaultValue={TYPO_GSTIN} invalid />
            </Field>
            <Field label={t("invoice.paymentMode")} htmlFor="ds-mode">
              <Select id="ds-mode" defaultValue="upi">
                <option value="upi">{t("paymentMethod.upi")}</option>
                <option value="cash">{t("paymentMethod.cash")}</option>
              </Select>
            </Field>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title={t("designSystem.badges")} subtitle="State is always text + colour (+ icon), never colour alone" />
        <div className="flex flex-col gap-3 p-4 sm:p-5">
          <div className="flex flex-wrap gap-2">
            {ORDER_STATUSES.map((s) => (
              <Badge key={s} tone={ORDER_STATUS_TONE[s]} dot>
                {t(`status.order.${s}`)}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(PAYMENT_STATUS_TONE) as Array<keyof typeof PAYMENT_STATUS_TONE>).map((s) => (
              <Badge key={s} tone={PAYMENT_STATUS_TONE[s]} dot>
                {t(`status.payment.${s}`)}
              </Badge>
            ))}
            <Badge tone="danger">{t("status.stock.out_of_stock")}</Badge>
            <Badge tone="warn">{t("status.stock.low")}</Badge>
            <Badge tone="warn">{t("status.expiry.expiring_soon")}</Badge>
          </div>
          <div className="grid max-w-md gap-2">
            <ProgressBar value={0.45} label="Credit used 45%" />
            <ProgressBar value={0.86} tone="warn" label="Credit used 86%" />
            <ProgressBar value={1} tone="danger" label="Credit used 100%" />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("designSystem.states")} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:p-5 lg:grid-cols-3">
          <div className="rounded-xl border border-dashed border-line-strong">
            <EmptyState title={t("empty.customers")} hint={t("invoice.noItemsHint")} action={<Button size="sm">{t("common.reset")}</Button>} />
          </div>
          <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
            <Skeleton className="w-2/3" />
            <Skeleton className="h-8 w-1/2" />
            <Skeleton />
            <Skeleton className="w-5/6" />
          </div>
          <ErrorState title={t("empty.error")} hint={t("empty.errorHint")} retryLabel={t("common.retry")} onRetry={() => undefined} />
        </div>
      </Card>

      <Card>
        <CardHeader title={t("shortcuts.title")} subtitle="Ctrl+P and Ctrl+C stay with the browser (print / copy)" />
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 p-4 text-[13.5px] sm:grid-cols-2 sm:p-5">
          {(
            [
              [GLOBAL_SHORTCUTS.search, t("shortcuts.search")],
              [GLOBAL_SHORTCUTS.newInvoice, t("shortcuts.newInvoice")],
              [GLOBAL_SHORTCUTS.newOrder, t("shortcuts.newOrder")],
              [GLOBAL_SHORTCUTS.purchase, t("shortcuts.purchase")],
              [GLOBAL_SHORTCUTS.collection, t("shortcuts.collection")],
              [INVOICE_SHORTCUTS.focusCustomer, t("shortcuts.focusCustomer")],
              [INVOICE_SHORTCUTS.focusProduct, t("shortcuts.focusProduct")],
              ["alt+1", t("shortcuts.addSuggestion")],
              [INVOICE_SHORTCUTS.save, t("shortcuts.saveInvoice")],
              ["escape", t("shortcuts.closeDialog")],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="flex items-center justify-between gap-3 border-b border-line py-1.5">
              <dt className="text-ink-2">{label}</dt>
              <dd>
                <Kbd keys={k} />
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
