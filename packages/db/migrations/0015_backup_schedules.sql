CREATE TABLE "backup_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"frequency" varchar(10) DEFAULT 'off' NOT NULL,
	"weekday" smallint DEFAULT 0 NOT NULL,
	"hour" smallint DEFAULT 21 NOT NULL,
	"email_to" text,
	"passphrase" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" varchar(10),
	"last_error" text,
	"configured_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_schedules_business_uq" UNIQUE("business_id")
);
--> statement-breakpoint
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_schedules_due_idx" ON "backup_schedules" USING btree ("next_run_at");--> statement-breakpoint
ALTER TABLE backup_schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backup_schedules USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
-- The businesses whose automatic backup is due, for the API's scheduler. It
-- runs without a session, and row-level security hides every business's
-- schedule until one is chosen; this answers only "whose turn is it" (the
-- schedule itself is then claimed and read inside that business).
CREATE FUNCTION due_backup_schedules(p_now timestamptz, p_limit integer) RETURNS TABLE (business_id uuid, user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT s.business_id, s.configured_by FROM backup_schedules s JOIN businesses b ON b.id = s.business_id
    WHERE s.frequency <> 'off' AND s.next_run_at <= p_now AND s.configured_by IS NOT NULL AND b.status IN ('trial', 'active')
    ORDER BY s.next_run_at LIMIT p_limit
  $$;
