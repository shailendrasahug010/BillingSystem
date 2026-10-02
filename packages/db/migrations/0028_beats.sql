CREATE TABLE "customer_visits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"route_id" uuid,
	"user_id" uuid NOT NULL,
	"visit_date" date NOT NULL,
	"outcome" varchar(12) NOT NULL,
	"reason" varchar(20),
	"note" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"visited_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_visits_outcome_chk" CHECK ("customer_visits"."outcome" in ('visited', 'no_order')),
	CONSTRAINT "customer_visits_reason_chk" CHECK ("customer_visits"."outcome" <> 'no_order' or "customer_visits"."reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "route_sequence" integer;--> statement-breakpoint
ALTER TABLE "customer_visits" ADD CONSTRAINT "customer_visits_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_visits" ADD CONSTRAINT "customer_visits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_visits" ADD CONSTRAINT "customer_visits_route_id_sales_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."sales_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_visits" ADD CONSTRAINT "customer_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_visits_day_idx" ON "customer_visits" USING btree ("business_id","visit_date","user_id");--> statement-breakpoint
CREATE INDEX "customer_visits_customer_idx" ON "customer_visits" USING btree ("business_id","customer_id","visit_date");--> statement-breakpoint
-- Phase 5.4: salespeople's calls on their beat, per business.
ALTER TABLE customer_visits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON customer_visits USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
