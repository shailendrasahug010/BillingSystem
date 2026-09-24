ALTER TABLE "businesses" ADD COLUMN "status" varchar(12) DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "plan" varchar(30) DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_business_id" uuid;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_status_chk" CHECK ("businesses"."status" in ('trial', 'active', 'suspended', 'closed'));