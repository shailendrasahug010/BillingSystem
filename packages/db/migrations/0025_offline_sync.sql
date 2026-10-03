CREATE TYPE "public"."invoice_review_status" AS ENUM('needs_review', 'reviewed');--> statement-breakpoint
CREATE TABLE "sync_changes" (
	"business_id" uuid NOT NULL,
	"entity" varchar(20) NOT NULL,
	"entity_id" uuid NOT NULL,
	"xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_changes_business_id_xid_entity_entity_id_pk" PRIMARY KEY("business_id","xid","entity","entity_id")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "queue_waiting" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "queue_bills" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "queue_refused" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "queue_oldest_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "queue_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "review_status" "invoice_review_status";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "review_reasons" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_changes_created_idx" ON "sync_changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "invoices_review_idx" ON "invoices" USING btree ("business_id","posted_at") WHERE "invoices"."review_status" = 'needs_review';--> statement-breakpoint
-- Phase 5.3. Bills made offline that broke a rule by the time they arrived are
-- held for review (invoices.review_*). The pull feed's change log follows.
ALTER TABLE sync_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sync_changes USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
-- Records that a product, customer or supplier changed in this transaction
-- (once per record per transaction). TG_ARGV[0] is the entity, TG_ARGV[1] the
-- column holding its id. SECURITY DEFINER: a change made in any context
-- (a restore, a job) is recorded, whatever the session's business.
CREATE OR REPLACE FUNCTION track_sync_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rec jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
BEGIN
  INSERT INTO sync_changes (business_id, entity, entity_id)
  VALUES ((rec ->> 'business_id')::uuid, TG_ARGV[0], (rec ->> TG_ARGV[1])::uuid)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER products_sync_change AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION track_sync_change('product', 'id');
--> statement-breakpoint
CREATE TRIGGER product_prices_sync_change AFTER INSERT OR UPDATE OR DELETE ON product_prices
  FOR EACH ROW EXECUTE FUNCTION track_sync_change('product', 'product_id');
--> statement-breakpoint
CREATE TRIGGER product_units_sync_change AFTER INSERT OR UPDATE OR DELETE ON product_units
  FOR EACH ROW EXECUTE FUNCTION track_sync_change('product', 'product_id');
--> statement-breakpoint
CREATE TRIGGER product_barcodes_sync_change AFTER INSERT OR UPDATE OR DELETE ON product_barcodes
  FOR EACH ROW EXECUTE FUNCTION track_sync_change('product', 'product_id');
--> statement-breakpoint
CREATE TRIGGER stock_balances_sync_change AFTER INSERT OR UPDATE OR DELETE ON stock_balances
  FOR EACH ROW EXECUTE FUNCTION track_sync_change('product', 'product_id');
--> statement-breakpoint
CREATE TRIGGER customers_sync_change AFTER INSERT OR UPDATE OR DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION track_sync_change('customer', 'id');
--> statement-breakpoint
CREATE TRIGGER suppliers_sync_change AFTER INSERT OR UPDATE OR DELETE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION track_sync_change('supplier', 'id');
--> statement-breakpoint
-- The tenth reminder rule, phones and PCs holding work not sent to the server, for every business.
INSERT INTO reminder_rules (business_id, type)
SELECT b.id, 'devices_unsynced' FROM businesses b
ON CONFLICT (business_id, type) DO NOTHING;
