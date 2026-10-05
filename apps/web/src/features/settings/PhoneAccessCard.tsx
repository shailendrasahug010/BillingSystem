import { Copy, Smartphone } from "lucide-react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { QrCode } from "../../components/ui/QrCode";
import { useToast } from "../../components/ui/Toast";
import { useAppLink } from "../../lib/appLink";

/**
 * "Open on phone": a QR code of the address phones open Digital Bahi at, so
 * nobody types an address. At localhost it is the computer's Wi-Fi address
 * when Digital Bahi was started for phones too; on a server, the server's.
 */
export function PhoneAccessCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { link, local, loading } = useAppLink();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link!);
      toast({ tone: "success", title: t("phone.copied"), body: link! });
    } catch {
      // No clipboard (an http address on some browsers): the link is on screen to type.
    }
  };
  return (
    <Card>
      <CardHeader title={t("phone.title")} subtitle={t("phone.hint")} />
      <div className="p-4 sm:p-5">
        {loading ? null : link ? (
          <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
            <div className="shrink-0 rounded-xl border border-line bg-white p-2">
              <QrCode text={link} size={176} label={t("phone.title")} />
            </div>
            <div className="flex min-w-0 flex-col gap-2.5 text-[13.5px] text-ink-2">
              <p className="flex items-center gap-2 font-mono text-[15px] font-semibold break-all text-ink">
                <Smartphone size={16} className="shrink-0 text-accent" aria-hidden />
                {link}
              </p>
              {local && <p>{t("phone.sameWifi")}</p>}
              {local && <p>{t("phone.signIn")}</p>}
              {link.startsWith("http://") && <p className="text-[12.5px] text-ink-3">{t("phone.httpNote")}</p>}
              <div>
                <Button size="sm" icon={<Copy size={14} />} onClick={() => void copy()}>
                  {t("phone.copy")}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("phone.notOpen")}</p>
        )}
      </div>
    </Card>
  );
}
