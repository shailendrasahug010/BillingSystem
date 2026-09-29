CREATE TABLE "collection_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" varchar(10) NOT NULL,
	"note" text,
	"promised_amount" numeric(15, 2),
	"promised_on" date,
	"visited_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "collection_notes_kind_chk" CHECK ("collection_notes"."kind" in ('promise', 'note')),
	CONSTRAINT "collection_notes_promise_chk" CHECK ("collection_notes"."kind" <> 'promise' or "collection_notes"."promised_on" is not null)
);
--> statement-breakpoint
ALTER TABLE "collection_notes" ADD CONSTRAINT "collection_notes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_notes" ADD CONSTRAINT "collection_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_notes_customer_idx" ON "collection_notes" USING btree ("business_id","customer_id","created_at");--> statement-breakpoint
ALTER TABLE collection_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON collection_notes USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
