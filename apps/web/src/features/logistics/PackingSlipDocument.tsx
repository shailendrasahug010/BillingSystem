import { useI18n } from "../../app/i18n";
import { FirmHeader, MadeWithDigitalBahi } from "../../components/brand/Brand";

export interface PrintablePacking {
  id: string;
  packingNumber: string;
  status: "packed" | "cancelled" | "in_progress";
  boxCount: number;
  totalWeightKg: string | null;
  packedAt: string | null;
  notes: string | null;
  orderNumber: string;
  orderDate: string;
  orderStatus: string;
  customerName: string;
  customerAddress: string | null;
  customerCity: string | null;
  customerMobile: string | null;
  packedByName: string | null;
  items: Array<{ id: string; productName: string; qty: string; unit: string; boxNo: number | null; batchNumber: string | null; expiryDate: string | null }>;
}

/** Packing slip that goes inside / on the box: what is packed, from which batch, in which box. No prices. */
export function PackingSlipDocument({ packing: p }: { packing: PrintablePacking }) {
  const { t, number, dateMedium, dateTime } = useI18n();
  const cell = "border border-[#c8d1e0] px-2 py-1";
  return (
    <article className="mx-auto w-full max-w-[820px] bg-white p-6 text-[13px] leading-snug text-[#0e1a33] shadow-pop sm:p-8" style={{ fontFamily: "var(--font-sans)" }}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#1450b4] pb-3">
        <FirmHeader detail="short" />
        <div className="text-right">
          <p className="text-[17px] font-bold tracking-wide text-[#1450b4]">{t("packing.slip").toUpperCase()}</p>
          <p className="font-mono font-semibold">{p.packingNumber}</p>
          {p.packedAt && <p>{dateTime(p.packedAt)}</p>}
          {p.status === "cancelled" && <p className="font-bold text-[#b42318]">{t("packing.unpacked").toUpperCase()}</p>}
        </div>
      </header>
      <div className="mt-3 grid grid-cols-2 gap-4">
        <div>
          <p className="text-[11.5px] text-[#4a5570]">{t("packing.shipTo")}</p>
          <p className="font-semibold">{p.customerName}</p>
          {p.customerAddress && <p>{p.customerAddress}</p>}
          {p.customerCity && <p>{p.customerCity}</p>}
          {p.customerMobile && <p>{p.customerMobile}</p>}
        </div>
        <div className="text-right">
          <p className="text-[11.5px] text-[#4a5570]">{t("packing.order")}</p>
          <p className="font-semibold">{p.orderNumber}</p>
          <p>{dateMedium(p.orderDate)}</p>
          <p className="mt-1">
            {t("packing.boxCount")}: <span className="font-semibold">{p.boxCount}</span>
            {p.totalWeightKg && ` · ${number(p.totalWeightKg, 2)} kg`}
          </p>
        </div>
      </div>
      <table className="num mt-4 w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="bg-[#eef2f9] text-left">
            <th className={cell}>#</th>
            <th className={cell}>{t("invoice.product")}</th>
            <th className={cell}>{t("packing.batch")}</th>
            <th className={`${cell} text-right`}>{t("invoice.qty")}</th>
            <th className={`${cell} text-right`}>{t("packing.box")}</th>
          </tr>
        </thead>
        <tbody>
          {p.items.map((it, i) => (
            <tr key={it.id}>
              <td className={cell}>{i + 1}</td>
              <td className={cell}>{it.productName}</td>
              <td className={cell}>{it.batchNumber ? `${it.batchNumber}${it.expiryDate ? ` · ${t("packing.exp")} ${dateMedium(it.expiryDate)}` : ""}` : "—"}</td>
              <td className={`${cell} text-right`}>
                {number(it.qty, 0)} {it.unit}
              </td>
              <td className={`${cell} text-right`}>{it.boxNo ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.notes && <p className="mt-2 text-[#4a5570]">{p.notes}</p>}
      <footer className="mt-10 flex items-end justify-between gap-4 text-[12px]">
        <p className="border-t border-[#0e1a33] pt-1">
          {t("packing.packedBy")}: {p.packedByName ?? ""}
        </p>
        <p className="border-t border-[#0e1a33] pt-1">{t("packing.checkedBy")}</p>
      </footer>
      <MadeWithDigitalBahi />
    </article>
  );
}
