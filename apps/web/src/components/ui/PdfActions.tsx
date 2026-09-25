import { FileDown, MessageCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { api } from "../../lib/api";
import { downloadBlob } from "../../lib/download";
import { canShareFiles, pdfFileName, shareFile, shareOnWhatsApp } from "../../lib/share";
import { Button, type ButtonSize } from "./Button";
import { useToast } from "./Toast";

/**
 * Download PDF and WhatsApp for an invoice, note or receipt. The PDF is made
 * on the server (letterhead, GST table, Hindi or English). On a phone the
 * WhatsApp button shares the PDF file itself with the message; on a computer
 * it opens WhatsApp with the message (attach the downloaded PDF there).
 */
export function PdfActions({ path, locale, number, shareText, mobile, size = "md", primaryShare = false }: { path: string; locale: string; number: string; shareText: string; mobile?: string | null; size?: ButtonSize; primaryShare?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<"download" | "share" | null>(null);
  const cached = useRef<{ key: string; blob: Blob } | null>(null);
  const filename = pdfFileName(number);
  const iconSize = size === "sm" ? 14 : 16;

  const load = async () => {
    const key = `${path}?${locale}`;
    if (cached.current?.key === key) return cached.current.blob;
    const blob = await api.blob(path, { locale });
    cached.current = { key, blob };
    return blob;
  };

  const download = async () => {
    setBusy("download");
    try {
      downloadBlob(filename, await load());
      toast({ tone: "success", title: t("share.pdfReady", { name: filename }) });
    } catch {
      toast({ tone: "danger", title: t("share.pdfFailed") });
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    if (!canShareFiles()) {
      shareOnWhatsApp(shareText, mobile);
      return;
    }
    setBusy("share");
    try {
      await shareFile(await load(), filename, shareText);
    } catch (e) {
      // The browser may want a fresh tap once the file is ready.
      if ((e as Error).name === "NotAllowedError") toast({ tone: "info", title: t("share.tapAgain") });
      else toast({ tone: "danger", title: t("share.pdfFailed") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button size={size} icon={<FileDown size={iconSize} />} disabled={busy !== null} onClick={() => void download()}>
        {t("share.downloadPdf")}
      </Button>
      <Button size={size} variant={primaryShare ? "primary" : "secondary"} icon={<MessageCircle size={iconSize} />} disabled={busy !== null} onClick={() => void share()}>
        {t("common.whatsapp")}
      </Button>
    </>
  );
}
