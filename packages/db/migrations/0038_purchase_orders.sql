CREATE TYPE "public"."goods_receipt_status" AS ENUM('received', 'billed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('open', 'partly_received', 'received', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "goods_receipt_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"unit_id" uuid NOT NULL,
	"conversion_factor" numeric(15, 3) DEFAULT '1' NOT NULL,
	"qty" numeric(15, 3) NOT NULL,
	"free_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"qty_base" numeric(15, 3) NOT NULL,
	"rate" numeric(15, 4) DEFAULT '0' NOT NULL,
	"discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(15, 4) DEFAULT '0' NOT NULL,
	"purchase_order_item_id" uuid,
	"batch_id" uuid,
	"batch_number" varchar(40),
	"mfg_date" date,
	"expiry_date" date,
	"mrp" numeric(15, 4),
	CONSTRAINT "goods_receipt_items_qty_chk" CHECK ("goods_receipt_items"."qty" > 0 and "goods_receipt_items"."free_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"receipt_number" varchar(30) NOT NULL,
	"series_id" uuid,
	"financial_year" varchar(9) NOT NULL,
	"received_date" date NOT NULL,
	"supplier_id" uuid NOT NULL,
	"party_name" text NOT NULL,
	"purchase_order_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"challan_number" varchar(30),
	"status" "goods_receipt_status" DEFAULT 'received' NOT NULL,
	"purchase_id" uuid,
	"total_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "goods_receipts_number_uq" UNIQUE("business_id","financial_year","receipt_number")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"hsn_code" varchar(8),
	"uqc" varchar(3),
	"unit_id" uuid NOT NULL,
	"conversion_factor" numeric(15, 3) DEFAULT '1' NOT NULL,
	"qty" numeric(15, 3) NOT NULL,
	"free_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"qty_base" numeric(15, 3) NOT NULL,
	"rate" numeric(15, 4) NOT NULL,
	"rate_includes_tax" boolean DEFAULT false NOT NULL,
	"gross_amount" numeric(15, 2) NOT NULL,
	"discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_share" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_value" numeric(15, 2) NOT NULL,
	"taxability" "taxability" DEFAULT 'taxable' NOT NULL,
	"tax_category_id" uuid,
	"tax_rate_id" uuid,
	"gst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cess_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(15, 2) NOT NULL,
	"received_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_order_items_qty_chk" CHECK ("purchase_order_items"."qty" > 0 and "purchase_order_items"."free_qty" >= 0 and "purchase_order_items"."received_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"order_number" varchar(30) NOT NULL,
	"series_id" uuid,
	"financial_year" varchar(9) NOT NULL,
	"order_date" date NOT NULL,
	"expected_date" date,
	"supplier_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"party_name" text NOT NULL,
	"party_gstin" varchar(15),
	"party_state_code" char(2),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"place_of_supply" char(2) NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"is_reverse_charge" boolean DEFAULT false NOT NULL,
	"tax_engine_version" varchar(20) NOT NULL,
	"status" "purchase_order_status" DEFAULT 'open' NOT NULL,
	"gross_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"document_discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"charges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"charges_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"round_off" numeric(15, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_orders_number_uq" UNIQUE("business_id","financial_year","order_number")
);
--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN "goods_receipt_item_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN "purchase_order_item_id" uuid;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_purchase_order_item_id_purchase_order_items_id_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_series_id_document_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."document_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_series_id_document_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."document_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_receipt_items_receipt_idx" ON "goods_receipt_items" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_items_product_idx" ON "goods_receipt_items" USING btree ("business_id","product_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_items_order_idx" ON "goods_receipt_items" USING btree ("purchase_order_item_id") WHERE "goods_receipt_items"."purchase_order_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_client_id_uq" ON "goods_receipts" USING btree ("business_id","client_id") WHERE "goods_receipts"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "goods_receipts_supplier_idx" ON "goods_receipts" USING btree ("business_id","supplier_id","status");--> statement-breakpoint
CREATE INDEX "goods_receipts_date_idx" ON "goods_receipts" USING btree ("business_id","received_date");--> statement-breakpoint
CREATE INDEX "goods_receipts_order_idx" ON "goods_receipts" USING btree ("purchase_order_id") WHERE "goods_receipts"."purchase_order_id" is not null;--> statement-breakpoint
CREATE INDEX "goods_receipts_purchase_idx" ON "goods_receipts" USING btree ("purchase_id") WHERE "goods_receipts"."purchase_id" is not null;--> statement-breakpoint
CREATE INDEX "purchase_order_items_order_idx" ON "purchase_order_items" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_items_product_idx" ON "purchase_order_items" USING btree ("business_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_client_id_uq" ON "purchase_orders" USING btree ("business_id","client_id") WHERE "purchase_orders"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("business_id","supplier_id","order_date");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("business_id","status","order_date");--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_goods_receipt_item_id_goods_receipt_items_id_fk" FOREIGN KEY ("goods_receipt_item_id") REFERENCES "public"."goods_receipt_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_order_item_id_purchase_order_items_id_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_items_receipt_idx" ON "purchase_items" USING btree ("goods_receipt_item_id") WHERE "purchase_items"."goods_receipt_item_id" is not null;--> statement-breakpoint
CREATE INDEX "purchase_items_order_idx" ON "purchase_items" USING btree ("purchase_order_item_id") WHERE "purchase_items"."purchase_order_item_id" is not null;--> statement-breakpoint
-- Purchase orders, their lines, goods receipts and their lines, per business.
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON purchase_orders USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON purchase_order_items USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON goods_receipts USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE goods_receipt_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON goods_receipt_items USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
