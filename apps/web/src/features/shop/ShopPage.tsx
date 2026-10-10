import type { ShopAccount } from "@digitalbahi/contracts";
import { upiPayLink } from "@digitalbahi/core";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileText, IndianRupee, Link2Off, Loader2, Minus, Phone, Plus, QrCode as QrIcon, Search, ShoppingCart } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { uuid } from "../../lib/uuid";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { EmptyState } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { QrCode } from "../../components/ui/QrCode";
import { api, ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { downloadBlob } from "../../lib/download";
import { useMediaQuery } from "../../lib/useMediaQuery";

interface ShopUnit {
  unitId: string;
  symbol: string;
  name: string;
  factor: string;
  rate: string;
  isDefault: boolean;
}
interface ShopProduct {
  id: string;
  name: string;
  nameLocal: string | null;
  code: string;
  brand: string | null;
  category: string | null;
  mrp: string | null;
  pricesIncludeTax: boolean;
  gstRate: string;
  inStock: boolean;
  units: ShopUnit[];
}
interface ShopOrder {
  id: string;
  orderNumber: string;
  orderDate: string;
  status: string;
  grandTotal: string;
}
interface ShopData {
  business: { name: string; phone: string | null; city: string | null };
  customer: { name: string };
  products: ShopProduct[];
  orders: ShopOrder[];
  /** The shop's own bills, what it owes and where to pay, when the business shows them on the link. */
  account?: ShopAccount | null;
}
interface Quote {
  taxable: string;
  tax: string;
  roundOff: string;
  grandTotal: string;
}
type Cart = Record<string, { unitId: string; qty: number }>;

/** The order link's key, when the page was opened at #shop/<key>. */
export function shopKeyFromHash(hash: string): string | null {
  const m = /^#shop\/([A-Za-z0-9_-]{32})$/.exec(hash);
  return m ? m[1]! : null;
}

const cartKey = (key: string) => `digitalbahi.shopCart.${key}`;
function readCart(key: string): Cart {
  try {
    const raw = localStorage.getItem(cartKey(key));
    return raw ? (JSON.parse(raw) as Cart) : {};
  } catch {
    return {};
  }
}
function writeCart(key: string, cart: Cart) {
  try {
    if (Object.keys(cart).length) localStorage.setItem(cartKey(key), JSON.stringify(cart));
    else localStorage.removeItem(cartKey(key));
  } catch {
    // Storage blocked: the cart lasts while the page is open.
  }
}

const ORDER_TONE: Record<string, "neutral" | "warn" | "good" | "danger" | "accent"> = {
  pending: "warn",
  confirmed: "accent",
  packing: "accent",
  packed: "accent",
  dispatched: "accent",
  delivered: "good",
  cancelled: "danger",
};

/**
 * The page a shop opens from its order link, with no sign-in: the
 * business's products at the shop's own rates, a cart, and the order placed
 * for the business to confirm. Its own small app (no session, no menu).
 */
export function ShopApp({ shopKey }: { shopKey: string }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <QueryClientProvider client={client}>
      <ShopPage shopKey={shopKey} />
    </QueryClientProvider>
  );
}

