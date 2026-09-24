import { useI18n } from "../../app/i18n";
import { BUSINESS } from "../../data/db";
import type { TripStatus } from "./DispatchPage";

export interface PrintableTrip {
  id: string;
  dispatchNumber: string;
  dispatchDate: string;
  vehicleNumber: string | null;
  driverName: string | null;
  driverMobile: string | null;
  driverEmployeeName: string | null;
  transporterName: string | null;
  lrNumber: string | null;
  lrDate: string | null;
  expectedDeliveryDate: string | null;
  remarks: string | null;
  status: TripStatus;
  stops: Array<{
    id: string;
    sequence: number;
    status: TripStatus;
    deliveredAt: string | null;
    receivedBy: string | null;
    remarks: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    grandTotal: string | null;
    balanceDue: string | null;
    orderNumber: string | null;
    customerName: string;
    address: string | null;
    city: string | null;
    mobile: string | null;
  }>;
  loading: Array<{ productId: string; productName: string; unit: string; qty: string; invoices: number }>;
}

/** Trip sheet for the driver: stops in order with amounts to collect and a signature column, then the loading list. */
export function DispatchSheetDocument({ trip }: { trip: PrintableTrip }) {
  const { t, money, number, dateMedium } = useI18n();
  const cell = "border border-[#c9d2d3] px-2 py-1 align-top";
  return (
    <article className="mx-auto w-full max-w-[820px] bg-white p-6 text-[12.5px] leading-snug text-[#10201f] sm:p-8" style={{ fontFamily: "var(--font-sans)" }}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#0b6e82] pb-3">
        <div>
          <h2 className="text-[20px] leading-tight font-bold text-[#0b3b44]" style={{ fontFamily: "var(--font-display)" }}>
            {BUSINESS.name}
          </h2>
          {BUSINESS.city && <p>{BUSINESS.city}</p>}
        </div>
        <div className="text-right">
          <p className="text-[17px] font-bold tracking-wide text-[#0b6e82]">{t("dispatch.sheet").toUpperCase()}</p>
          <p className="font-mono font-semibold">{trip.dispatchNumber}</p>
          <p>{dateMedium(trip.dispatchDate)}</p>
        </div>
      </header>
      <p className="mt-2">
        {[
          trip.vehicleNumber && `${t("dispatch.vehicle")}: ${trip.vehicleNumber}`,
          (trip.driverEmployeeName ?? trip.driverName) && `${t("dispatch.driver")}: ${trip.driverEmployeeName ?? trip.driverName}${trip.driverMobile ? ` (${trip.driverMobile})` : ""}`,
          trip.lrNumber && `${t("dispatch.lr")}: ${trip.lrNumber}${trip.transporterName ? ` · ${trip.transporterName}` : ""}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <table className="num mt-3 w-full border-collapse">
        <thead>
          <tr className="bg-[#eef4f5] text-left">
            <th className={cell}>#</th>
            <th className={cell}>{t("customer.name")}</th>
            <th className={cell}>{t("dispatch.invoice")}</th>
            <th className={`${cell} text-right`}>{t("common.amount")}</th>
            <th className={`${cell} text-right`}>{t("dispatch.toCollect")}</th>
            <th className={cell}>{t("dispatch.signature")}</th>
          </tr>
        </thead>
        <tbody>
          {trip.stops
            .filter((s) => s.status !== "cancelled")
            .map((s) => (
              <tr key={s.id}>
                <td className={cell}>{s.sequence}</td>
                <td className={cell}>
                  <p className="font-semibold">{s.customerName}</p>
                  <p>{[s.address, s.city, s.mobile].filter(Boolean).join(", ")}</p>
                </td>
                <td className={cell}>{s.invoiceNumber}</td>
                <td className={`${cell} text-right`}>{money(s.grandTotal ?? "0")}</td>
                <td className={`${cell} text-right`}>{Number(s.balanceDue ?? 0) > 0 ? money(s.balanceDue!) : "—"}</td>
                <td className={`${cell} w-32`} />
              </tr>
            ))}
        </tbody>
      </table>
      {trip.loading.length > 0 && (
        <>
          <h3 className="mt-4 mb-1 font-semibold">{t("dispatch.loading")}</h3>
          <table className="num w-full border-collapse">
            <tbody>
              {trip.loading.map((l) => (
                <tr key={l.productId}>
                  <td className={cell}>{l.productName}</td>
                  <td className={`${cell} text-right`}>
                    {number(l.qty, 0)} {l.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <footer className="mt-10 flex items-end justify-between gap-4 text-[12px]">
        <p className="border-t border-[#10201f] pt-1">{t("dispatch.driverSign")}</p>
        <p className="border-t border-[#10201f] pt-1">{t("invoice.print.signatory")}</p>
      </footer>
    </article>
  );
}
