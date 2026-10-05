CREATE TABLE "order_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"key_hash" char(64) NOT NULL,
	"key_sealed" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"orders_placed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "order_links" ADD CONSTRAINT "order_links_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_links" ADD CONSTRAINT "order_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_links" ADD CONSTRAINT "order_links_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_links_key_idx" ON "order_links" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "order_links_customer_idx" ON "order_links" USING btree ("business_id","customer_id");--> statement-breakpoint
-- Order links, per business.
ALTER TABLE order_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON order_links USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
-- The link a shop opened, found by its key's hash before the business is known (the page has no sign-in).
CREATE FUNCTION order_link_find(p_key_hash text) RETURNS TABLE (id uuid, business_id uuid, customer_id uuid, owner_id uuid, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT l.id, l.business_id, l.customer_id, l.owner_id, b.time_zone FROM order_links l
    JOIN businesses b ON b.id = l.business_id
    WHERE l.key_hash = p_key_hash AND l.revoked_at IS NULL AND b.status IN ('trial', 'active')
  $$;
