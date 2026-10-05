import { useI18n } from "../../app/i18n";
import { Card, CardHeader } from "../../components/ui/Card";
import { PrinterPanel } from "../../components/thermal/ThermalPrint";

/** The Bluetooth receipt printer of this device (kept on the device, not the server). */
export function PrinterCard() {
  const { t } = useI18n();
  return (
    <Card id="settings-printer" className="scroll-mt-20">
      <CardHeader title={t("thermal.title")} subtitle={t("thermal.hint")} />
      <div className="p-4 sm:p-5">
        <PrinterPanel />
      </div>
    </Card>
  );
}
