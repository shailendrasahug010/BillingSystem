import { LOCALES } from "@vyapaar/i18n";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { ACCENTS, applyAccent, applyTheme, useAppearance } from "../../app/theme";
import { Card, CardHeader } from "../../components/ui/Card";
import { Segmented } from "../../components/ui/misc";
import { BUSINESS } from "../../data/db";
import { LIVE } from "../../data/source";
import { LiveSettings } from "./LiveSettings";
import { getSyncState, setOnline, useStoreVersion } from "../../data/store";
import { cn } from "../../lib/cn";

export function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  useStoreVersion();
  const { theme, accent } = useAppearance();
  const [stockPolicy, setStockPolicy] = useState<"allow" | "warn" | "block">("warn");
  const { online } = getSyncState();

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <h1 className="text-[28px] font-semibold tracking-tight text-ink">{t("settings.title")}</h1>

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
        <div className="flex flex-col gap-5 p-4 sm:p-5">
          <Segmented
            label={t("common.theme")}
            value={theme}
            onChange={(v) => applyTheme(v)}
            options={[
              { value: "system", label: t("common.systemTheme") },
              { value: "light", label: t("common.lightTheme") },
              { value: "dark", label: t("common.darkTheme") },
            ]}
          />
          <div className="flex flex-col gap-2.5">
            <div>
              <p className="text-[13.5px] font-medium text-ink">{t("settings.accent")}</p>
              <p className="text-[12.5px] text-ink-3">{t("settings.accentHint")}</p>
            </div>
            <div role="radiogroup" aria-label={t("settings.accent")} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {ACCENTS.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  role="radio"
                  aria-checked={accent === a.key}
                  onClick={() => applyAccent(a.key)}
                  className={cn(
                    "press flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-[13px] font-medium transition-colors",
                    accent === a.key ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:border-line-strong",
                  )}
                >
                  <span className="size-6 shrink-0 rounded-full shadow-card" style={{ backgroundImage: `linear-gradient(135deg, ${a.swatch}, ${a.swatch2})` }} aria-hidden />
                  {t(`settings.accents.${a.key}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {LIVE ? (
        <LiveSettings />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
