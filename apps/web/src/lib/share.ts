import { nativePlugin } from "../platform/native";

/** Indian mobile to the international digits WhatsApp expects (91XXXXXXXXXX). */
export function whatsappNumber(mobile: string | null | undefined): string | null {
  const digits = (mobile ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return null;
}

/**
 * Opens WhatsApp (app or web) with the message typed in; the user picks send.
 * Without a number, WhatsApp asks whom to send it to.
 */
export function shareOnWhatsApp(text: string, mobile?: string | null): void {
  const to = whatsappNumber(mobile);
  const url = `https://wa.me/${to ?? ""}?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

// In the Android app the share sheet is the phone's own (Capacitor's Share and Filesystem plugins):
// the app's web view has no navigator.share.
interface NativeShare {
  share(o: { text?: string; files?: string[]; dialogTitle?: string }): Promise<unknown>;
}
interface NativeFiles {
  writeFile(o: { path: string; data: string; directory: "CACHE" }): Promise<{ uri: string }>;
}
const nativeSharing = () => {
  const share = nativePlugin<NativeShare>("Share");
  const files = nativePlugin<NativeFiles>("Filesystem");
  return share && files ? { share, files } : null;
};

/** A file's bytes as base64 (what the app's file plugin takes). */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The phone can hand a file to WhatsApp, email and other apps (Android Chrome, iPhone Safari, the Android app). */
export function canShareFiles(): boolean {
  if (nativeSharing()) return true;
  try {
    return typeof navigator !== "undefined" && typeof navigator.canShare === "function" && navigator.canShare({ files: [new File(["%PDF"], "x.pdf", { type: "application/pdf" })] });
  } catch {
    return false;
  }
}

/**
 * Opens the phone's share sheet with the file (the user picks WhatsApp and
 * the chat). Returns false where files cannot be shared; a closed sheet is
 * not an error.
 */
export async function shareFile(blob: Blob, filename: string, text?: string): Promise<boolean> {
  const native = nativeSharing();
  if (native) {
    // Into the app's cache (the share sheet hands the other app a link to it).
    const { uri } = await native.files.writeFile({ path: filename, data: await base64Of(blob), directory: "CACHE" });
    try {
      await native.share.share({ files: [uri], ...(text ? { text } : {}) });
    } catch (e) {
      if (!/cancel/i.test(String((e as Error).message))) throw e;
    }
    return true;
  }
  const file = new File([blob], filename, { type: blob.type || "application/pdf" });
  if (typeof navigator.canShare !== "function" || !navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], ...(text ? { text } : {}) });
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  }
  return true;
}

/** "INV/26-27/00001" -> "INV-26-27-00001.pdf" (the name the server gives the file too). */
export function pdfFileName(number: string): string {
  return `${number.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "document"}.pdf`;
}
