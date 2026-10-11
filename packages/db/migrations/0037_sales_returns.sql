CREATE TABLE "note_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_allocations_amount_chk" CHECK ("note_allocations"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "debited" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "note_allocations" ADD CONSTRAINT "note_allocations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_allocations" ADD CONSTRAINT "note_allocations_note_id_credit_debit_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."credit_debit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_allocations" ADD CONSTRAINT "note_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_allocations_note_idx" ON "note_allocations" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "note_allocations_invoice_idx" ON "note_allocations" USING btree ("invoice_id");--> statement-breakpoint
-- Credit and debit notes set against customers' bills, per business.
ALTER TABLE note_allocations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON note_allocations USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
