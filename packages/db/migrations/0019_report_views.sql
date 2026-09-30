CREATE TABLE "report_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"report" varchar(20) NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_views" ADD CONSTRAINT "report_views_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_views" ADD CONSTRAINT "report_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_views_name_uq" ON "report_views" USING btree ("business_id","user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "report_views_shared_idx" ON "report_views" USING btree ("business_id","shared");--> statement-breakpoint
ALTER TABLE report_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON report_views USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
