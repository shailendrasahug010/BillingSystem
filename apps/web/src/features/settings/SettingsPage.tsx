import { LOCALES } from "@vyapaar/i18n";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { applyTheme, readTheme, type ThemeChoice } from "../../app/theme";
import { Card, CardHeader } from "../../components/ui/Card";
import { Segmented } from "../../components/ui/misc";
import { BUSINESS } from "../../data/db";
import { getSyncState, setOnline, useStoreVersion } from "../../data/store";
import { cn } from "../../lib/cn";

export function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  useStoreVersion();
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [stockPolicy, setStockPolicy] = useState<"allow" | "warn" | "block">("warn");
  const { online } = getSyncState();

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <h1 className="text-[26px] font-semibold text-ink">{t("settings.title")}</h1>

      <Card>
        <CardHeader title={t("settings.language")} subtitle={t("settings.languageHint")} />
        <div className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2 sm:p-5">
          {LOCALES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => setLocale(l.code)}
              aria-pressed={locale === l.code}
              className={cn("flex items-center justify-between rounded-xl border px-4 py-3 text-left", locale === l.code ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}
            >
              <span>
                <span className="block text-[16px] font-semibold text-ink">{l.nativeName}</span>
                <span className="text-[12.5px] text-ink-3">{l.englishName}</span>
              </span>
              <span className="font-mono text-[12px] text-ink-3">{l.intl}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title={t("settings.appearance")} />
        <div className="p-4 sm:p-5">
          <Segmented
            label={t("common.theme")}
            value={theme}
            onChange={(v) => {
              applyTheme(v);
              setTheme(v);
            }}
            options={[
              { value: "system", label: t("common.systemTheme") },
              { value: "light", label: t("common.lightTheme") },
              { value: "dark", label: t("common.darkTheme") },
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title={t("settings.stockPolicy")} subtitle="stock.negative_policy" />
        <div className="p-4 sm:p-5">
          <Segmented
            label={t("settings.stockPolicy")}
            value={stockPolicy}
            onChange={setStockPolicy}
            options={[
              { value: "allow", label: t("settings.stockPolicyOptions.allow") },
              { value: "warn", label: t("settings.stockPolicyOptions.warn") },
              { value: "block", label: t("settings.stockPolicyOptions.block") },
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title={t("sync.online") + " / " + t("sync.offline")} subtitle="Simulate losing the connection: new invoices are saved on the device and queued for sync." />
        <div className="p-4 sm:p-5">
          <Segmented
            label="Connection"
            value={online ? "online" : "offline"}
            onChange={(v) => setOnline(v === "online")}
            options={[
              { value: "online", label: t("sync.online") },
              { value: "offline", label: t("sync.offline") },
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title={t("settings.business")} />
        <dl className="grid grid-cols-1 gap-3 p-4 text-[13.5px] sm:grid-cols-2 sm:p-5">
          <div>
            <dt className="text-ink-3">{t("common.name")}</dt>
            <dd className="text-ink">{BUSINESS.legalName}</dd>
          </div>
          <div>
            <dt className="text-ink-3">GSTIN</dt>
            <dd className="font-mono text-ink">{BUSINESS.gstin}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-ink-3">{t("customer.address")}</dt>
            <dd className="text-ink">
              {BUSINESS.address}, {BUSINESS.city}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
