CREATE TYPE "public"."bank_line_status" AS ENUM('open', 'reconciled', 'ignored');--> statement-breakpoint
CREATE TABLE "account_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"transfer_date" date NOT NULL,
	"from_account_id" uuid NOT NULL,
	"to_account_id" uuid NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"reference" varchar(40),
	"notes" text,
	"status" "document_status" DEFAULT 'posted' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "account_transfers_chk" CHECK ("account_transfers"."amount" > 0 and "account_transfers"."from_account_id" <> "account_transfers"."to_account_id")
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"line_date" date NOT NULL,
	"narration" text NOT NULL,
	"reference" varchar(80),
	"amount" numeric(15, 2) NOT NULL,
	"running_balance" numeric(15, 2),
	"fingerprint" varchar(64) NOT NULL,
	"status" "bank_line_status" DEFAULT 'open' NOT NULL,
	"kind" varchar(20),
	"suggestion" jsonb,
	"payment_id" uuid,
	"expense_id" uuid,
	"transfer_id" uuid,
	"made_from_line" boolean DEFAULT false NOT NULL,
	"note" text,
	"reconciled_by" uuid,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_lines_amount_chk" CHECK ("bank_statement_lines"."amount" <> 0),
	CONSTRAINT "bank_statement_lines_kind_chk" CHECK ("bank_statement_lines"."kind" is null or "bank_statement_lines"."kind" in ('receipt', 'payment', 'bank_charge', 'interest', 'cash_deposit', 'cash_withdrawal', 'other'))
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"file_name" text,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"closing_balance" numeric(15, 2),
	"lines_added" integer DEFAULT 0 NOT NULL,
	"lines_known" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_from_account_id_payment_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_to_account_id_payment_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_payment_account_id_payment_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_transfer_id_account_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."account_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_payment_account_id_payment_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_transfers_date_idx" ON "account_transfers" USING btree ("business_id","transfer_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_lines_fingerprint_uq" ON "bank_statement_lines" USING btree ("business_id","payment_account_id","fingerprint");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_statement_idx" ON "bank_statement_lines" USING btree ("statement_id","row_no");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_account_idx" ON "bank_statement_lines" USING btree ("business_id","payment_account_id","status","line_date");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_payment_idx" ON "bank_statement_lines" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_expense_idx" ON "bank_statement_lines" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_transfer_idx" ON "bank_statement_lines" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "bank_statements_account_idx" ON "bank_statements" USING btree ("business_id","payment_account_id","period_to");--> statement-breakpoint
-- Bank statements, their lines and transfers between accounts, per business.
ALTER TABLE account_transfers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON account_transfers USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE bank_statements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON bank_statements USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON bank_statement_lines USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
