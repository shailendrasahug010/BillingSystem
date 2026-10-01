import type { PaymentMethod, TaxCategory } from "@digitalbahi/core";

export interface Business {
  name: string;
  legalName: string;
  gstin: string;
  stateCode: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  bank: { name: string; account: string; ifsc: string; upi: string };
  /** The firm's own logo (live data: GET /business/logo); changes when a new one is uploaded. */
  logoFileId?: string | null;
}

export interface Brand {
  id: string;
  name: string;
}

export interface Product {
  id: string;
  name: string;
  nameHi: string;
  code: string;
  barcode: string;
  brandId: string;
  brand: string;
  category: string;
  hsn: string;
  taxCategory: TaxCategory;
  /** GST % in force today (for list display; invoices resolve per date). */
  gstRate: number;
  unit: string;
  uqc: string;
  packSize: string;
  /** Units per case; suggestions round to it. */
  caseSize: number;
  mrp: number;
  rate: number;
  wholesaleRate: number;
  purchasePrice: number;
  stock: number;
  minStock: number;
  aliases: string[];
  batch?: { number: string; expiry: string };
  /** Live data: base-unit price and default discount per rate list (price level id). */
  prices?: Record<string, number>;
  discounts?: Record<string, number>;
  /** Every barcode of the product (base and pack units). */
  barcodes?: string[];
  /** MRP-style pricing: rates include GST. */
  pricesIncludeTax?: boolean;
  active?: boolean;
  /** Live data: base unit and the pack units it can be bought / sold in. */
  unitId?: string;
  packUnits?: Array<{ unitId: string; symbol: string; factor: number }>;
  /** Rate-list prices set for a pack unit, keyed "priceLevelId|unitId" (else the stock unit's price times the pack). */
  unitPrices?: Record<string, number>;
  unitDiscounts?: Record<string, number>;
  trackBatches?: boolean;
  trackExpiry?: boolean;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  businessName: string;
  type: "b2b" | "b2c";
  mobile: string;
  gstin: string | null;
  city: string;
  address: string;
  stateCode: string;
  pincode: string;
  creditLimit: number | null;
  creditDays: number;
  category: string;
  route: string;
  salesRep: string;
  priceLevel: "retail" | "wholesale";
  openingBalance: number;
  /** Live data. */
  priceLevelId?: string | null;
  gstRegistration?: string;
  balance?: number;
  overdue?: number;
  version?: number;
}

export interface InvoiceLine {
  productId: string;
  qty: number;
  rate: number;
  discountPercent: number;
}

export interface Invoice {
  id: string;
  number: string;
  date: string;
  dueDate: string;
  customerId: string;
  lines: InvoiceLine[];
  taxable: number;
  tax: number;
  total: number;
  cost: number;
  paid: number;
  settledOn: string | null;
}

export interface Payment {
  id: string;
  number: string;
  date: string;
  customerId: string;
  amount: number;
  method: PaymentMethod;
  reference: string;
}

export interface Order {
  id: string;
  number: string;
  date: string;
  customerId: string;
  status: "pending" | "confirmed" | "packing" | "packed" | "dispatched";
  items: number;
  value: number;
}

export interface DayAmount {
  date: string;
  amount: number;
}
