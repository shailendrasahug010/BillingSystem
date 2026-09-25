CREATE TYPE "public"."message_channel" AS ENUM('whatsapp', 'email');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"kind" varchar(20) NOT NULL,
	"document_id" uuid,
	"document_number" varchar(40),
	"party_type" "party_type",
	"party_id" uuid,
	"party_name" text,
	"recipient" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"attachment_name" text,
	"template" jsonb,
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"provider" varchar(20),
	"provider_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "messaging_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"whatsapp_provider" varchar(20) DEFAULT 'none' NOT NULL,
	"whatsapp_number" varchar(20),
	"whatsapp_phone_number_id" varchar(40),
	"whatsapp_webhook_url" text,
	"whatsapp_secret" text,
	"whatsapp_document_template" varchar(100),
	"whatsapp_reminder_template" varchar(100),
	"whatsapp_template_language" varchar(10) DEFAULT 'en' NOT NULL,
	"email_mode" varchar(20) DEFAULT 'platform' NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_secure" boolean DEFAULT false NOT NULL,
	"smtp_user" text,
	"smtp_password" text,
	"email_from_name" varchar(100),
	"email_from_address" text,
	"email_reply_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "messaging_settings_business_uq" UNIQUE("business_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_settings" ADD CONSTRAINT "messaging_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_business_created_idx" ON "messages" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_document_idx" ON "messages" USING btree ("business_id","document_id");--> statement-breakpoint
CREATE INDEX "messages_queued_idx" ON "messages" USING btree ("business_id","status");--> statement-breakpoint
ALTER TABLE messaging_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON messaging_settings USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON messages USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
-- Built-in roles of existing businesses get the new messaging permission (new businesses get it from the defaults).
INSERT INTO role_permissions (role_id, "grant") SELECT id, 'message.*' FROM roles WHERE is_system AND key IN ('manager', 'accountant') ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, "grant") SELECT id, 'message.send' FROM roles WHERE is_system AND key = 'sales' ON CONFLICT DO NOTHING;
