ALTER TYPE "public"."message_channel" ADD VALUE 'sms';--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "message_locale" varchar(5);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reminders_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reminders_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reminders_opt_out_by" varchar(10);--> statement-breakpoint
ALTER TABLE "reminder_rules" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "automatic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reminder_on" date;--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD COLUMN "whatsapp_template_language_hi" varchar(10);--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD COLUMN "sms_provider" varchar(20) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD COLUMN "sms_webhook_url" text;--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD COLUMN "sms_secret" text;--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD COLUMN "sms_sender_id" varchar(10);--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD COLUMN "sms_reminder_template" varchar(40);--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD COLUMN "sms_reminder_template_hi" varchar(40);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_auto_reminder_uq" ON "messages" USING btree ("business_id","party_id","reminder_on") WHERE "messages"."automatic";--> statement-breakpoint
-- The businesses with a reminder check due: an active rule whose hour (config.hour, else 10 for
-- leave_request, salary_due and customer_reminders, 9 for the rest) has come in the business's time
-- zone and that has not run since: hourly rules (orders_waiting, REMINDERS[...].hourly in
-- @digitalbahi/core) an hour after their last run (last_run_at), the others once per business day
-- (last_run_on). Without a session, row-level security hides businesses and rules; this answers
-- only "whose turn is it" (the rules are then claimed and checked inside that business).
CREATE OR REPLACE FUNCTION reminder_rules_due(p_now timestamptz, p_limit integer) RETURNS TABLE (business_id uuid, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT b.id, b.time_zone FROM businesses b
    WHERE b.status IN ('trial', 'active')
      AND EXISTS (
        SELECT 1 FROM reminder_rules r
        WHERE r.business_id = b.id AND r.is_active
          AND CASE WHEN r.type = 'orders_waiting'
                THEN r.last_run_at IS NULL OR r.last_run_at <= p_now - interval '55 minutes'
                ELSE r.last_run_on IS NULL OR r.last_run_on < (p_now AT TIME ZONE b.time_zone)::date END
          AND extract(hour FROM p_now AT TIME ZONE b.time_zone) >= coalesce(
            CASE WHEN jsonb_typeof(r.config -> 'hour') = 'number' THEN (r.config ->> 'hour')::int END,
            CASE WHEN r.type IN ('leave_request', 'salary_due', 'customer_reminders') THEN 10 ELSE 9 END)
      )
    ORDER BY b.id LIMIT p_limit
  $$;--> statement-breakpoint
-- The two new rules for businesses made before them; payment reminders to customers start switched off.
INSERT INTO reminder_rules (business_id, type, is_active)
SELECT b.id, t.type, t.active FROM businesses b CROSS JOIN (VALUES ('orders_waiting', true), ('customer_reminders', false)) AS t(type, active)
ON CONFLICT DO NOTHING;
