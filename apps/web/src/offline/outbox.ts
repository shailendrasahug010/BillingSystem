import type { CustomerRow } from "../data/live";
import type { PrintableInvoice } from "../features/invoice/printable";

/** What waits on the device to be sent: one shape per kind of work (see sync.ts). */
interface EntryBase {
  /** Also the Idempotency-Key (and a new customer's id). */
  id: string;
  userId: string;
  businessId: string;
  savedAt: string;
  status: "pending" | "failed";
  error: { status: number; code: string; params: Record<string, string | number> } | null;
}

/** A bill (entries saved before other kinds existed have no `kind`). */
export interface OutboxEntry extends EntryBase {
  kind?: "invoice";
  number: string;
  date: string;
  customerId: string;
  customerName: string;
  total: number;
  paid: number;
  lineCount: number;
  /** The POST /invoices body, offline block included. */
  body: Record<string, unknown>;
  printable: PrintableInvoice;
  /** Stock taken out on this device (base units), put back if the bill is removed. */
  stock: Array<{ productId: string; qty: number }>;
}

/** Money from a customer or to a supplier; the server applies it to the oldest bills first. */
export interface PaymentEntry extends EntryBase {
  kind: "payment";
  direction: "in" | "out";
  partyId: string;
  partyName: string;
  date: string;
  amount: number;
  method: string;
  body: Record<string, unknown>;
}

export interface OrderEntry extends EntryBase {
  kind: "order";
  customerId: string;
  customerName: string;
  date: string;
  /** What the device worked out; the server prices the order when it arrives. */
  estimate: number;
  lineCount: number;
  body: Record<string, unknown>;
}

/** A customer added on this device: billed at once under this id. */
export interface CustomerEntry extends EntryBase {
  kind: "customer";
  customerId: string;
  customerName: string;
  body: Record<string, unknown>;
  /** How the customer shows until the server has it. */
  row: CustomerRow;
}

/** Changed details of a customer (only the fields that changed). */
export interface CustomerEditEntry extends EntryBase {
  kind: "customer-edit";
  customerId: string;
  customerName: string;
  body: Record<string, unknown>;
  /** The version the change was made on; null once the person chose to keep theirs over a later change. */
  version: number | null;
  /** When it was last changed on the device (a change made meanwhile on the server wins only if later). */
  madeAt?: string;
  /** The customer before and after, to show now and to put back if the change is removed. */
  before: CustomerRow;
  after: CustomerRow;
}

/** A collector's visit: a note, or the customer's promise to pay by a date. */
export interface CollectionNoteEntry extends EntryBase {
  kind: "collection-note";
  customerId: string;
  customerName: string;
  noteKind: "promise" | "note";
  /** The promised date, or the day of the visit. */
  date: string;
  amount: number | null;
  body: Record<string, unknown>;
}

/** A supplier's bill entered on this device: stock comes in and the supplier is owed at once. */
export interface PurchaseEntry extends EntryBase {
  kind: "purchase";
  supplierId: string;
  supplierName: string;
  billNumber: string;
  date: string;
  total: number;
  paid: number;
  lineCount: number;
  /** Stock brought in on this device (base units), taken back out if the entry is removed. */
  stock: Array<{ productId: string; qty: number }>;
  body: Record<string, unknown>;
}

/** An expense (money spent: rent, tea, fuel…). */
export interface ExpenseEntry extends EntryBase {
  kind: "expense";
  categoryName: string;
  paidTo: string;
  date: string;
  total: number;
  body: Record<string, unknown>;
}

/** Goods back from a customer (credit note) or back to a supplier (debit note), against a kept bill. */
export interface ReturnEntry extends EntryBase {
  kind: "return";
  side: "sale" | "purchase";
  documentId: string;
  documentNumber: string;
  partyId: string;
  partyName: string;
  date: string;
  /** The device's estimate; the server works out the exact amounts. */
  estimate: number;
  /** Stock moved on this device (base units, signed). */
  stock: Array<{ productId: string; qty: number }>;
  body: Record<string, unknown>;
}

/** A discount or rate difference after a bill (credit note), or a supplier's credit note on a purchase: only the value changes. */
export interface PriceNoteEntry extends EntryBase {
  kind: "price-note";
  side: "sale" | "purchase";
  /** The bill: its server id, or the key of a bill made on this device and not sent yet. */
  documentId: string;
  documentNumber: string;
  partyId: string;
  partyName: string;
  date: string;
  /** The device's estimate (GST included); the server works out the exact amounts. */
  estimate: number;
  body: Record<string, unknown>;
}

/** A bill cancelled on this device: its goods go back on the shelf and the customer no longer owes it. */
export interface CancelEntry extends EntryBase {
  kind: "invoice-cancel";
  /** The bill: its server id, or the key of a bill made on this device and not sent yet. */
  documentId: string;
  documentNumber: string;
  customerId: string;
  customerName: string;
  /** What the bill still owed, taken off the customer's balance here. */
  amount: number;
  /** Stock put back on this device (base units). */
  stock: Array<{ productId: string; qty: number }>;
  body: { reason: string };
}

/** A salesperson's call on the beat that left no bill, order or payment: checked in, or no order and why. */
export interface VisitEntry extends EntryBase {
  kind: "visit";
  customerId: string;
  customerName: string;
  outcome: "visited" | "no_order";
  reason: string | null;
  /** The day of the call. */
  date: string;
  body: Record<string, unknown>;
}

export type QueuedEntry = OutboxEntry | PaymentEntry | OrderEntry | CustomerEntry | CustomerEditEntry | CollectionNoteEntry | PurchaseEntry | ExpenseEntry | ReturnEntry | PriceNoteEntry | CancelEntry | VisitEntry;
export type QueuedKind = NonNullable<QueuedEntry["kind"]>;
export const kindOf = (e: { kind?: QueuedKind }): QueuedKind => e.kind ?? "invoice";

/** Something the server has taken; kept briefly so the list can show what happened. */
export interface SyncedEntry {
  id: string;
  kind?: QueuedKind;
  /** The device's number for a bill ("" otherwise). */
  number: string;
  customerName: string;
  total: number;
  serverId: string;
  /** Bill, receipt or order number, or the new customer's code. */
  serverNumber: string;
  serverTotal: number;
  syncedAt: string;
  /** A bill the server took but held for a manager (it broke a rule by the time it arrived). */
  held?: boolean;
  /** A customer change merged with a later one: the fields where the later change stands. */
  kept?: string[];
}