function ShopPage({ shopKey }: { shopKey: string }) {
  const { t, locale, setLocale, money, dateMedium } = useI18n();
  const page = useQuery({ queryKey: ["shop", shopKey], queryFn: () => api.get<ShopData>(`/shop/${shopKey}`) });
  const [cart, setCart] = useState<Cart>(() => readCart(shopKey));
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  // The pack picked for a product not in the cart yet.
  const [packs, setPacks] = useState<Record<string, string>>({});
  const [placed, setPlaced] = useState<ShopOrder | null>(null);
  useEffect(() => writeCart(shopKey, cart), [shopKey, cart]);
  useEffect(() => {
    if (page.data) document.title = `${t("shop.orderFrom", { business: page.data.business.name })}`;
  }, [page.data, t]);

  const products = useMemo(() => page.data?.products ?? [], [page.data]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // Products since taken off the list drop out of the cart.
  const lines = Object.entries(cart).filter(([id, l]) => byId.has(id) && l.qty > 0);
  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter((c): c is string => Boolean(c)))].sort(), [products]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return products.filter((p) => (!category || p.category === category) && words.every((w) => `${p.name} ${p.nameLocal ?? ""} ${p.code} ${p.brand ?? ""}`.toLowerCase().includes(w)));
  }, [products, q, category]);
  const unitOf = (p: ShopProduct, unitId?: string) => p.units.find((u) => u.unitId === unitId) ?? p.units.find((u) => u.isDefault) ?? p.units[0]!;
  // What the bar shows while choosing: rates times quantities, with GST where rates are before tax (the review has the exact bill).
  const estimate = lines.reduce((sum, [id, l]) => {
    const p = byId.get(id)!;
    const value = Number(unitOf(p, l.unitId).rate) * l.qty;
    return sum + (p.pricesIncludeTax ? value : value * (1 + Number(p.gstRate) / 100));
  }, 0);
  const setQty = (p: ShopProduct, unitId: string, qty: number) =>
    setCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[p.id];
      else next[p.id] = { unitId, qty: Math.min(9999, Math.round(qty * 1000) / 1000) };
      return next;
    });
  const nameOf = (p: ShopProduct) => (locale === "hi" && p.nameLocal ? p.nameLocal : p.name);

  if (page.isPending) {
    return (
      <Shell>
        <p className="py-16 text-center text-[14px] text-ink-3" role="status">
          {t("common.loading")}
        </p>
      </Shell>
    );
  }
  if (page.error) {
    const off = page.error instanceof ApiError && (page.error.status === 410 || page.error.status === 400);
    return (
      <Shell>
        {off ? (
          <EmptyState icon={<Link2Off size={24} />} title={t("shop.offTitle")} hint={t("shop.offHint")} className="py-16" />
        ) : (
          <div className="py-10">
            <ErrorNote error={page.error} onRetry={() => void page.refetch()} />
          </div>
        )}
      </Shell>
    );
  }
  const { business, customer, orders, account } = page.data;

  return (
    <Shell
      header={
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold text-ink">{business.name}</p>
            <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-ink-3">
              {business.city && <span>{business.city}</span>}
              {business.phone && (
                <a href={`tel:${business.phone}`} className="inline-flex items-center gap-1 text-accent">
                  <Phone size={13} aria-hidden />
                  {business.phone}
                </a>
              )}
            </p>
          </div>
          <button type="button" className="press shrink-0 rounded-lg border border-line px-2.5 py-1 text-[13px] text-ink-2" onClick={() => setLocale(locale === "hi" ? "en" : "hi")} lang={locale === "hi" ? "en" : "hi"}>
            {locale === "hi" ? "English" : "हिन्दी"}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 pb-28">
        {placed && (
          <div className="flex items-start gap-3 rounded-2xl border border-good/30 bg-good-soft px-4 py-3" role="status" data-placed>
            <CheckCircle2 className="mt-0.5 shrink-0 text-good" size={20} />
            <div>
              <p className="font-medium text-ink">{t("shop.placed", { number: placed.orderNumber, amount: money(placed.grandTotal) })}</p>
              <p className="text-[13px] text-ink-2">{t("shop.placedHint", { business: business.name })}</p>
            </div>
          </div>
        )}
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{t("shop.title", { name: customer.name })}</h1>
          <p className="text-[13px] text-ink-3">{t("shop.subtitle")}</p>
        </div>
        {account && <AccountCard shopKey={shopKey} account={account} customerName={customer.name} />}
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("shop.search")}
            aria-label={t("shop.search")}
            className="h-11 w-full rounded-xl border border-line bg-surface pr-3 pl-9 text-[15px] text-ink outline-none focus:border-accent"
          />
        </div>
        {categories.length > 1 && (
          <div className="scroll-x -mx-4 flex gap-2 px-4" role="group" aria-label={t("shop.categories")}>
            {[null, ...categories].map((c) => (
              <button
                key={c ?? "all"}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={cn("press shrink-0 rounded-full border px-3 py-1.5 text-[13px]", category === c ? "border-accent bg-accent text-ink-inverse" : "border-line bg-surface text-ink-2")}
              >
                {c ?? t("common.all")}
              </button>
            ))}
          </div>
        )}
        {shown.length === 0 ? (
          <EmptyState title={products.length ? t("shop.noMatch") : t("shop.noProducts")} hint={products.length ? t("shop.noMatchHint") : t("shop.noProductsHint", { business: business.name })} />
        ) : (
          <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label={t("shop.products")}>
            {shown.map((p) => {
              const inCart = cart[p.id];
              const unit = unitOf(p, inCart?.unitId ?? packs[p.id]);
              return (
                <li key={p.id} className="flex flex-col gap-2 px-4 py-3" data-product={p.name}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{nameOf(p)}</p>
                      <p className="text-[12.5px] text-ink-3">
                        {[p.brand, p.mrp ? t("shop.mrp", { amount: money(p.mrp) }) : null].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num font-semibold text-ink">
                        {money(unit.rate)}
                        <span className="text-[12.5px] font-normal text-ink-3"> / {unit.symbol}</span>
                      </p>
                      <p className="text-[11.5px] text-ink-3">{p.pricesIncludeTax ? t("shop.inclGst") : Number(p.gstRate) > 0 ? t("shop.plusGst", { rate: Number(p.gstRate) }) : t("shop.noGst")}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {p.units.length > 1 &&
                        p.units.map((u) => (
                          <button
                            key={u.unitId}
                            type="button"
                            aria-pressed={u.unitId === unit.unitId}
                            onClick={() => (inCart ? setQty(p, u.unitId, inCart.qty) : setPacks((x) => ({ ...x, [p.id]: u.unitId })))}
                            className={cn("press rounded-lg border px-2 py-0.5 text-[12.5px]", u.unitId === unit.unitId ? "border-accent text-accent" : "border-line text-ink-3")}
                          >
                            {u.symbol}
                            {Number(u.factor) !== 1 && <span className="text-ink-3"> ×{Number(u.factor)}</span>}
                          </button>
                        ))}
                      {!p.inStock && <Badge tone="warn">{t("shop.outOfStock")}</Badge>}
                    </div>
                    {inCart ? (
                      <div className="flex items-center gap-1">
                        <button type="button" className="press grid size-9 place-items-center rounded-lg border border-line text-ink" aria-label={t("shop.less")} onClick={() => setQty(p, unit.unitId, inCart.qty - 1)}>
                          <Minus size={16} />
                        </button>
                        <input
                          inputMode="decimal"
                          className="num h-9 w-14 rounded-lg border border-line bg-surface text-center text-[15px] text-ink"
                          aria-label={t("shop.qtyOf", { name: p.name })}
                          value={inCart.qty}
                          onChange={(e) => {
                            const n = Number(e.target.value.replace(/[^0-9.]/g, ""));
                            if (Number.isFinite(n)) setQty(p, unit.unitId, n);
                          }}
                        />
                        <button type="button" className="press grid size-9 place-items-center rounded-lg border border-line text-ink" aria-label={t("shop.more")} onClick={() => setQty(p, unit.unitId, inCart.qty + 1)}>
                          <Plus size={16} />
                        </button>
                      </div>
                    ) : (
                      <Button size="sm" icon={<Plus size={15} />} onClick={() => setQty(p, unit.unitId, 1)} aria-label={t("shop.addNamed", { name: p.name })}>
                        {t("shop.add")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {orders.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="shop-orders">
            <h2 id="shop-orders" className="text-[15px] font-semibold text-ink">
              {t("shop.yourOrders")}
            </h2>
            <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13.5px]" data-order={o.orderNumber}>
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{o.orderNumber}</span>
                    <span className="text-[12.5px] text-ink-3">{dateMedium(o.orderDate)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="num text-ink">{money(o.grandTotal)}</span>
                    <Badge tone={ORDER_TONE[o.status] ?? "neutral"}>{t(`status.order.${o.status as "pending"}`)}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur" style={{ paddingBottom: "max(12px, var(--inset-bottom))" }}>
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
            <div>
              <p className="text-[13px] text-ink-3">{t("shop.items", { count: lines.length })}</p>
              <p className="num text-[17px] font-semibold text-ink">≈ {money(estimate)}</p>
            </div>
            <Button variant="primary" icon={<ShoppingCart size={16} />} onClick={() => setReviewing(true)}>
              {t("shop.review")}
            </Button>
          </div>
        </div>
      )}
      <ReviewDialog
        open={reviewing}
        onOpenChange={setReviewing}
        shopKey={shopKey}
        lines={lines.map(([id, l]) => ({ product: byId.get(id)!, unit: unitOf(byId.get(id)!, l.unitId), qty: l.qty }))}
        businessName={business.name}
        onPlaced={(o) => {
          setPlaced(o);
          setCart({});
          setReviewing(false);
          void page.refetch();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    </Shell>
  );

}

/** Saves a PDF the page asks the server for (the shop's statement, one of its bills). */
function useShopPdf(shopKey: string) {
  const { locale } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const save = async (id: string, path: string, filename: string) => {
    setBusy(id);
    setError(null);
    try {
      downloadBlob(filename, await api.blob(`/shop/${shopKey}${path}`, { locale }));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, save };
}

/**
 * What the shop owes and how to pay it, its latest bills (each as a PDF) and
 * payments, and its statement: on its order link when the business shows them.
 */
function AccountCard({ shopKey, account, customerName }: { shopKey: string; account: ShopAccount; customerName: string }) {
  const { t, money, dateMedium } = useI18n();
  const touch = useMediaQuery("(pointer: coarse)");
  const [qr, setQr] = useState(false);
  const pdf = useShopPdf(shopKey);
  const owes = Number(account.balance);
  const pay = account.upi && owes > 0 ? upiPayLink({ upiId: account.upi.id, name: account.upi.name, amount: owes, note: customerName }) : null;
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" aria-labelledby="shop-account" data-shop-account>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="shop-account" className="text-[13px] font-medium text-ink-3">
            {t("shop.account.title")}
          </h2>
          <p className={cn("num font-display text-[26px] leading-tight font-semibold", owes > 0 ? "text-ink" : "text-good")} data-balance>
            {owes > 0 ? money(account.balance) : owes < 0 ? t("shop.account.advance", { amount: money(-owes) }) : t("shop.account.nothingDue")}
          </p>
          {Number(account.overdue) > 0 && <p className="text-[13px] font-medium text-danger">{t("shop.account.overdue", { amount: money(account.overdue) })}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {pay && touch && (
            <a href={pay} className="press inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] bg-accent bg-accent-grad px-4 text-sm font-medium text-ink-inverse shadow-glow" data-pay>
              <IndianRupee size={16} aria-hidden />
              {t("shop.account.pay", { amount: money(account.balance) })}
            </a>
          )}
          {pay && (
            <Button icon={<QrIcon size={16} />} variant={touch ? "secondary" : "primary"} aria-expanded={qr} onClick={() => setQr((v) => !v)}>
              {touch ? t("shop.account.showQr") : t("shop.account.pay", { amount: money(account.balance) })}
            </Button>
          )}
          <Button icon={pdf.busy === "statement" ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />} disabled={pdf.busy !== null} onClick={() => void pdf.save("statement", "/statement/pdf", "statement.pdf")}>
            {t("shop.account.statement")}
          </Button>
        </div>
      </div>
      {pay && qr && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-surface-2/50 p-4 text-center sm:flex-row sm:text-left" data-pay-qr>
          <QrCode text={pay} size={168} label={t("shop.account.qrLabel")} />
          <div className="text-[13px] text-ink-2">
            <p className="font-medium text-ink">{t("shop.account.scan", { amount: money(account.balance) })}</p>
            <p className="font-mono text-[12.5px] text-ink-3">{account.upi!.id}</p>
            <p className="mt-1 text-[12.5px] text-ink-3">{t("shop.account.payNote")}</p>
          </div>
        </div>
      )}
      <ErrorNote error={pdf.error} />
      {account.bills.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold text-ink">{t("shop.account.bills")}</h3>
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {account.bills.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13.5px]" data-bill={b.number ?? b.id}>
                <span className="min-w-0">
                  <span className="block font-medium text-ink">{b.number ?? "—"}</span>
                  <span className="text-[12.5px] text-ink-3">
                    {dateMedium(b.date)}
                    {Number(b.due) > 0 && b.dueDate ? ` · ${t("shop.account.dueOn", { date: dateMedium(b.dueDate) })}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-right">
                    <span className="num block text-ink">{money(b.total)}</span>
                    {Number(b.due) > 0 ? (
                      <span className={cn("num text-[12px]", b.overdue ? "font-medium text-danger" : "text-ink-3")}>{t("shop.account.left", { amount: money(b.due) })}</span>
                    ) : (
                      <span className="text-[12px] text-good">{t("shop.account.paid")}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="press grid size-9 place-items-center rounded-lg border border-line text-ink-2"
                    aria-label={t("shop.account.billPdf", { number: b.number ?? "" })}
                    disabled={pdf.busy !== null}
                    onClick={() => void pdf.save(b.id, `/invoices/${b.id}/pdf`, `${(b.number ?? "bill").replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`)}
                  >
                    {pdf.busy === b.id ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {account.payments.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold text-ink">{t("shop.account.payments")}</h3>
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {account.payments.map((p, i) => (
              <li key={`${p.number ?? ""}-${i}`} className="flex items-center justify-between gap-3 px-3 py-2 text-[13.5px]">
                <span className="text-ink-2">
                  {dateMedium(p.date)}
                  {p.number ? <span className="text-ink-3"> · {p.number}</span> : null}
                </span>
                <span className="num text-good">{money(p.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ReviewDialog({
  open,
  onOpenChange,
  shopKey,
  lines,
  businessName,
  onPlaced,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  shopKey: string;
  lines: Array<{ product: ShopProduct; unit: ShopUnit; qty: number }>;
  businessName: string;
  onPlaced(o: ShopOrder): void;
}) {
  const { t, money, locale } = useI18n();
  const [notes, setNotes] = useState("");
  // One key per order being placed: tapping again (or a dropped connection) cannot place it twice.
  const [idem, setIdem] = useState(() => uuid());
  const body = { lines: lines.map((l) => ({ productId: l.product.id, unitId: l.unit.unitId, qty: String(l.qty) })) };
  const quote = useQuery({
    queryKey: ["shop-quote", shopKey, JSON.stringify(body)],
    queryFn: () => api.post<Quote>(`/shop/${shopKey}/quote`, body),
    enabled: open && lines.length > 0,
  });
  const place = useMutation({
    mutationFn: () => api.post<ShopOrder>(`/shop/${shopKey}/orders`, { ...body, ...(notes.trim() ? { notes: notes.trim() } : {}) }, { idempotencyKey: idem }),
    onSuccess: (o) => {
      setNotes("");
      setIdem(uuid());
      onPlaced(o);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("shop.reviewTitle")}
      description={t("shop.reviewHint", { business: businessName })}
      closeLabel={t("common.close")}
      footer={
        <Button variant="primary" block disabled={place.isPending || !quote.data || lines.length === 0} onClick={() => place.mutate()}>
          {place.isPending ? t("shop.placing") : quote.data ? t("shop.place", { amount: money(quote.data.grandTotal) }) : t("shop.placeShort")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line text-[14px]">
          {lines.map((l) => (
            <li key={l.product.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <span className="min-w-0">
                <span className="block text-ink">{locale === "hi" && l.product.nameLocal ? l.product.nameLocal : l.product.name}</span>
                <span className="num text-[12.5px] text-ink-3">
                  {l.qty} {l.unit.symbol} × {money(l.unit.rate)}
                </span>
              </span>
              <span className="num shrink-0 text-ink">{money(Number(l.unit.rate) * l.qty)}</span>
            </li>
          ))}
        </ul>
        {quote.data ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[13.5px]" data-quote>
            <dt className="text-ink-3">{t("shop.taxable")}</dt>
            <dd className="num text-right text-ink-2">{money(quote.data.taxable)}</dd>
            <dt className="text-ink-3">{t("shop.gst")}</dt>
            <dd className="num text-right text-ink-2">{money(quote.data.tax)}</dd>
            {Number(quote.data.roundOff) !== 0 && (
              <>
                <dt className="text-ink-3">{t("shop.roundOff")}</dt>
                <dd className="num text-right text-ink-2">{money(quote.data.roundOff)}</dd>
              </>
            )}
            <dt className="font-semibold text-ink">{t("shop.total")}</dt>
            <dd className="num text-right font-semibold text-ink" data-total>
              {money(quote.data.grandTotal)}
            </dd>
          </dl>
        ) : (
          !quote.error && (
            <p className="text-[13px] text-ink-3" role="status">
              {t("shop.working")}
            </p>
          )
        )}
        <ErrorNote error={quote.error} onRetry={() => void quote.refetch()} />
        <Field label={t("shop.notes")} htmlFor="shop-notes" hint={t("shop.notesHint")}>
          <Input id="shop-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorNote error={place.error} onRetry={() => place.mutate()} />
      </div>
    </Dialog>
  );
}

function Shell({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-app-screen bg-canvas">
      {header && (
        <header className="border-b border-line bg-surface px-4 py-3">
          <div className="mx-auto max-w-2xl">{header}</div>
        </header>
      )}
      <main className="mx-auto max-w-2xl px-4 pt-4">{children}</main>
    </div>
  );
}
