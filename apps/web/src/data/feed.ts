import type { Catalog, CustomerRow, SupplierRow, WorkspaceData } from "./live";

/**
 * The pull feed (GET /sync/pull): the device keeps its copy of the business
 * current with only what changed since it last asked. Each answer carries
 * changed products, customers and suppliers whole (as /catalog, /customers
 * and /suppliers give them), the ids of those to drop, the small lists when
 * they differ from the device's, and the cursor for next time.
 */
export interface PullPage {
  /** No cursor, or one too old: load everything, then pull from `cursor`. */
  reset?: boolean;
  /** More of this pass: ask again with `cursor` at once. */
  more: boolean;
  cursor: string;
  products: Catalog["products"];
  customers: CustomerRow[];
  suppliers: SupplierRow[];
  removed: { product: string[]; customer: string[]; supplier: string[] };
  lists?: Partial<Pick<Catalog, "taxCategories" | "priceLevels" | "units" | "brands" | "categories">> & Partial<Pick<WorkspaceData, "routes" | "warehouses" | "expenseCategories">>;
  listsHash?: string;
}

/** Where the device's feed stopped, and for which access its copy was made. */
export interface FeedState {
  cursor: string;
  /** The lists the device has (sent again only when they differ). */
  listsHash?: string;
  /** The person's permissions when the copy was loaded: a change loads everything again (other fields, other records). */
  access: string;
}

export const accessKey = (permissions: readonly string[]) => [...permissions].sort().join(",");

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Replaces the changed rows, drops the removed ones, keeps the rest as they are. */
function merge<T extends { id: string; name: string }>(rows: T[], changed: T[], removed: string[]): T[] {
  if (!changed.length && !removed.length) return rows;
  const out = new Set([...removed, ...changed.map((x) => x.id)]);
  return rows.filter((x) => !out.has(x.id)).concat(changed).sort(byName);
}

/** Whether a page changes anything the device keeps. */
export const pageChanges = (page: PullPage) =>
  page.products.length + page.customers.length + page.suppliers.length + page.removed.product.length + page.removed.customer.length + page.removed.supplier.length > 0 || page.lists !== undefined;

/** The device's copy with a page of the feed applied (the copy given is not changed). */
export function applyPull(data: WorkspaceData, page: PullPage): WorkspaceData {
  const lists = page.lists ?? {};
  const catalog: Catalog | null = data.catalog && {
    ...data.catalog,
    products: merge(data.catalog.products, page.products, page.removed.product),
    ...(lists.taxCategories ? { taxCategories: lists.taxCategories } : {}),
    ...(lists.priceLevels ? { priceLevels: lists.priceLevels } : {}),
    ...(lists.units ? { units: lists.units } : {}),
    ...(lists.brands ? { brands: lists.brands } : {}),
    ...(lists.categories ? { categories: lists.categories } : {}),
  };
  return {
    ...data,
    catalog,
    customers: merge(data.customers, page.customers, page.removed.customer),
    suppliers: merge(data.suppliers, page.suppliers, page.removed.supplier),
    ...(lists.routes ? { routes: lists.routes } : {}),
    ...(lists.warehouses ? { warehouses: lists.warehouses } : {}),
    ...(lists.expenseCategories ? { expenseCategories: lists.expenseCategories } : {}),
  };
}
