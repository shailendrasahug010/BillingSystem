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
