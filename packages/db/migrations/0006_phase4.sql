ALTER TABLE "dispatch_orders" ALTER COLUMN "sales_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "cancelled_by" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "client_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_orders_invoice_uq" ON "dispatch_orders" USING btree ("dispatch_id","invoice_id") WHERE "dispatch_orders"."invoice_id" is not null;--> statement-breakpoint
CREATE INDEX "dispatch_orders_invoice_idx" ON "dispatch_orders" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_number_uq" ON "expenses" USING btree ("business_id","expense_number") WHERE "expenses"."expense_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_client_id_uq" ON "expenses" USING btree ("business_id","client_id") WHERE "expenses"."client_id" is not null;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_document_chk" CHECK ("dispatch_orders"."sales_order_id" is not null or "dispatch_orders"."invoice_id" is not null);--> statement-breakpoint
-- Posted expenses are cancelled (their GST rows flagged), never deleted.
CREATE TRIGGER expenses_no_delete_posted BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION forbid_delete_posted();
