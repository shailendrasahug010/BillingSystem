ALTER TABLE "customers" ADD COLUMN "tcs_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tds_challans" ADD COLUMN "kind" varchar(3) DEFAULT 'tds' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tcs_goods" varchar(20);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tcs_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tcs" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tcs_challan_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tcs_challan_id_tds_challans_id_fk" FOREIGN KEY ("tcs_challan_id") REFERENCES "public"."tds_challans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_tcs_idx" ON "invoices" USING btree ("business_id","invoice_date") WHERE "invoices"."tcs_amount" > 0;--> statement-breakpoint
ALTER TABLE "tds_challans" ADD CONSTRAINT "tds_challans_kind_chk" CHECK ("tds_challans"."kind" in ('tds', 'tcs'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tcs_goods_chk" CHECK ("products"."tcs_goods" is null or "products"."tcs_goods" in ('liquor', 'tendu', 'timber_lease', 'timber', 'forest', 'scrap', 'minerals', 'motor_vehicle', 'luxury'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tcs_chk" CHECK ("invoices"."tcs_amount" >= 0 and "invoices"."tcs_amount" <= "invoices"."grand_total");