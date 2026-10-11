CREATE TYPE "public"."scheme_kind" AS ENUM('free_goods', 'discount');--> statement-breakpoint
CREATE TYPE "public"."scheme_measure" AS ENUM('qty', 'value');--> statement-breakpoint
CREATE TABLE "schemes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"kind" "scheme_kind" NOT NULL,
	"measure" "scheme_measure" DEFAULT 'qty' NOT NULL,
	"product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"brand_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"slabs" jsonb NOT NULL,
	"repeat" boolean DEFAULT true NOT NULL,
	"free_product_id" uuid,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"customer_category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"price_level_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"supplier_id" uuid,
	"reference" varchar(60),
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "schemes_validity_chk" CHECK ("schemes"."valid_to" is null or "schemes"."valid_to" >= "schemes"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "scheme_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "scheme_discount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "scheme_free" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD COLUMN "scheme_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD COLUMN "scheme_discount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD COLUMN "scheme_free" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "schemes" ADD CONSTRAINT "schemes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemes" ADD CONSTRAINT "schemes_free_product_id_products_id_fk" FOREIGN KEY ("free_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemes" ADD CONSTRAINT "schemes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schemes_business_idx" ON "schemes" USING btree ("business_id","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "schemes_name_uq" ON "schemes" USING btree ("business_id",lower("name"));--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_scheme_id_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."schemes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_scheme_id_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."schemes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_items_scheme_idx" ON "invoice_items" USING btree ("business_id","scheme_id") WHERE "invoice_items"."scheme_id" is not null;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_scheme_chk" CHECK ("invoice_items"."scheme_id" is not null or (not "invoice_items"."scheme_free" and "invoice_items"."scheme_discount" = 0));--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_scheme_chk" CHECK ("sales_order_items"."scheme_id" is not null or (not "sales_order_items"."scheme_free" and "sales_order_items"."scheme_discount" = 0));--> statement-breakpoint
-- Trade schemes, per business.
ALTER TABLE schemes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON schemes USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
