CREATE TABLE "tds_challans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"period_month" varchar(7) NOT NULL,
	"deposit_date" date NOT NULL,
	"bsr_code" varchar(7) NOT NULL,
	"challan_serial" varchar(5) NOT NULL,
	"tax_amount" numeric(15, 2) NOT NULL,
	"interest" numeric(15, 2) DEFAULT '0' NOT NULL,
	"late_fee" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "tds_challans_uq" UNIQUE("business_id","deposit_date","bsr_code","challan_serial")
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_amount_chk";--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "tds_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "tds_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "tds_base" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "tds_rate" numeric(7, 3);--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "tds_challan_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tds_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tds_section" varchar(20);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tds_certificate" varchar(40);--> statement-breakpoint
ALTER TABLE "tds_challans" ADD CONSTRAINT "tds_challans_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tds_challans_period_idx" ON "tds_challans" USING btree ("business_id","period_month");--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_tds_challan_id_tds_challans_id_fk" FOREIGN KEY ("tds_challan_id") REFERENCES "public"."tds_challans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchases_tds_idx" ON "purchases" USING btree ("business_id","supplier_invoice_date") WHERE "purchases"."tds_amount" > 0;--> statement-breakpoint
CREATE INDEX "payments_tds_idx" ON "payments" USING btree ("business_id","payment_date") WHERE "payments"."tds_amount" > 0;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_tds_chk" CHECK ("purchases"."tds_amount" >= 0 and "purchases"."tds_amount" <= "purchases"."grand_total" and "purchases"."tds_base" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_chk" CHECK ("payments"."amount" > 0 and "payments"."tds_amount" >= 0 and "payments"."unallocated_amount" >= 0 and "payments"."unallocated_amount" <= "payments"."amount" + "payments"."tds_amount");