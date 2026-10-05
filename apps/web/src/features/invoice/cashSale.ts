import { normalizeSearchText } from "@digitalbahi/core";
import { BUSINESS, CUSTOMERS, WALK_IN_ID } from "../../data/db";
import { LIVE } from "../../data/source";
import { createCustomer } from "../customers/saveCustomer";

/** What the counter customer is called; a shop that renamed theirs ("Cash customer", "Walk-in") still counts. */
export const CASH_SALE_NAME = "Cash sale";
const NAMES = new Set(["cash sale", "cash customer", "cash", "walk in", "walk-in", "counter sale"].map(normalizeSearchText));

/** The business's counter customer, if it has one already. */
export function findCashSale(): string | null {
  if (!LIVE) return WALK_IN_ID || null;
  const c = CUSTOMERS.find((x) => NAMES.has(normalizeSearchText(x.businessName)) || NAMES.has(normalizeSearchText(x.name)));
  return c?.id ?? null;
}

/**
 * The counter customer for a walk-in bill: the one the business has, or a new
 * "Cash sale" customer (B2C, in the business's state) made on first use.
 */
export async function cashSaleCustomer(): Promise<string> {
  const found = findCashSale();
  if (found) return found;
  const { customer } = await createCustomer({ name: CASH_SALE_NAME, businessName: CASH_SALE_NAME, customerType: "b2c", stateCode: BUSINESS.stateCode });
  return customer.id;
}
