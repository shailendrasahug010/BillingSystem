CREATE TYPE "public"."payment_link_status" AS ENUM('created', 'partly_paid', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "gateway_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"provider_payment_id" varchar(80) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" varchar(40),
	"paid_at" timestamp with time zone NOT NULL,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_payments_amount_chk" CHECK ("gateway_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_gateway_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"provider" varchar(20) DEFAULT 'none' NOT NULL,
	"environment" varchar(10) DEFAULT 'test' NOT NULL,
	"key_id" varchar(100),
	"key_secret" text,
	"webhook_secret" text,
	"webhook_key" varchar(40),
	"payment_account_id" uuid,
	"upi_only" boolean DEFAULT false NOT NULL,
	"link_expiry_days" integer DEFAULT 15 NOT NULL,
	"links_in_reminders" boolean DEFAULT true NOT NULL,
	"last_webhook_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "payment_gateway_settings_business_uq" UNIQUE("business_id"),
	CONSTRAINT "payment_gateway_settings_webhook_key_uq" UNIQUE("webhook_key"),
	CONSTRAINT "payment_gateway_settings_provider_chk" CHECK ("payment_gateway_settings"."provider" in ('none', 'razorpay', 'cashfree')),
	CONSTRAINT "payment_gateway_settings_environment_chk" CHECK ("payment_gateway_settings"."environment" in ('test', 'live')),
	CONSTRAINT "payment_gateway_settings_expiry_chk" CHECK ("payment_gateway_settings"."link_expiry_days" between 1 and 180)
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"environment" varchar(10) NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid,
	"amount" numeric(15, 2) NOT NULL,
	"amount_paid" numeric(15, 2) DEFAULT '0' NOT NULL,
	"description" text NOT NULL,
	"provider_link_id" varchar(80) NOT NULL,
	"url" text NOT NULL,
	"status" "payment_link_status" DEFAULT 'created' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"source" varchar(10) DEFAULT 'staff' NOT NULL,
	"paid_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "payment_links_amount_chk" CHECK ("payment_links"."amount" > 0 and "payment_links"."amount_paid" >= 0),
	CONSTRAINT "payment_links_source_chk" CHECK ("payment_links"."source" in ('staff', 'reminder', 'shop'))
);
--> statement-breakpoint
ALTER TABLE "gateway_payments" ADD CONSTRAINT "gateway_payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_payments" ADD CONSTRAINT "gateway_payments_link_id_payment_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."payment_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_payments" ADD CONSTRAINT "gateway_payments_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_settings" ADD CONSTRAINT "payment_gateway_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_settings" ADD CONSTRAINT "payment_gateway_settings_payment_account_id_payment_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_payments_provider_uq" ON "gateway_payments" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX "gateway_payments_link_idx" ON "gateway_payments" USING btree ("link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_provider_uq" ON "payment_links" USING btree ("provider","provider_link_id");--> statement-breakpoint
CREATE INDEX "payment_links_customer_idx" ON "payment_links" USING btree ("business_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_links_invoice_idx" ON "payment_links" USING btree ("business_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payment_links_open_idx" ON "payment_links" USING btree ("business_id","status","expires_at");--> statement-breakpoint
-- Online payments, per business.
ALTER TABLE payment_gateway_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON payment_gateway_settings USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON payment_links USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE gateway_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON gateway_payments USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
-- The business a gateway's webhook is for, found by the random key in its address before the business is known.
CREATE FUNCTION payment_gateway_business(p_key text) RETURNS TABLE (business_id uuid, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT g.business_id, b.time_zone FROM payment_gateway_settings g
    JOIN businesses b ON b.id = g.business_id
    WHERE g.webhook_key = p_key AND b.status IN ('trial', 'active')
  $$;
--> statement-breakpoint
-- The businesses with open payment links not asked about in the last minute (the check runs across businesses).
CREATE FUNCTION payment_links_to_check(p_now timestamptz, p_limit integer) RETURNS TABLE (business_id uuid, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT b.id, b.time_zone FROM businesses b
    WHERE b.status IN ('trial', 'active')
      AND EXISTS (
        SELECT 1 FROM payment_links l
        WHERE l.business_id = b.id AND l.status IN ('created', 'partly_paid')
          AND coalesce(l.last_checked_at, l.created_at) < p_now - interval '1 minute'
      )
    ORDER BY b.id LIMIT p_limit
  $$;
