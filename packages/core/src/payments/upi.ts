/** A UPI ID (virtual payment address): name@bank. */
export const UPI_ID = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{2,63}$/;

/**
 * A UPI payment link (NPCI's `upi://pay`): shown as a QR code, any UPI app
 * scans it and opens with the payee, the amount and the bill filled in.
 */
export function upiPayLink(p: { upiId: string; name: string; amount?: number | string | null; note?: string | null }): string {
  const q = [`pa=${encodeURIComponent(p.upiId.trim())}`, `pn=${encodeURIComponent(p.name.trim())}`];
  if (p.amount !== undefined && p.amount !== null && Number(p.amount) > 0) q.push(`am=${Number(p.amount).toFixed(2)}`);
  q.push("cu=INR");
  if (p.note) q.push(`tn=${encodeURIComponent(p.note.slice(0, 50))}`);
  return `upi://pay?${q.join("&")}`;
}
