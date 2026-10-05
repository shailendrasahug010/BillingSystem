import { describe, expect, it } from "vitest";
import { hashFor, routeFromHash, type Route } from "./router";

describe("screen links", () => {
  const routes: Route[] = [
    { name: "dashboard" },
    { name: "invoices" },
    { name: "profile" },
    { name: "invoice-new" },
    { name: "invoice-new", customerId: "c1" },
    { name: "invoice-view", invoiceId: "0b6f7e0c-6d1e-4c38-9a59-7a1f1a0e8b11" },
    { name: "invoice-view", invoiceId: "offline:k/2" },
    { name: "customer", customerId: "c1" },
    { name: "purchase-new" },
    { name: "purchase-new", supplierId: "s1" },
    { name: "purchase-view", purchaseId: "p1" },
    { name: "supplier", supplierId: "s1" },
    { name: "order-view", orderId: "o1" },
    { name: "planned", module: "payments" },
    { name: "planned", module: "payments", action: "collect", partyId: "c1" },
    { name: "planned", module: "orders", action: "new" },
    { name: "planned", module: "orders", partyId: "c1" },
    { name: "planned", module: "gst" },
  ];

  it("every screen has a link that opens it again", () => {
    for (const route of routes) expect(routeFromHash(hashFor(route))).toEqual(route);
  });

  it("keeps the links shared before", () => {
    expect(routeFromHash("#customers")).toEqual({ name: "customers" });
    expect(routeFromHash("#invoice")).toEqual({ name: "invoice-new" });
    expect(routeFromHash("#design")).toEqual({ name: "design-system" });
  });

  it("does not print again on a reload", () => {
    expect(routeFromHash(hashFor({ name: "invoice-view", invoiceId: "i1", print: true }))).toEqual({ name: "invoice-view", invoiceId: "i1" });
  });

  it("ignores links that name no screen", () => {
    for (const hash of ["", "#", "#nothing", "#customer", "#customers/x", "#%E0%A4"]) expect(routeFromHash(hash)).toBeNull();
  });
});
