ALTER TABLE "sales_orders" ADD COLUMN "quotation_number" varchar(30);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "challan_number" varchar(30);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "challan_date" date;