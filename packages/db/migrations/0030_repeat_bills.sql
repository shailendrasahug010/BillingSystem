CREATE TABLE "recurring_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_invoice_id" uuid,
	"frequency" varchar(10) NOT NULL,
	"anchor_day" smallint NOT NULL,
	"next_date" date NOT NULL,
	"end_date" date,
	"template" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_invoice_id" uuid,
	"bills_made" integer DEFAULT 0 NOT NULL,
	"last_tried_on" date,
	"last_error" varchar(60),
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "recurring_invoices_frequency_chk" CHECK ("recurring_invoices"."frequency" in ('weekly', 'monthly')),
	CONSTRAINT "recurring_invoices_day_chk" CHECK ("recurring_invoices"."anchor_day" between 1 and 31)
);
--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_source_invoice_id_invoices_id_fk" FOREIGN KEY ("source_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_last_invoice_id_invoices_id_fk" FOREIGN KEY ("last_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_invoices_due_idx" ON "recurring_invoices" USING btree ("business_id","is_active","next_date");--> statement-breakpoint
CREATE INDEX "recurring_invoices_customer_idx" ON "recurring_invoices" USING btree ("business_id","customer_id");--> statement-breakpoint
-- Repeat bills, per business.
ALTER TABLE recurring_invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON recurring_invoices USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
-- The businesses with a repeat bill due today in their own time zone (the job runs across businesses).
CREATE FUNCTION recurring_invoices_due(p_now timestamptz, p_limit integer) RETURNS TABLE (business_id uuid, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT b.id, b.time_zone FROM businesses b
    WHERE b.status IN ('trial', 'active')
      AND EXISTS (
        SELECT 1 FROM recurring_invoices r
        WHERE r.business_id = b.id AND r.is_active
          AND r.next_date <= (p_now AT TIME ZONE b.time_zone)::date
          AND (r.last_tried_on IS NULL OR r.last_tried_on < (p_now AT TIME ZONE b.time_zone)::date)
      )
    ORDER BY b.id LIMIT p_limit
  $$;
