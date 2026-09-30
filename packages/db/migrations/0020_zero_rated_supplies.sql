ALTER TABLE "invoices" ADD COLUMN "zero_rated_type" varchar(6);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "shipping_bill_number" varchar(20);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "shipping_bill_date" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "port_code" varchar(6);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "lut_arn" varchar(20);--> statement-breakpoint
ALTER TABLE "gst_transactions" ADD COLUMN "zero_rated_type" varchar(6);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_zero_rated_chk" CHECK ("invoices"."zero_rated_type" is null or "invoices"."zero_rated_type" in ('EXPWP', 'EXPWOP', 'SEZWP', 'SEZWOP'));