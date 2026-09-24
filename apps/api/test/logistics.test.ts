import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("packing and dispatch", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  let warehouseToken: string;
  const ids: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });
  const orderStatus = async () => (await get(`/sales-orders/${ids.order}`)).body.status;

  const login = async (roleId: string, name: string) => {
    const mobile = nextMobile();
    await post("/members", { name, mobile, roleId });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    return (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken as string;
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Route Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    salesToken = await login(roles.sales, "Sales Sam");
    warehouseToken = await login(roles.warehouse, "Wasim Warehouse");
    const units = Object.fromEntries((await get("/units")).body.data.map((u: { symbol: string; id: string }) => [u.symbol, u.id]));
    const taxes = Object.fromEntries((await get("/tax-categories")).body.data.map((c: { name: string; id: string }) => [c.name, c.id]));
    ids.soap = (await post("/products", { name: "Bath Soap", hsnCode: "3401", taxCategoryId: taxes["GST 18%"], baseUnitId: units.PCS, sellingPrice: "40", openingStock: "100", openingStockCost: "30", barcodes: ["8901234567890"] })).body.id;
    ids.ors = (await post("/products", { name: "ORS Sachet", hsnCode: "3004", taxCategoryId: taxes["GST 5%"], baseUnitId: units.PCS, sellingPrice: "20", trackBatches: true })).body.id;
    ids.supplier = (await post("/suppliers", { name: "Pharma Depot", stateCode: "23", gstRegistration: "unregistered" })).body.id;
    await post("/purchases", {
      supplierId: ids.supplier,
      supplierInvoiceNumber: "PD/1",
      supplierInvoiceDate: "2026-09-20",
      lines: [
        { productId: ids.ors, qty: "30", rate: "12", batchNumber: "B-LATE", expiryDate: "2027-12-31" },
        { productId: ids.ors, qty: "20", rate: "12", batchNumber: "B-EARLY", expiryDate: "2027-03-31" },
      ],
    });
    ids.customer = (await post("/customers", { name: "Sharma Stores", stateCode: "23", city: "Indore" })).body.id;
    ids.walkin = (await post("/customers", { name: "Counter Buyer", stateCode: "23", city: "Dewas" })).body.id;
    const order = (await post("/sales-orders", { customerId: ids.customer, lines: [{ productId: ids.soap, qty: "10" }, { productId: ids.ors, qty: "25" }] })).body;
    ids.order = order.id;
    ids.soapLine = order.items[0].id;
    ids.orsLine = order.items[1].id;
    await post(`/sales-orders/${ids.order}/status`, { status: "confirmed" });
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("packing", () => {
    it("queues confirmed orders with what is left, barcodes and batches first to expire", async () => {
      const queue = (await get("/packing/queue", warehouseToken)).body.data;
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ orderNumber: "SO/26-27/00001", customerName: "Sharma Stores", status: "confirmed" });
      const [soap, ors] = queue[0].lines;
      expect(soap).toMatchObject({ productName: "Bath Soap", unit: "PCS", ordered: "10.000", remaining: "10.000", barcodes: ["8901234567890"] });
      expect(ors.batches.map((b: { batchNumber: string; qty: string }) => `${b.batchNumber} ${b.qty}`)).toEqual(["B-EARLY 20.000", "B-LATE 30.000"]);
    });

    it("packs in parts: the order moves to packing, then packed when every line is done", async () => {
      const first = await post("/packing", { salesOrderId: ids.order, lines: [{ orderItemId: ids.soapLine, qty: "10", scannedBarcode: "8901234567890", boxNo: 1 }], boxCount: 1 }, warehouseToken);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ packingNumber: "PK/26-27/00001", status: "packed", orderNumber: "SO/26-27/00001", customerName: "Sharma Stores" });
      expect(await orderStatus()).toBe("packing");
      expect((await post("/packing", { salesOrderId: ids.order, lines: [{ orderItemId: ids.orsLine, qty: "26" }] }, warehouseToken)).body.error).toMatchObject({ code: "PACK_QTY_EXCEEDS", params: { product: "ORS Sachet", remaining: "25.000" } });
      const batches = (await get("/packing/queue", warehouseToken)).body.data[0].lines[1].batches;
      const second = await post(
        "/packing",
        {
          salesOrderId: ids.order,
          lines: [
            { orderItemId: ids.orsLine, qty: "20", batchId: batches[0].batchId, boxNo: 2 },
            { orderItemId: ids.orsLine, qty: "5", batchId: batches[1].batchId, boxNo: 2 },
          ],
          boxCount: 1,
          totalWeightKg: "2.5",
        },
        warehouseToken,
      );
      ids.packing2 = second.body.id;
      expect(second.body.items.map((i: { batchNumber: string; qty: string }) => `${i.batchNumber} ${i.qty}`)).toEqual(["B-EARLY 20.000", "B-LATE 5.000"]);
      expect(await orderStatus()).toBe("packed");
      expect((await get("/packing/queue")).body.data).toEqual([]);
    });

    it("unpacks (order back to packing) and packs again", async () => {
      const cancelled = await post(`/packing/${ids.packing2}/cancel`, {}, warehouseToken);
      expect(cancelled.body.status).toBe("cancelled");
      expect(await orderStatus()).toBe("packing");
      expect((await get("/packing/queue")).body.data[0].lines[1]).toMatchObject({ packed: "0.000", remaining: "25.000" });
      await post("/packing", { salesOrderId: ids.order, lines: [{ orderItemId: ids.orsLine, qty: "25" }] }, warehouseToken);
      expect(await orderStatus()).toBe("packed");
      expect((await get(`/packing?salesOrderId=${ids.order}`)).body.data.map((p: { status: string }) => p.status)).toEqual(["packed", "cancelled", "packed"]);
      expect((await post("/packing", { salesOrderId: ids.order, lines: [{ orderItemId: ids.soapLine, qty: "1" }] }, salesToken)).status).toBe(403);
    });
  });

  describe("dispatch", () => {
    it("plans a trip with invoices in delivery order and a loading sheet", async () => {
      ids.invoice = (await post(`/sales-orders/${ids.order}/invoice`, {})).body.id;
      ids.counter = (await post("/invoices", { customerId: ids.walkin, lines: [{ productId: ids.soap, qty: "4" }] })).body.id;
      const ready = (await get("/dispatch/ready", warehouseToken)).body.data;
      expect(ready.map((r: { customerName: string }) => r.customerName).sort()).toEqual(["Counter Buyer", "Sharma Stores"]);
      expect(ready.find((r: { customerName: string }) => r.customerName === "Sharma Stores")).toMatchObject({ orderNumber: "SO/26-27/00001", orderStatus: "packed" });

      const trip = await post("/dispatches", { vehicleNumber: "mp09ab1234", driverName: "Raju", driverMobile: "9876512345", invoiceIds: [ids.invoice, ids.counter] }, warehouseToken);
      expect(trip.status).toBe(201);
      ids.trip = trip.body.id;
      expect(trip.body).toMatchObject({ dispatchNumber: "DSP/26-27/00001", status: "planned", vehicleNumber: "MP09AB1234" });
      expect(trip.body.stops.map((s: { sequence: number; customerName: string; status: string }) => `${s.sequence} ${s.customerName} ${s.status}`)).toEqual(["1 Sharma Stores planned", "2 Counter Buyer planned"]);
      expect(trip.body.loading.map((l: { productName: string; qty: string }) => `${l.productName} ${l.qty}`)).toEqual(["Bath Soap 14.000", "ORS Sachet 25.000"]);
      expect(await orderStatus()).toBe("packed");
      expect((await post("/dispatches", { invoiceIds: [ids.counter] }, warehouseToken)).body.error).toMatchObject({ code: "INVOICE_ALREADY_DISPATCHED" });
      expect((await get("/dispatch/ready")).body.data).toEqual([]);
    });

    it("starts the trip (orders dispatched) and records each delivery", async () => {
      const started = await post(`/dispatches/${ids.trip}/start`, {}, warehouseToken);
      expect(started.body.status).toBe("dispatched");
      expect(await orderStatus()).toBe("dispatched");
      const [first, second] = started.body.stops;
      const delivered = await post(`/dispatches/${ids.trip}/stops/${first.id}/deliver`, { status: "delivered", receivedBy: "Mr Sharma" }, warehouseToken);
      expect(delivered.body.stops[0]).toMatchObject({ status: "delivered", receivedBy: "Mr Sharma" });
      expect(delivered.body.status).toBe("dispatched");
      expect(await orderStatus()).toBe("delivered");
      expect((await post(`/dispatches/${ids.trip}/stops/${first.id}/deliver`, { status: "delivered" }, warehouseToken)).body.error.code).toBe("STOP_ALREADY_CLOSED");
      const done = await post(`/dispatches/${ids.trip}/stops/${second.id}/deliver`, { status: "returned", remarks: "Shop closed" }, warehouseToken);
      expect(done.body.status).toBe("partially_delivered");
      const list = (await get("/dispatches?status=delivered")).body.data;
      expect(list[0]).toMatchObject({ dispatchNumber: "DSP/26-27/00001", stops: 2, done: 2, value: expect.any(String) });
      const history = (await get(`/sales-orders/${ids.order}`)).body.history.map((h: { toStatus: string }) => h.toStatus);
      expect(history).toEqual(["pending", "confirmed", "packing", "packed", "packing", "packed", "dispatched", "delivered"]);
    });

    it("cancels a planned trip and frees its invoices", async () => {
      const inv = (await post("/invoices", { customerId: ids.walkin, lines: [{ productId: ids.soap, qty: "2" }] })).body.id;
      const trip = (await post("/dispatches", { invoiceIds: [inv] }, warehouseToken)).body;
      expect((await get("/dispatch/ready")).body.data).toEqual([]);
      expect((await post(`/dispatches/${trip.id}/cancel`, {}, warehouseToken)).body.status).toBe("cancelled");
      expect((await get("/dispatch/ready")).body.data.map((r: { id: string }) => r.id)).toEqual([inv]);
      expect((await post(`/dispatches/${trip.id}/start`, {}, warehouseToken)).body.error.code).toBe("DISPATCH_NOT_PLANNED");
      expect((await get("/dispatches", salesToken)).status).toBe(403);
    });
  });
});
