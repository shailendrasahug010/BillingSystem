-- Notifications (Phase 5.2). Read and dismissed state moves from the
-- notification to notification_receipts, one row per person: a notification
-- for everyone with a permission is read by each of them separately. Nothing
-- wrote notifications before this migration, so the dropped columns are empty.
CREATE TABLE "notification_receipts" (
	"notification_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "notification_receipts_notification_id_user_id_pk" PRIMARY KEY("notification_id","user_id")
);
--> statement-breakpoint
DROP INDEX "notifications_unread_idx";--> statement-breakpoint
ALTER TABLE "reminder_rules" ADD COLUMN "last_run_on" date;--> statement-breakpoint
ALTER TABLE "notification_receipts" ADD CONSTRAINT "notification_receipts_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_receipts" ADD CONSTRAINT "notification_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_receipts" ADD CONSTRAINT "notification_receipts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_receipts_user_idx" ON "notification_receipts" USING btree ("user_id","business_id");--> statement-breakpoint
CREATE INDEX "notifications_business_created_idx" ON "notifications" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at") WHERE "notifications"."user_id" is not null;--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "read_at";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "dismissed_at";--> statement-breakpoint
ALTER TABLE notification_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_receipts USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
-- Every business has its nine reminder rules (seeded for new ones since Phase 3).
INSERT INTO reminder_rules (business_id, type)
SELECT b.id, t.type FROM businesses b
CROSS JOIN (VALUES ('customer_payment_due'), ('supplier_payment_due'), ('low_stock'), ('expiring_stock'), ('pending_orders'),
                   ('to_pack'), ('to_dispatch'), ('leave_request'), ('salary_due')) AS t(type)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The businesses with a daily reminder check due: an active rule not yet run
-- on the business's current date, whose hour (config.hour, else the type's
-- default) has come in its time zone. Without a session, row-level security
-- hides businesses and rules; this answers only "whose turn is it" (the rules
-- are then claimed and checked inside that business).
CREATE FUNCTION reminder_rules_due(p_now timestamptz, p_limit integer) RETURNS TABLE (business_id uuid, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT b.id, b.time_zone FROM businesses b
    WHERE b.status IN ('trial', 'active')
      AND EXISTS (
        SELECT 1 FROM reminder_rules r
        WHERE r.business_id = b.id AND r.is_active
          AND (r.last_run_on IS NULL OR r.last_run_on < (p_now AT TIME ZONE b.time_zone)::date)
          AND extract(hour FROM p_now AT TIME ZONE b.time_zone) >= coalesce(
            CASE WHEN jsonb_typeof(r.config -> 'hour') = 'number' THEN (r.config ->> 'hour')::int END,
            CASE WHEN r.type IN ('leave_request', 'salary_due') THEN 10 ELSE 9 END)
      )
    ORDER BY b.id LIMIT p_limit
  $$;
