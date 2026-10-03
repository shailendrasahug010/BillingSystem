CREATE TABLE "analytics_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"job" varchar(30) NOT NULL,
	"as_of" date NOT NULL,
	"status" varchar(12) DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "analytics_runs_uq" UNIQUE("business_id","job","as_of"),
	CONSTRAINT "analytics_runs_status_chk" CHECK ("analytics_runs"."status" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "suggestion_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"invoice_id" uuid,
	"shown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"added" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_stats" ADD COLUMN "associations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_stats" ADD COLUMN "as_of" date;--> statement-breakpoint
ALTER TABLE "analytics_runs" ADD CONSTRAINT "analytics_runs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_feedback" ADD CONSTRAINT "suggestion_feedback_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_feedback" ADD CONSTRAINT "suggestion_feedback_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_feedback" ADD CONSTRAINT "suggestion_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_feedback" ADD CONSTRAINT "suggestion_feedback_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suggestion_feedback_created_idx" ON "suggestion_feedback" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_business_pending_idx" ON "outbox_events" USING btree ("business_id","id") WHERE "outbox_events"."processed_at" is null;--> statement-breakpoint
ALTER TABLE analytics_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON analytics_runs USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE suggestion_feedback ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON suggestion_feedback USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
-- The businesses with outbox events waiting, for the API's outbox worker. It
-- runs without a session, and row-level security hides every business's events
-- until one is chosen; this answers only "whose events are waiting" (the events
-- are then taken and handled inside that business).
CREATE FUNCTION outbox_pending_businesses(p_now timestamptz, p_limit integer) RETURNS TABLE (business_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT e.business_id FROM outbox_events e
    WHERE e.processed_at IS NULL AND e.available_at <= p_now
    GROUP BY e.business_id ORDER BY min(e.id) LIMIT p_limit
  $$;
--> statement-breakpoint
-- The businesses due for the nightly analytics run: active ones where it is
-- past p_hour in their own time zone and no run is claimed for their current
-- date yet. Without a session, row-level security hides businesses and runs;
-- this answers only "whose turn is it" (the run is claimed and done inside
-- that business).
CREATE FUNCTION nightly_analytics_due(p_now timestamptz, p_hour integer, p_limit integer) RETURNS TABLE (business_id uuid, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT b.id, b.time_zone FROM businesses b
    WHERE b.status IN ('trial', 'active')
      AND extract(hour FROM p_now AT TIME ZONE b.time_zone) >= p_hour
      AND NOT EXISTS (
        SELECT 1 FROM analytics_runs r
        WHERE r.business_id = b.id AND r.job = 'nightly' AND r.as_of >= (p_now AT TIME ZONE b.time_zone)::date
      )
    ORDER BY b.id LIMIT p_limit
  $$;
