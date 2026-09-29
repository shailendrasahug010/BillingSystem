ALTER TABLE "messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD COLUMN "whatsapp_status_key" varchar(40);--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD COLUMN "whatsapp_app_secret" text;--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD CONSTRAINT "messaging_settings_status_key_uq" UNIQUE("whatsapp_status_key");--> statement-breakpoint
-- The business a status callback belongs to, from the key in its address.
-- Callbacks come without a session, and row-level security hides every
-- business's settings until one is chosen; this answers only that question.
CREATE FUNCTION whatsapp_status_business(p_key text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT business_id FROM messaging_settings WHERE whatsapp_status_key = p_key $$;
