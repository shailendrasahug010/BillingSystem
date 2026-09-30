ALTER TABLE "invoices" ADD COLUMN "eway_bill_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD COLUMN "irn" varchar(64);--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD COLUMN "irn_ack_number" varchar(20);--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD COLUMN "irn_ack_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD COLUMN "signed_qr_code" text;