ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_recovery_codes" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_step" integer;