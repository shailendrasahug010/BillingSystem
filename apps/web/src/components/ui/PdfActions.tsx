import { FileDown, Printer } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { api } from "../../lib/api";
import { downloadBlob, printBlob } from "../../lib/download";
import { pdfFileName } from "../../lib/share";
import { whatsAppWithPdf } from "../../lib/sendPdf";
import { Button, type ButtonSize } from "./Button";
import { useToast } from "./Toast";
import { WhatsAppIcon } from "../brand/WhatsAppIcon";

/**
 * Download PDF and WhatsApp for an invoice, note or receipt. The PDF is made
 * on the server (letterhead, GST table, Hindi or English). WhatsApp sends the
 * PDF file itself with the message where the device can share files (phones,
 * the Android app, Chrome and Edge on a computer); elsewhere it opens WhatsApp
 * with the message and downloads the PDF to attach there.
 */
export function PdfActions({
  path,
  locale,
  number,
  shareText,
  mobile,
  size = "md",
  primaryShare = false,
  print = false,
}: {
  path: string;
  locale: string;
  number: string;
  shareText: string;
  mobile?: string | null;
  size?: ButtonSize;
  primaryShare?: boolean;
  /** Also a Print button, which prints the same PDF (for papers without a print layout of their own). */
  print?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<"download" | "share" | "print" | null>(null);
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

  const printPdf = async () => {
    setBusy("print");
    try {
      printBlob(filename, await load());
    } catch {
      toast({ tone: "danger", title: t("share.pdfFailed") });
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    setBusy("share");
    try {
      if ((await whatsAppWithPdf(load, filename, shareText, mobile)) === "downloaded") toast({ tone: "info", title: t("share.attachPdf", { name: filename }) });
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
      {print && (
        <Button size={size} icon={<Printer size={iconSize} />} disabled={busy !== null} onClick={() => void printPdf()}>
          {t("common.print")}
        </Button>
      )}
      <Button size={size} icon={<FileDown size={iconSize} />} disabled={busy !== null} onClick={() => void download()}>
        {t("share.downloadPdf")}
      </Button>
      <Button size={size} variant={primaryShare ? "primary" : "secondary"} icon={<WhatsAppIcon size={iconSize} mono={primaryShare} />} disabled={busy !== null} onClick={() => void share()}>
        {t("common.whatsapp")}
      </Button>
    </>
  );
}
