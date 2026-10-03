import { downloadBlob } from "./download";
import { canShareFiles, shareFile, shareOnWhatsApp } from "./share";

/**
 * A document on WhatsApp with its PDF. Where the device can hand files to
 * other apps (phones, the Android app, Chrome, Edge and Safari on most
 * computers) the share sheet gets the PDF with the message: pick WhatsApp and
 * the chat. Elsewhere WhatsApp opens with the message to the customer's number
 * and the PDF is downloaded, to attach there ("downloaded").
 *
 * Call it straight from a tap: WhatsApp's window is opened before anything is
 * awaited (a browser opens a window only from a tap), the PDF fetched after.
 */
export async function whatsAppWithPdf(pdf: () => Promise<Blob>, filename: string, text: string, mobile?: string | null): Promise<"shared" | "downloaded"> {
  if (canShareFiles()) {
    const blob = await pdf();
    if (await shareFile(blob, filename, text)) return "shared";
    downloadBlob(filename, blob);
    shareOnWhatsApp(text, mobile);
    return "downloaded";
  }
  shareOnWhatsApp(text, mobile);
  downloadBlob(filename, await pdf());
  return "downloaded";
}
