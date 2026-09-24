CREATE TYPE "public"."adjustment_reason" AS ENUM('count_correction', 'damage', 'expiry', 'theft', 'sample', 'internal_use', 'other');--> statement-breakpoint
CREATE TYPE "public"."advance_type" AS ENUM('advance', 'loan');--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('present', 'absent', 'half_day', 'leave', 'holiday', 'week_off');--> statement-breakpoint
CREATE TYPE "public"."balance_side" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."business_gst_registration" AS ENUM('regular', 'composition', 'unregistered');--> statement-breakpoint
CREATE TYPE "public"."cheque_status" AS ENUM('pending', 'deposited', 'cleared', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('b2b', 'b2c');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('planned', 'dispatched', 'in_transit', 'delivered', 'partially_delivered', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('tax_invoice', 'bill_of_supply');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'posted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('active', 'on_notice', 'resigned', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."gst_direction" AS ENUM('outward', 'inward');--> statement-breakpoint
CREATE TYPE "public"."gst_doc_type" AS ENUM('invoice', 'credit_note', 'debit_note', 'purchase', 'purchase_credit_note', 'purchase_debit_note', 'expense');--> statement-breakpoint
CREATE TYPE "public"."gst_period_status" AS ENUM('open', 'locked', 'filed');--> statement-breakpoint
CREATE TYPE "public"."itc_eligibility" AS ENUM('eligible', 'ineligible', 'capital_goods', 'input_services');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."leave_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."note_reason" AS ENUM('sales_return', 'purchase_return', 'discount', 'rate_difference', 'damage', 'other');--> statement-breakpoint
CREATE TYPE "public"."note_type" AS ENUM('credit', 'debit');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('info', 'success', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'pending', 'confirmed', 'packing', 'packed', 'dispatched', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."packing_status" AS ENUM('in_progress', 'packed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."party_gst_registration" AS ENUM('regular', 'composition', 'unregistered', 'consumer', 'sez', 'overseas', 'deemed_export');--> statement-breakpoint
CREATE TYPE "public"."party_type" AS ENUM('customer', 'supplier', 'employee', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_account_type" AS ENUM('cash', 'bank', 'upi', 'wallet', 'card');--> statement-breakpoint
CREATE TYPE "public"."payment_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'partial', 'paid');--> statement-breakpoint
CREATE TYPE "public"."payroll_status" AS ENUM('draft', 'finalized', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."salary_calc_type" AS ENUM('fixed', 'percent_of_basic', 'per_day', 'per_hour', 'manual');--> statement-breakpoint
CREATE TYPE "public"."salary_component_type" AS ENUM('earning', 'deduction');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_type" AS ENUM('opening', 'purchase', 'purchase_return', 'sale', 'sale_return', 'adjustment_in', 'adjustment_out', 'transfer_in', 'transfer_out', 'damaged', 'expired', 'free_in', 'free_out', 'consumption');--> statement-breakpoint
CREATE TYPE "public"."supply_type" AS ENUM('intra_state', 'inter_state');--> statement-breakpoint
CREATE TYPE "public"."sync_mutation_status" AS ENUM('applied', 'rejected', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."taxability" AS ENUM('taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('draft', 'in_transit', 'received', 'cancelled');--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"gstin" varchar(15),
	"pan" varchar(10),
	"gst_registration" "business_gst_registration" DEFAULT 'regular' NOT NULL,
	"state_code" char(2) NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"pincode" varchar(6),
	"phone" varchar(15),
	"email" text,
	"logo_file_id" uuid,
	"financial_year_start_month" smallint DEFAULT 4 NOT NULL,
	"time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "businesses_fy_month_chk" CHECK ("businesses"."financial_year_start_month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" varchar(20) NOT NULL,
	"series_code" varchar(4),
	"last_sync_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_series_code_uq" UNIQUE("business_id","series_code")
);
--> statement-breakpoint
CREATE TABLE "document_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"doc_type" varchar(30) NOT NULL,
	"name" text NOT NULL,
	"pattern" text NOT NULL,
	"financial_year" varchar(9) NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"device_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "document_series_uq" UNIQUE NULLS NOT DISTINCT("business_id","doc_type","financial_year","pattern","device_id"),
	CONSTRAINT "document_series_next_chk" CHECK ("document_series"."next_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"purpose" varchar(40) NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "files_size_chk" CHECK ("files"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"business_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "settings_business_id_key_pk" PRIMARY KEY("business_id","key")
);
--> statement-breakpoint
CREATE TABLE "states" (
	"code" char(2) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_hi" text NOT NULL,
	"kind" varchar(10) NOT NULL,
	"state_tax_component" varchar(5) NOT NULL,
	"is_legacy" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mobile" varchar(15) NOT NULL,
	"email" text,
	"password_hash" text,
	"preferred_locale" varchar(10) DEFAULT 'en' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"mfa_secret_enc" text,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" varchar(20) NOT NULL,
	"address_line1" text,
	"city" text,
	"state_code" char(2),
	"pincode" varchar(6),
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "warehouses_code_uq" UNIQUE("business_id","code")
);
--> statement-breakpoint
CREATE TABLE "business_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_members_uq" UNIQUE("business_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mobile" varchar(15) NOT NULL,
	"purpose" varchar(20) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" varchar(60) PRIMARY KEY NOT NULL,
	"module" varchar(30) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"device_id" uuid,
	"ip" varchar(45),
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"grant" varchar(60) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "role_permissions_role_id_grant_pk" PRIMARY KEY("role_id","grant")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"key" varchar(40) NOT NULL,
	"name" text NOT NULL,
	"name_hi" text,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "roles_key_uq" UNIQUE("business_id","key")
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" "attendance_status" NOT NULL,
	"check_in" time,
	"check_out" time,
	"overtime_hours" numeric(15, 3) DEFAULT '0' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "attendance_day_uq" UNIQUE("employee_id","date")
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "departments_name_uq" UNIQUE("business_id","name")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_code" varchar(20) NOT NULL,
	"name" text NOT NULL,
	"mobile" varchar(15) NOT NULL,
	"email" text,
	"address_line1" text,
	"city" text,
	"state_code" char(2),
	"pincode" varchar(6),
	"joining_date" date NOT NULL,
	"exit_date" date,
	"department_id" uuid,
	"designation" text,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"monthly_salary" numeric(15, 2) DEFAULT '0' NOT NULL,
	"bank_account_name" text,
	"bank_account_number_enc" text,
	"bank_account_last4" varchar(4),
	"bank_ifsc" varchar(11),
	"pan_enc" text,
	"pan_masked" varchar(10),
	"aadhaar_enc" text,
	"aadhaar_last4" varchar(4),
	"emergency_contact_name" text,
	"emergency_contact_phone" varchar(15),
	"user_id" uuid,
	"photo_file_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employees_code_uq" UNIQUE("business_id","employee_code"),
	CONSTRAINT "employees_salary_chk" CHECK ("employees"."monthly_salary" >= 0),
	CONSTRAINT "employees_exit_chk" CHECK ("employees"."exit_date" is null or "employees"."exit_date" >= "employees"."joining_date")
);
--> statement-breakpoint
CREATE TABLE "leave_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"opening" numeric(15, 3) DEFAULT '0' NOT NULL,
	"accrued" numeric(15, 3) DEFAULT '0' NOT NULL,
	"used" numeric(15, 3) DEFAULT '0' NOT NULL,
	"adjusted" numeric(15, 3) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "leave_balances_uq" UNIQUE("employee_id","leave_type_id","year")
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"half_day" boolean DEFAULT false NOT NULL,
	"days" numeric(15, 3) NOT NULL,
	"reason" text,
	"status" "leave_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "leave_requests_dates_chk" CHECK ("leave_requests"."to_date" >= "leave_requests"."from_date"),
	CONSTRAINT "leave_requests_days_chk" CHECK ("leave_requests"."days" > 0)
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" text NOT NULL,
	"name_hi" text,
	"is_paid" boolean DEFAULT true NOT NULL,
	"annual_quota" numeric(15, 3) DEFAULT '0' NOT NULL,
	"allow_carry_forward" boolean DEFAULT false NOT NULL,
	"max_carry_forward" numeric(15, 3) DEFAULT '0' NOT NULL,
	"allow_half_day" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "leave_types_code_uq" UNIQUE("business_id","code")
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" text NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text,
	"state_code" char(2) NOT NULL,
	"pincode" varchar(6),
	"is_default_shipping" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "customer_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "customer_categories_name_uq" UNIQUE("business_id","name")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" text NOT NULL,
	"business_name" text,
	"customer_type" "customer_type" DEFAULT 'b2c' NOT NULL,
	"gst_registration" "party_gst_registration" DEFAULT 'consumer' NOT NULL,
	"mobile" varchar(15),
	"alt_mobile" varchar(15),
	"email" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state_code" char(2) NOT NULL,
	"pincode" varchar(6),
	"gstin" varchar(15),
	"pan" varchar(10),
	"credit_limit" numeric(15, 2),
	"credit_days" smallint DEFAULT 0 NOT NULL,
	"price_level_id" uuid,
	"category_id" uuid,
	"route_id" uuid,
	"sales_rep_id" uuid,
	"opening_balance" numeric(15, 2) DEFAULT '0' NOT NULL,
	"opening_balance_side" "balance_side" DEFAULT 'debit' NOT NULL,
	"opening_balance_date" date,
	"balance" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "customers_credit_limit_chk" CHECK ("customers"."credit_limit" is null or "customers"."credit_limit" >= 0),
	CONSTRAINT "customers_credit_days_chk" CHECK ("customers"."credit_days" >= 0),
	CONSTRAINT "customers_b2b_gstin_chk" CHECK ("customers"."customer_type" = 'b2c' or "customers"."gstin" is not null)
);
--> statement-breakpoint
CREATE TABLE "price_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "price_levels_name_uq" UNIQUE("business_id","name")
);
--> statement-breakpoint
CREATE TABLE "sales_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"visit_days" smallint[],
	"salesperson_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "sales_routes_name_uq" UNIQUE("business_id","name")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" text NOT NULL,
	"company_name" text,
	"gst_registration" "party_gst_registration" DEFAULT 'regular' NOT NULL,
	"mobile" varchar(15),
	"email" text,
	"gstin" varchar(15),
	"pan" varchar(10),
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state_code" char(2) NOT NULL,
	"pincode" varchar(6),
	"credit_days" smallint DEFAULT 0 NOT NULL,
	"credit_limit" numeric(15, 2),
	"opening_balance" numeric(15, 2) DEFAULT '0' NOT NULL,
	"opening_balance_side" "balance_side" DEFAULT 'credit' NOT NULL,
	"opening_balance_date" date,
	"balance" numeric(15, 2) DEFAULT '0' NOT NULL,
	"bank_account_name" text,
	"bank_account_number_enc" text,
	"bank_account_last4" varchar(4),
	"bank_ifsc" varchar(11),
	"bank_name" text,
	"upi_id" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "suppliers_credit_limit_chk" CHECK ("suppliers"."credit_limit" is null or "suppliers"."credit_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_number" varchar(40) NOT NULL,
	"mfg_date" date,
	"expiry_date" date,
	"mrp" numeric(15, 4),
	"purchase_rate" numeric(15, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "batches_uq" UNIQUE("product_id","batch_number"),
	CONSTRAINT "batches_dates_chk" CHECK ("batches"."expiry_date" is null or "batches"."mfg_date" is null or "batches"."expiry_date" >= "batches"."mfg_date")
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" varchar(20),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_id" uuid,
	"barcode" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "product_barcodes_uq" UNIQUE("business_id","barcode")
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"price_level_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"price" numeric(15, 4) NOT NULL,
	"discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "product_prices_product_id_price_level_id_unit_id_pk" PRIMARY KEY("product_id","price_level_id","unit_id"),
	CONSTRAINT "product_prices_price_chk" CHECK ("product_prices"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"conversion_factor" numeric(15, 3) NOT NULL,
	"is_default_sale" boolean DEFAULT false NOT NULL,
	"is_default_purchase" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "product_units_uq" UNIQUE("product_id","unit_id"),
	CONSTRAINT "product_units_factor_chk" CHECK ("product_units"."conversion_factor" > 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_local" text,
	"aliases" text[],
	"code" varchar(30) NOT NULL,
	"sku" varchar(40),
	"hsn_code" varchar(8),
	"tax_category_id" uuid NOT NULL,
	"brand_id" uuid,
	"category_id" uuid,
	"base_unit_id" uuid NOT NULL,
	"pack_size" text,
	"purchase_price" numeric(15, 4) DEFAULT '0' NOT NULL,
	"avg_cost" numeric(15, 4) DEFAULT '0' NOT NULL,
	"mrp" numeric(15, 4),
	"selling_price" numeric(15, 4) DEFAULT '0' NOT NULL,
	"prices_include_tax" boolean DEFAULT false NOT NULL,
	"min_stock" numeric(15, 3),
	"reorder_qty" numeric(15, 3),
	"preferred_supplier_id" uuid,
	"track_batches" boolean DEFAULT false NOT NULL,
	"track_expiry" boolean DEFAULT false NOT NULL,
	"track_serials" boolean DEFAULT false NOT NULL,
	"parent_product_id" uuid,
	"variant_attributes" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "products_prices_chk" CHECK ("products"."purchase_price" >= 0 and "products"."selling_price" >= 0 and "products"."avg_cost" >= 0),
	CONSTRAINT "products_mrp_chk" CHECK ("products"."mrp" is null or "products"."mrp" >= 0),
	CONSTRAINT "products_hsn_chk" CHECK ("products"."hsn_code" is null or "products"."hsn_code" ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$')
);
--> statement-breakpoint
CREATE TABLE "tax_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "taxability" DEFAULT 'taxable' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "tax_categories_name_uq" UNIQUE("business_id","name")
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"tax_category_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"gst_rate" numeric(7, 3) NOT NULL,
	"cess_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cess_per_unit" numeric(15, 4) DEFAULT '0' NOT NULL,
	"condition" jsonb,
	"priority" smallint DEFAULT 0 NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "tax_rates_gst_chk" CHECK ("tax_rates"."gst_rate" >= 0 and "tax_rates"."gst_rate" <= 100),
	CONSTRAINT "tax_rates_cess_chk" CHECK ("tax_rates"."cess_rate" >= 0 and "tax_rates"."cess_per_unit" >= 0),
	CONSTRAINT "tax_rates_period_chk" CHECK ("tax_rates"."effective_to" is null or "tax_rates"."effective_to" >= "tax_rates"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"symbol" varchar(10) NOT NULL,
	"uqc" varchar(3) NOT NULL,
	"decimals" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "units_symbol_uq" UNIQUE("business_id","symbol"),
	CONSTRAINT "units_decimals_chk" CHECK ("units"."decimals" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "stock_adjustment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"qty_change" numeric(15, 3) NOT NULL,
	"system_qty" numeric(15, 3),
	"unit_cost" numeric(15, 4) DEFAULT '0' NOT NULL,
	"note" text,
	CONSTRAINT "stock_adjustment_items_nonzero_chk" CHECK ("stock_adjustment_items"."qty_change" <> 0)
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"adjustment_number" varchar(30),
	"adjustment_date" date NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"reason" "adjustment_reason" NOT NULL,
	"notes" text,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_adjustments_number_uq" UNIQUE("business_id","adjustment_number")
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"batch_id" uuid,
	"qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"last_ledger_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_uq" UNIQUE NULLS NOT DISTINCT("business_id","product_id","warehouse_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"batch_id" uuid,
	"txn_date" date NOT NULL,
	"movement_type" "stock_movement_type" NOT NULL,
	"qty_in" numeric(15, 3) DEFAULT '0' NOT NULL,
	"qty_out" numeric(15, 3) DEFAULT '0' NOT NULL,
	"balance_after" numeric(15, 3) NOT NULL,
	"unit_cost" numeric(15, 4) DEFAULT '0' NOT NULL,
	"ref_type" varchar(30) NOT NULL,
	"ref_id" uuid,
	"ref_line_id" uuid,
	"ref_number" varchar(40),
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_ledger_direction_chk" CHECK ("stock_ledger"."qty_in" >= 0 and "stock_ledger"."qty_out" >= 0 and (("stock_ledger"."qty_in" > 0) <> ("stock_ledger"."qty_out" > 0)))
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"qty" numeric(15, 3) NOT NULL,
	"received_qty" numeric(15, 3),
	CONSTRAINT "stock_transfer_items_qty_chk" CHECK ("stock_transfer_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"transfer_number" varchar(30),
	"transfer_date" date NOT NULL,
	"from_warehouse_id" uuid NOT NULL,
	"to_warehouse_id" uuid NOT NULL,
	"status" "transfer_status" DEFAULT 'draft' NOT NULL,
	"notes" text,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_transfers_number_uq" UNIQUE("business_id","transfer_number"),
	CONSTRAINT "stock_transfers_distinct_chk" CHECK ("stock_transfers"."from_warehouse_id" <> "stock_transfers"."to_warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"hsn_code" varchar(8),
	"uqc" varchar(3),
	"unit_id" uuid NOT NULL,
	"conversion_factor" numeric(15, 3) DEFAULT '1' NOT NULL,
	"qty" numeric(15, 3) NOT NULL,
	"free_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"qty_base" numeric(15, 3) NOT NULL,
	"rate" numeric(15, 4) NOT NULL,
	"rate_includes_tax" boolean DEFAULT false NOT NULL,
	"gross_amount" numeric(15, 2) NOT NULL,
	"discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_share" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_value" numeric(15, 2) NOT NULL,
	"taxability" "taxability" DEFAULT 'taxable' NOT NULL,
	"tax_category_id" uuid,
	"tax_rate_id" uuid,
	"gst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cess_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(15, 2) NOT NULL,
	"batch_id" uuid,
	"batch_number" varchar(40),
	"mfg_date" date,
	"expiry_date" date,
	"mrp" numeric(15, 4),
	"landed_unit_cost" numeric(15, 4) DEFAULT '0' NOT NULL,
	"returned_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_items_qty_chk" CHECK ("purchase_items"."qty" > 0 and "purchase_items"."free_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"purchase_number" varchar(30),
	"series_id" uuid,
	"financial_year" varchar(9) NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_invoice_number" varchar(30) NOT NULL,
	"supplier_invoice_date" date NOT NULL,
	"received_date" date NOT NULL,
	"due_date" date,
	"warehouse_id" uuid NOT NULL,
	"party_name" text NOT NULL,
	"party_gstin" varchar(15),
	"party_state_code" char(2),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"place_of_supply" char(2) NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"is_reverse_charge" boolean DEFAULT false NOT NULL,
	"tax_engine_version" varchar(20) NOT NULL,
	"itc_eligibility" "itc_eligibility" DEFAULT 'eligible' NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"gross_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"document_discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"charges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"charges_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"round_off" numeric(15, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(15, 2) DEFAULT '0' NOT NULL,
	"balance_due" numeric(15, 2) DEFAULT '0' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"notes" text,
	"attachment_file_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"device_id" uuid,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchases_number_uq" UNIQUE("business_id","financial_year","purchase_number"),
	CONSTRAINT "purchases_totals_chk" CHECK ("purchases"."grand_total" >= 0 and "purchases"."amount_paid" >= 0 and "purchases"."balance_due" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dispatch_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"packing_id" uuid,
	"invoice_id" uuid,
	"delivery_sequence" smallint,
	"status" "delivery_status" DEFAULT 'dispatched' NOT NULL,
	"delivered_at" timestamp with time zone,
	"received_by" text,
	"pod_file_id" uuid,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "dispatch_orders_uq" UNIQUE("dispatch_id","sales_order_id")
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"dispatch_number" varchar(30),
	"dispatch_date" date NOT NULL,
	"vehicle_number" varchar(15),
	"driver_name" text,
	"driver_mobile" varchar(15),
	"driver_employee_id" uuid,
	"transporter_name" text,
	"transporter_gstin" varchar(15),
	"lr_number" varchar(30),
	"lr_date" date,
	"expected_delivery_date" date,
	"status" "delivery_status" DEFAULT 'planned' NOT NULL,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "dispatches_number_uq" UNIQUE("business_id","dispatch_number")
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"hsn_code" varchar(8),
	"uqc" varchar(3),
	"unit_id" uuid NOT NULL,
	"conversion_factor" numeric(15, 3) DEFAULT '1' NOT NULL,
	"qty" numeric(15, 3) NOT NULL,
	"free_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"qty_base" numeric(15, 3) NOT NULL,
	"rate" numeric(15, 4) NOT NULL,
	"rate_includes_tax" boolean DEFAULT false NOT NULL,
	"gross_amount" numeric(15, 2) NOT NULL,
	"discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_share" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_value" numeric(15, 2) NOT NULL,
	"taxability" "taxability" DEFAULT 'taxable' NOT NULL,
	"tax_category_id" uuid,
	"tax_rate_id" uuid,
	"gst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cess_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(15, 2) NOT NULL,
	"batch_id" uuid,
	"order_item_id" uuid,
	"unit_cost" numeric(15, 4) DEFAULT '0' NOT NULL,
	"returned_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "invoice_items_qty_chk" CHECK ("invoice_items"."qty" > 0 and "invoice_items"."free_qty" >= 0),
	CONSTRAINT "invoice_items_amounts_chk" CHECK ("invoice_items"."taxable_value" >= 0 and "invoice_items"."line_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_revisions_uq" UNIQUE("invoice_id","revision")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_number" varchar(16),
	"series_id" uuid,
	"financial_year" varchar(9) NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"document_kind" "document_kind" DEFAULT 'tax_invoice' NOT NULL,
	"customer_id" uuid NOT NULL,
	"party_name" text NOT NULL,
	"party_gstin" varchar(15),
	"party_state_code" char(2),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"place_of_supply" char(2) NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"is_reverse_charge" boolean DEFAULT false NOT NULL,
	"tax_engine_version" varchar(20) NOT NULL,
	"sales_order_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"price_level_id" uuid,
	"salesperson_id" uuid,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"gross_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"document_discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"charges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"charges_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"round_off" numeric(15, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(15, 2) DEFAULT '0' NOT NULL,
	"balance_due" numeric(15, 2) DEFAULT '0' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"cost_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"terms" text,
	"print_locale" varchar(10) DEFAULT 'en' NOT NULL,
	"irn" varchar(64),
	"irn_ack_number" varchar(20),
	"irn_ack_date" timestamp with time zone,
	"signed_qr_code" text,
	"eway_bill_number" varchar(12),
	"eway_bill_valid_until" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"device_id" uuid,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invoices_number_uq" UNIQUE("business_id","financial_year","invoice_number"),
	CONSTRAINT "invoices_posted_number_chk" CHECK ("invoices"."status" = 'draft' or "invoices"."invoice_number" is not null),
	CONSTRAINT "invoices_totals_chk" CHECK ("invoices"."grand_total" >= 0 and "invoices"."amount_paid" >= 0 and "invoices"."balance_due" >= 0),
	CONSTRAINT "invoices_number_format_chk" CHECK ("invoices"."invoice_number" is null or "invoices"."invoice_number" ~ '^[A-Za-z0-9/-]{1,16}$')
);
--> statement-breakpoint
CREATE TABLE "packing_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"packing_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"qty" numeric(15, 3) NOT NULL,
	"box_no" smallint,
	"scanned_barcode" varchar(64),
	CONSTRAINT "packing_items_qty_chk" CHECK ("packing_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "packings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"packing_number" varchar(30),
	"sales_order_id" uuid NOT NULL,
	"status" "packing_status" DEFAULT 'in_progress' NOT NULL,
	"box_count" smallint DEFAULT 0 NOT NULL,
	"total_weight_kg" numeric(10, 3),
	"packed_by" uuid,
	"packed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "packings_number_uq" UNIQUE("business_id","packing_number"),
	CONSTRAINT "packings_boxes_chk" CHECK ("packings"."box_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_item_id" uuid NOT NULL,
	"list_rate" numeric(15, 4) NOT NULL,
	"charged_rate" numeric(15, 4) NOT NULL,
	"reason" text,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"hsn_code" varchar(8),
	"uqc" varchar(3),
	"unit_id" uuid NOT NULL,
	"conversion_factor" numeric(15, 3) DEFAULT '1' NOT NULL,
	"qty" numeric(15, 3) NOT NULL,
	"free_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"qty_base" numeric(15, 3) NOT NULL,
	"rate" numeric(15, 4) NOT NULL,
	"rate_includes_tax" boolean DEFAULT false NOT NULL,
	"gross_amount" numeric(15, 2) NOT NULL,
	"discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_share" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_value" numeric(15, 2) NOT NULL,
	"taxability" "taxability" DEFAULT 'taxable' NOT NULL,
	"tax_category_id" uuid,
	"tax_rate_id" uuid,
	"gst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cess_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(15, 2) NOT NULL,
	"packed_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"dispatched_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"delivered_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"invoiced_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"cancelled_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "sales_order_items_qty_chk" CHECK ("sales_order_items"."qty" > 0),
	CONSTRAINT "sales_order_items_progress_chk" CHECK ("sales_order_items"."packed_qty" >= 0 and "sales_order_items"."dispatched_qty" >= 0 and "sales_order_items"."delivered_qty" >= 0 and "sales_order_items"."invoiced_qty" >= 0 and "sales_order_items"."cancelled_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"order_number" varchar(30),
	"series_id" uuid,
	"financial_year" varchar(9) NOT NULL,
	"order_date" date NOT NULL,
	"expected_delivery_date" date,
	"customer_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"price_level_id" uuid,
	"salesperson_id" uuid,
	"status" "order_status" DEFAULT 'draft' NOT NULL,
	"source" varchar(20) DEFAULT 'app' NOT NULL,
	"place_of_supply" char(2) NOT NULL,
	"gross_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"document_discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"charges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"charges_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"round_off" numeric(15, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"device_id" uuid,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sales_orders_number_uq" UNIQUE("business_id","financial_year","order_number")
);
--> statement-breakpoint
CREATE TABLE "status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_status" varchar(30),
	"to_status" varchar(30) NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_debit_note_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"hsn_code" varchar(8),
	"uqc" varchar(3),
	"unit_id" uuid NOT NULL,
	"conversion_factor" numeric(15, 3) DEFAULT '1' NOT NULL,
	"qty" numeric(15, 3) NOT NULL,
	"free_qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"qty_base" numeric(15, 3) NOT NULL,
	"rate" numeric(15, 4) NOT NULL,
	"rate_includes_tax" boolean DEFAULT false NOT NULL,
	"gross_amount" numeric(15, 2) NOT NULL,
	"discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_share" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_value" numeric(15, 2) NOT NULL,
	"taxability" "taxability" DEFAULT 'taxable' NOT NULL,
	"tax_category_id" uuid,
	"tax_rate_id" uuid,
	"gst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cess_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(15, 2) NOT NULL,
	"batch_id" uuid,
	"unit_cost" numeric(15, 4) DEFAULT '0' NOT NULL,
	"original_line_id" uuid,
	CONSTRAINT "credit_debit_note_items_qty_chk" CHECK ("credit_debit_note_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_debit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"note_type" "note_type" NOT NULL,
	"party_type" "party_type" NOT NULL,
	"customer_id" uuid,
	"supplier_id" uuid,
	"note_number" varchar(16),
	"party_note_number" varchar(30),
	"series_id" uuid,
	"financial_year" varchar(9) NOT NULL,
	"note_date" date NOT NULL,
	"reason" "note_reason" NOT NULL,
	"invoice_id" uuid,
	"purchase_id" uuid,
	"affects_stock" boolean DEFAULT false NOT NULL,
	"warehouse_id" uuid,
	"party_name" text NOT NULL,
	"party_gstin" varchar(15),
	"party_state_code" char(2),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"place_of_supply" char(2) NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"is_reverse_charge" boolean DEFAULT false NOT NULL,
	"tax_engine_version" varchar(20) NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"gross_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"document_discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxable_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"charges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"charges_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"round_off" numeric(15, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"amount_settled" numeric(15, 2) DEFAULT '0' NOT NULL,
	"settlement_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"notes" text,
	"posted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"device_id" uuid,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "credit_debit_notes_number_uq" UNIQUE("business_id","financial_year","note_type","party_type","note_number"),
	CONSTRAINT "credit_debit_notes_party_chk" CHECK (("credit_debit_notes"."party_type" = 'customer' and "credit_debit_notes"."customer_id" is not null and "credit_debit_notes"."supplier_id" is null)
       or ("credit_debit_notes"."party_type" = 'supplier' and "credit_debit_notes"."supplier_id" is not null and "credit_debit_notes"."customer_id" is null)),
	CONSTRAINT "credit_debit_notes_warehouse_chk" CHECK (not "credit_debit_notes"."affects_stock" or "credit_debit_notes"."warehouse_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "party_ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "party_ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_id" uuid NOT NULL,
	"party_type" "party_type" NOT NULL,
	"customer_id" uuid,
	"supplier_id" uuid,
	"entry_date" date NOT NULL,
	"doc_type" varchar(30) NOT NULL,
	"doc_id" uuid,
	"doc_number" varchar(40),
	"debit" numeric(15, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(15, 2) DEFAULT '0' NOT NULL,
	"narration" text,
	"reverses_entry_id" bigint,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_ledger_amount_chk" CHECK ("party_ledger_entries"."debit" >= 0 and "party_ledger_entries"."credit" >= 0 and (("party_ledger_entries"."debit" > 0) <> ("party_ledger_entries"."credit" > 0))),
	CONSTRAINT "party_ledger_party_chk" CHECK (("party_ledger_entries"."party_type" = 'customer' and "party_ledger_entries"."customer_id" is not null and "party_ledger_entries"."supplier_id" is null)
       or ("party_ledger_entries"."party_type" = 'supplier' and "party_ledger_entries"."supplier_id" is not null and "party_ledger_entries"."customer_id" is null))
);
--> statement-breakpoint
CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "payment_account_type" NOT NULL,
	"bank_name" text,
	"account_number_last4" varchar(4),
	"ifsc" varchar(11),
	"upi_id" text,
	"opening_balance" numeric(15, 2) DEFAULT '0' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "payment_accounts_name_uq" UNIQUE("business_id","name")
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid,
	"purchase_id" uuid,
	"note_id" uuid,
	"amount" numeric(15, 2) NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocated_by" uuid,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "payment_allocations_target_chk" CHECK (num_nonnulls("payment_allocations"."invoice_id", "payment_allocations"."purchase_id", "payment_allocations"."note_id") = 1),
	CONSTRAINT "payment_allocations_amount_chk" CHECK ("payment_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"payment_number" varchar(30),
	"series_id" uuid,
	"financial_year" varchar(9) NOT NULL,
	"direction" "payment_direction" NOT NULL,
	"party_type" "party_type" NOT NULL,
	"customer_id" uuid,
	"supplier_id" uuid,
	"employee_id" uuid,
	"other_party_name" text,
	"payment_date" date NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"method" "payment_method" NOT NULL,
	"payment_account_id" uuid,
	"reference_number" varchar(40),
	"cheque_date" date,
	"cheque_bank" text,
	"cheque_status" "cheque_status",
	"unallocated_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"status" "document_status" DEFAULT 'posted' NOT NULL,
	"notes" text,
	"collected_by_id" uuid,
	"receipt_file_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"device_id" uuid,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payments_number_uq" UNIQUE("business_id","financial_year","direction","payment_number"),
	CONSTRAINT "payments_amount_chk" CHECK ("payments"."amount" > 0 and "payments"."unallocated_amount" >= 0 and "payments"."unallocated_amount" <= "payments"."amount"),
	CONSTRAINT "payments_party_chk" CHECK (("payments"."party_type" = 'customer' and "payments"."customer_id" is not null)
       or ("payments"."party_type" = 'supplier' and "payments"."supplier_id" is not null)
       or ("payments"."party_type" = 'employee' and "payments"."employee_id" is not null)
       or ("payments"."party_type" = 'other'))
);
--> statement-breakpoint
CREATE TABLE "employee_advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" "advance_type" NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"issued_on" date NOT NULL,
	"installment_amount" numeric(15, 2) NOT NULL,
	"recovered_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"payment_id" uuid,
	"is_closed" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employee_advances_amount_chk" CHECK ("employee_advances"."amount" > 0 and "employee_advances"."recovered_amount" <= "employee_advances"."amount")
);
--> statement-breakpoint
CREATE TABLE "employee_salary_structure_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"structure_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "employee_salary_structure_components_uq" UNIQUE("structure_id","component_id")
);
--> statement-breakpoint
CREATE TABLE "employee_salary_structures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"basic" numeric(15, 2) NOT NULL,
	"monthly_gross" numeric(15, 2) NOT NULL,
	"overtime_rate_per_hour" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "employee_salary_structures_uq" UNIQUE("employee_id","effective_from")
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"status" "payroll_status" DEFAULT 'draft' NOT NULL,
	"total_gross" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_deductions" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_net" numeric(15, 2) DEFAULT '0' NOT NULL,
	"finalized_at" timestamp with time zone,
	"finalized_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payroll_runs_period_uq" UNIQUE("business_id","period_month")
);
--> statement-breakpoint
CREATE TABLE "salary_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"code" varchar(12) NOT NULL,
	"name" text NOT NULL,
	"name_hi" text,
	"type" "salary_component_type" NOT NULL,
	"calc_type" "salary_calc_type" DEFAULT 'fixed' NOT NULL,
	"default_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"default_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"is_prorated" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "salary_components_code_uq" UNIQUE("business_id","code")
);
--> statement-breakpoint
CREATE TABLE "salary_slip_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"salary_slip_id" uuid NOT NULL,
	"component_id" uuid,
	"advance_id" uuid,
	"label" text NOT NULL,
	"type" "salary_component_type" NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "salary_slip_lines_amount_chk" CHECK ("salary_slip_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "salary_slips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"working_days" numeric(15, 3) NOT NULL,
	"paid_days" numeric(15, 3) NOT NULL,
	"unpaid_leave_days" numeric(15, 3) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(15, 3) DEFAULT '0' NOT NULL,
	"gross_earnings" numeric(15, 2) NOT NULL,
	"total_deductions" numeric(15, 2) NOT NULL,
	"net_pay" numeric(15, 2) NOT NULL,
	"payment_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "salary_slips_uq" UNIQUE("payroll_run_id","employee_id"),
	CONSTRAINT "salary_slips_net_chk" CHECK ("salary_slips"."net_pay" = "salary_slips"."gross_earnings" - "salary_slips"."total_deductions")
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_hi" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "expense_categories_name_uq" UNIQUE("business_id","name")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"expense_number" varchar(30),
	"expense_date" date NOT NULL,
	"category_id" uuid NOT NULL,
	"paid_to" text,
	"supplier_id" uuid,
	"amount" numeric(15, 2) NOT NULL,
	"vendor_gstin" varchar(15),
	"gst_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"cgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"itc_eligibility" "itc_eligibility",
	"total_amount" numeric(15, 2) NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_account_id" uuid,
	"reference_number" varchar(40),
	"receipt_file_id" uuid,
	"notes" text,
	"status" "document_status" DEFAULT 'posted' NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "expenses_amount_chk" CHECK ("expenses"."amount" > 0 and "expenses"."total_amount" >= "expenses"."amount")
);
--> statement-breakpoint
CREATE TABLE "gst_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"key" varchar(60) NOT NULL,
	"effective_from" date NOT NULL,
	"value" jsonb NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gst_config_uq" UNIQUE NULLS NOT DISTINCT("business_id","key","effective_from")
);
--> statement-breakpoint
CREATE TABLE "gst_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"return_type" varchar(12) NOT NULL,
	"period" char(7) NOT NULL,
	"formatter_version" varchar(40) NOT NULL,
	"format" varchar(10) NOT NULL,
	"file_id" uuid,
	"summary" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_by" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_return_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"return_type" varchar(12) NOT NULL,
	"period" char(7) NOT NULL,
	"status" "gst_period_status" DEFAULT 'open' NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"filed_at" timestamp with time zone,
	"arn" varchar(30),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gst_return_periods_uq" UNIQUE("business_id","return_type","period")
);
--> statement-breakpoint
CREATE TABLE "gst_transactions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gst_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_id" uuid NOT NULL,
	"direction" "gst_direction" NOT NULL,
	"doc_type" "gst_doc_type" NOT NULL,
	"doc_id" uuid NOT NULL,
	"doc_line_id" uuid,
	"doc_number" varchar(30) NOT NULL,
	"doc_date" date NOT NULL,
	"original_doc_number" varchar(30),
	"original_doc_date" date,
	"return_period" char(7) NOT NULL,
	"party_name" text,
	"party_gstin" varchar(15),
	"party_registration" "party_gst_registration" NOT NULL,
	"party_state_code" char(2),
	"place_of_supply" char(2) NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"is_reverse_charge" boolean DEFAULT false NOT NULL,
	"taxability" "taxability" NOT NULL,
	"hsn_code" varchar(8),
	"uqc" varchar(3),
	"qty" numeric(15, 3) DEFAULT '0' NOT NULL,
	"taxable_value" numeric(15, 2) NOT NULL,
	"gst_rate" numeric(7, 3) NOT NULL,
	"cgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cess_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"document_value" numeric(15, 2) NOT NULL,
	"itc_eligibility" "itc_eligibility",
	"is_cancelled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gst_transactions_period_chk" CHECK ("gst_transactions"."return_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_id" uuid,
	"user_id" uuid,
	"user_name" text,
	"action" varchar(60) NOT NULL,
	"entity_type" varchar(40),
	"entity_id" uuid,
	"entity_label" text,
	"changes" jsonb,
	"ip" varchar(45),
	"user_agent" text,
	"device_id" uuid,
	"request_id" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" varchar(10) NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"file_id" uuid,
	"size_bytes" bigint,
	"sha256" varchar(64),
	"schema_version" varchar(40),
	"encrypted" boolean DEFAULT true NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"requested_by" uuid,
	"restored_at" timestamp with time zone,
	"restored_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"permission" varchar(60),
	"type" varchar(40) NOT NULL,
	"severity" "notification_severity" DEFAULT 'info' NOT NULL,
	"title_key" varchar(80) NOT NULL,
	"body_key" varchar(80),
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entity_type" varchar(40),
	"entity_id" uuid,
	"dedupe_key" varchar(120),
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"delivered_channels" varchar(20)[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_id" uuid NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"aggregate_type" varchar(40) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"type" varchar(40) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channels" varchar(20)[] DEFAULT '{in_app}'::varchar[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_mutations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mutation_type" varchar(40) NOT NULL,
	"entity_id" uuid,
	"base_version" integer,
	"payload_hash" varchar(64) NOT NULL,
	"status" "sync_mutation_status" NOT NULL,
	"result" jsonb,
	"client_created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_product_stats" (
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"order_count" integer NOT NULL,
	"order_share" double precision NOT NULL,
	"total_qty" numeric(15, 3) NOT NULL,
	"avg_qty" numeric(15, 3) NOT NULL,
	"last_qty" numeric(15, 3) NOT NULL,
	"last_rate" numeric(15, 4),
	"recent_qtys" numeric(15, 3)[] NOT NULL,
	"first_purchased_on" date NOT NULL,
	"last_purchased_on" date NOT NULL,
	"typical_interval_days" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_product_stats_customer_id_product_id_pk" PRIMARY KEY("customer_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "customer_stats" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"total_sales" numeric(15, 2) DEFAULT '0' NOT NULL,
	"avg_order_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"first_invoice_on" date,
	"last_invoice_on" date,
	"typical_visit_interval_days" double precision,
	"avg_days_to_pay" double precision,
	"on_time_ratio" double precision,
	"payment_rating" smallint,
	"overdue_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_associations" (
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"related_product_id" uuid NOT NULL,
	"pair_count" integer NOT NULL,
	"support" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"lift" double precision NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_associations_business_id_product_id_related_product_id_pk" PRIMARY KEY("business_id","product_id","related_product_id")
);
--> statement-breakpoint
CREATE TABLE "sales_daily_customer" (
	"business_id" uuid NOT NULL,
	"day" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"salesperson_id" uuid,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"taxable_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"collected" numeric(15, 2) DEFAULT '0' NOT NULL,
	"returns" numeric(15, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "sales_daily_customer_uq" UNIQUE NULLS NOT DISTINCT("business_id","day","customer_id","salesperson_id")
);
--> statement-breakpoint
CREATE TABLE "sales_daily_product" (
	"business_id" uuid NOT NULL,
	"day" date NOT NULL,
	"product_id" uuid NOT NULL,
	"brand_id" uuid,
	"category_id" uuid,
	"salesperson_id" uuid,
	"qty_sold" numeric(15, 3) DEFAULT '0' NOT NULL,
	"qty_returned" numeric(15, 3) DEFAULT '0' NOT NULL,
	"taxable_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"cost_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"customer_count" integer DEFAULT 0 NOT NULL,
	"qty_purchased" numeric(15, 3) DEFAULT '0' NOT NULL,
	"purchase_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "sales_daily_product_uq" UNIQUE NULLS NOT DISTINCT("business_id","day","product_id","salesperson_id")
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_series" ADD CONSTRAINT "document_series_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_series" ADD CONSTRAINT "document_series_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_photo_file_id_files_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_categories" ADD CONSTRAINT "customer_categories_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_price_level_id_price_levels_id_fk" FOREIGN KEY ("price_level_id") REFERENCES "public"."price_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_category_id_customer_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."customer_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_route_id_sales_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."sales_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_sales_rep_id_employees_id_fk" FOREIGN KEY ("sales_rep_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_levels" ADD CONSTRAINT "price_levels_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_routes" ADD CONSTRAINT "sales_routes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_routes" ADD CONSTRAINT "sales_routes_salesperson_id_employees_id_fk" FOREIGN KEY ("salesperson_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_state_code_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."states"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_product_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_price_level_id_price_levels_id_fk" FOREIGN KEY ("price_level_id") REFERENCES "public"."price_levels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_category_id_tax_categories_id_fk" FOREIGN KEY ("tax_category_id") REFERENCES "public"."tax_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_base_unit_id_units_id_fk" FOREIGN KEY ("base_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_preferred_supplier_id_suppliers_id_fk" FOREIGN KEY ("preferred_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_parent_product_id_products_id_fk" FOREIGN KEY ("parent_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_categories" ADD CONSTRAINT "tax_categories_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tax_category_id_tax_categories_id_fk" FOREIGN KEY ("tax_category_id") REFERENCES "public"."tax_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_adjustment_id_stock_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."stock_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_warehouse_id_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_series_id_document_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."document_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_packing_id_packings_id_fk" FOREIGN KEY ("packing_id") REFERENCES "public"."packings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_pod_file_id_files_id_fk" FOREIGN KEY ("pod_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_driver_employee_id_employees_id_fk" FOREIGN KEY ("driver_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_order_item_id_sales_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."sales_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_revisions" ADD CONSTRAINT "invoice_revisions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_revisions" ADD CONSTRAINT "invoice_revisions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_series_id_document_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."document_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_price_level_id_price_levels_id_fk" FOREIGN KEY ("price_level_id") REFERENCES "public"."price_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_salesperson_id_employees_id_fk" FOREIGN KEY ("salesperson_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_items" ADD CONSTRAINT "packing_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_items" ADD CONSTRAINT "packing_items_packing_id_packings_id_fk" FOREIGN KEY ("packing_id") REFERENCES "public"."packings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_items" ADD CONSTRAINT "packing_items_order_item_id_sales_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."sales_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_items" ADD CONSTRAINT "packing_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_items" ADD CONSTRAINT "packing_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packings" ADD CONSTRAINT "packings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packings" ADD CONSTRAINT "packings_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packings" ADD CONSTRAINT "packings_packed_by_employees_id_fk" FOREIGN KEY ("packed_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_invoice_item_id_invoice_items_id_fk" FOREIGN KEY ("invoice_item_id") REFERENCES "public"."invoice_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_series_id_document_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."document_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_price_level_id_price_levels_id_fk" FOREIGN KEY ("price_level_id") REFERENCES "public"."price_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_salesperson_id_employees_id_fk" FOREIGN KEY ("salesperson_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_note_items" ADD CONSTRAINT "credit_debit_note_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_note_items" ADD CONSTRAINT "credit_debit_note_items_note_id_credit_debit_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."credit_debit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_note_items" ADD CONSTRAINT "credit_debit_note_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_note_items" ADD CONSTRAINT "credit_debit_note_items_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_note_items" ADD CONSTRAINT "credit_debit_note_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_series_id_document_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."document_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_ledger_entries" ADD CONSTRAINT "party_ledger_entries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_ledger_entries" ADD CONSTRAINT "party_ledger_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_ledger_entries" ADD CONSTRAINT "party_ledger_entries_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_note_id_credit_debit_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."credit_debit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_series_id_document_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."document_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_account_id_payment_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_collected_by_id_employees_id_fk" FOREIGN KEY ("collected_by_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_structure_components" ADD CONSTRAINT "employee_salary_structure_components_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_structure_components" ADD CONSTRAINT "employee_salary_structure_components_structure_id_employee_salary_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."employee_salary_structures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_structure_components" ADD CONSTRAINT "employee_salary_structure_components_component_id_salary_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."salary_components"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_structures" ADD CONSTRAINT "employee_salary_structures_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_structures" ADD CONSTRAINT "employee_salary_structures_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_components" ADD CONSTRAINT "salary_components_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_slip_lines" ADD CONSTRAINT "salary_slip_lines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_slip_lines" ADD CONSTRAINT "salary_slip_lines_salary_slip_id_salary_slips_id_fk" FOREIGN KEY ("salary_slip_id") REFERENCES "public"."salary_slips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_slip_lines" ADD CONSTRAINT "salary_slip_lines_component_id_salary_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."salary_components"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_slip_lines" ADD CONSTRAINT "salary_slip_lines_advance_id_employee_advances_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."employee_advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_slips" ADD CONSTRAINT "salary_slips_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_slips" ADD CONSTRAINT "salary_slips_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_slips" ADD CONSTRAINT "salary_slips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_slips" ADD CONSTRAINT "salary_slips_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payment_account_id_payment_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_receipt_file_id_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_exports" ADD CONSTRAINT "gst_exports_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_exports" ADD CONSTRAINT "gst_exports_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_return_periods" ADD CONSTRAINT "gst_return_periods_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_transactions" ADD CONSTRAINT "gst_transactions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_rules" ADD CONSTRAINT "reminder_rules_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_mutations" ADD CONSTRAINT "sync_mutations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_mutations" ADD CONSTRAINT "sync_mutations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_product_stats" ADD CONSTRAINT "customer_product_stats_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_product_stats" ADD CONSTRAINT "customer_product_stats_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_product_stats" ADD CONSTRAINT "customer_product_stats_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_stats" ADD CONSTRAINT "customer_stats_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_stats" ADD CONSTRAINT "customer_stats_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_associations" ADD CONSTRAINT "product_associations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_associations" ADD CONSTRAINT "product_associations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_associations" ADD CONSTRAINT "product_associations_related_product_id_products_id_fk" FOREIGN KEY ("related_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_customer" ADD CONSTRAINT "sales_daily_customer_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_customer" ADD CONSTRAINT "sales_daily_customer_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_customer" ADD CONSTRAINT "sales_daily_customer_salesperson_id_employees_id_fk" FOREIGN KEY ("salesperson_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_product" ADD CONSTRAINT "sales_daily_product_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_product" ADD CONSTRAINT "sales_daily_product_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_product" ADD CONSTRAINT "sales_daily_product_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_product" ADD CONSTRAINT "sales_daily_product_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily_product" ADD CONSTRAINT "sales_daily_product_salesperson_id_employees_id_fk" FOREIGN KEY ("salesperson_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "businesses_gstin_idx" ON "businesses" USING btree ("gstin");--> statement-breakpoint
CREATE UNIQUE INDEX "files_storage_key_uq" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_mobile_uq" ON "users" USING btree ("mobile");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_one_default_uq" ON "warehouses" USING btree ("business_id") WHERE "warehouses"."is_default" and "warehouses"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "business_members_user_idx" ON "business_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "otp_challenges_mobile_idx" ON "otp_challenges" USING btree ("mobile","created_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_active_idx" ON "refresh_tokens" USING btree ("user_id") WHERE "refresh_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "attendance_business_date_idx" ON "attendance" USING btree ("business_id","date");--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "leave_requests_employee_idx" ON "leave_requests" USING btree ("employee_id","from_date");--> statement-breakpoint
CREATE INDEX "leave_requests_pending_idx" ON "leave_requests" USING btree ("business_id") WHERE "leave_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "customer_addresses_customer_idx" ON "customer_addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_code_uq" ON "customers" USING btree ("business_id","code") WHERE "customers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "customers_mobile_idx" ON "customers" USING btree ("business_id","mobile");--> statement-breakpoint
CREATE INDEX "customers_gstin_idx" ON "customers" USING btree ("business_id","gstin");--> statement-breakpoint
CREATE INDEX "customers_balance_idx" ON "customers" USING btree ("business_id","balance");--> statement-breakpoint
CREATE INDEX "customers_route_idx" ON "customers" USING btree ("business_id","route_id");--> statement-breakpoint
CREATE INDEX "customers_name_trgm_idx" ON "customers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_business_name_trgm_idx" ON "customers" USING gin ("business_name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "price_levels_one_default_uq" ON "price_levels" USING btree ("business_id") WHERE "price_levels"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_code_uq" ON "suppliers" USING btree ("business_id","code") WHERE "suppliers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "suppliers_gstin_idx" ON "suppliers" USING btree ("business_id","gstin");--> statement-breakpoint
CREATE INDEX "suppliers_name_trgm_idx" ON "suppliers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "batches_expiry_idx" ON "batches" USING btree ("business_id","expiry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_name_uq" ON "brands" USING btree ("business_id","name") WHERE "brands"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "product_barcodes_product_idx" ON "product_barcodes" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_name_uq" ON "product_categories" USING btree ("business_id","parent_id","name") WHERE "product_categories"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "product_images_product_idx" ON "product_images" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_code_uq" ON "products" USING btree ("business_id","code") WHERE "products"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_uq" ON "products" USING btree ("business_id","sku") WHERE "products"."deleted_at" is null and "products"."sku" is not null;--> statement-breakpoint
CREATE INDEX "products_brand_idx" ON "products" USING btree ("business_id","brand_id");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("business_id","category_id");--> statement-breakpoint
CREATE INDEX "products_hsn_idx" ON "products" USING btree ("business_id","hsn_code");--> statement-breakpoint
CREATE INDEX "products_name_trgm_idx" ON "products" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tax_rates_category_idx" ON "tax_rates" USING btree ("tax_category_id","effective_from");--> statement-breakpoint
CREATE INDEX "stock_adjustment_items_adj_idx" ON "stock_adjustment_items" USING btree ("adjustment_id");--> statement-breakpoint
CREATE INDEX "stock_balances_product_idx" ON "stock_balances" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_product_idx" ON "stock_ledger" USING btree ("business_id","product_id","warehouse_id","id");--> statement-breakpoint
CREATE INDEX "stock_ledger_ref_idx" ON "stock_ledger" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_date_idx" ON "stock_ledger" USING btree ("business_id","txn_date");--> statement-breakpoint
CREATE INDEX "stock_transfer_items_transfer_idx" ON "stock_transfer_items" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "purchase_items_purchase_idx" ON "purchase_items" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "purchase_items_product_idx" ON "purchase_items" USING btree ("business_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_supplier_bill_uq" ON "purchases" USING btree ("business_id","supplier_id","supplier_invoice_number","financial_year") WHERE "purchases"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_client_id_uq" ON "purchases" USING btree ("business_id","client_id") WHERE "purchases"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "purchases_supplier_idx" ON "purchases" USING btree ("business_id","supplier_id","supplier_invoice_date");--> statement-breakpoint
CREATE INDEX "purchases_date_idx" ON "purchases" USING btree ("business_id","received_date");--> statement-breakpoint
CREATE INDEX "purchases_open_idx" ON "purchases" USING btree ("business_id","supplier_id") WHERE "purchases"."status" = 'posted' and "purchases"."balance_due" > 0;--> statement-breakpoint
CREATE INDEX "dispatch_orders_order_idx" ON "dispatch_orders" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "dispatches_date_idx" ON "dispatches" USING btree ("business_id","dispatch_date");--> statement-breakpoint
CREATE INDEX "invoice_items_invoice_idx" ON "invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_items_product_idx" ON "invoice_items" USING btree ("business_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_client_id_uq" ON "invoices" USING btree ("business_id","client_id") WHERE "invoices"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("business_id","customer_id","invoice_date");--> statement-breakpoint
CREATE INDEX "invoices_date_idx" ON "invoices" USING btree ("business_id","invoice_date");--> statement-breakpoint
CREATE INDEX "invoices_open_idx" ON "invoices" USING btree ("business_id","customer_id","due_date") WHERE "invoices"."status" = 'posted' and "invoices"."balance_due" > 0;--> statement-breakpoint
CREATE INDEX "invoices_salesperson_idx" ON "invoices" USING btree ("business_id","salesperson_id","invoice_date");--> statement-breakpoint
CREATE INDEX "packing_items_packing_idx" ON "packing_items" USING btree ("packing_id");--> statement-breakpoint
CREATE INDEX "packings_order_idx" ON "packings" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "price_overrides_item_idx" ON "price_overrides" USING btree ("invoice_item_id");--> statement-breakpoint
CREATE INDEX "sales_order_items_order_idx" ON "sales_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_client_id_uq" ON "sales_orders" USING btree ("business_id","client_id") WHERE "sales_orders"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "sales_orders_customer_idx" ON "sales_orders" USING btree ("business_id","customer_id","order_date");--> statement-breakpoint
CREATE INDEX "sales_orders_status_idx" ON "sales_orders" USING btree ("business_id","status","order_date");--> statement-breakpoint
CREATE INDEX "status_history_entity_idx" ON "status_history" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_debit_note_items_note_idx" ON "credit_debit_note_items" USING btree ("note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_debit_notes_client_id_uq" ON "credit_debit_notes" USING btree ("business_id","client_id") WHERE "credit_debit_notes"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "credit_debit_notes_customer_idx" ON "credit_debit_notes" USING btree ("business_id","customer_id","note_date");--> statement-breakpoint
CREATE INDEX "credit_debit_notes_supplier_idx" ON "credit_debit_notes" USING btree ("business_id","supplier_id","note_date");--> statement-breakpoint
CREATE INDEX "party_ledger_customer_idx" ON "party_ledger_entries" USING btree ("business_id","customer_id","entry_date","id");--> statement-breakpoint
CREATE INDEX "party_ledger_supplier_idx" ON "party_ledger_entries" USING btree ("business_id","supplier_id","entry_date","id");--> statement-breakpoint
CREATE INDEX "party_ledger_doc_idx" ON "party_ledger_entries" USING btree ("doc_type","doc_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_purchase_idx" ON "payment_allocations" USING btree ("purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_client_id_uq" ON "payments" USING btree ("business_id","client_id") WHERE "payments"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_customer_idx" ON "payments" USING btree ("business_id","customer_id","payment_date");--> statement-breakpoint
CREATE INDEX "payments_supplier_idx" ON "payments" USING btree ("business_id","supplier_id","payment_date");--> statement-breakpoint
CREATE INDEX "payments_date_idx" ON "payments" USING btree ("business_id","payment_date","method");--> statement-breakpoint
CREATE INDEX "employee_advances_open_idx" ON "employee_advances" USING btree ("employee_id") WHERE not "employee_advances"."is_closed";--> statement-breakpoint
CREATE INDEX "salary_slip_lines_slip_idx" ON "salary_slip_lines" USING btree ("salary_slip_id");--> statement-breakpoint
CREATE INDEX "salary_slips_employee_idx" ON "salary_slips" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "expenses_date_idx" ON "expenses" USING btree ("business_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_category_idx" ON "expenses" USING btree ("business_id","category_id","expense_date");--> statement-breakpoint
CREATE INDEX "gst_exports_period_idx" ON "gst_exports" USING btree ("business_id","return_type","period");--> statement-breakpoint
CREATE INDEX "gst_transactions_period_idx" ON "gst_transactions" USING btree ("business_id","return_period","direction","doc_type");--> statement-breakpoint
CREATE INDEX "gst_transactions_doc_idx" ON "gst_transactions" USING btree ("doc_type","doc_id");--> statement-breakpoint
CREATE INDEX "gst_transactions_hsn_idx" ON "gst_transactions" USING btree ("business_id","return_period","hsn_code");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("business_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_time_idx" ON "audit_logs" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("business_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "backups_business_idx" ON "backups" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("business_id","dedupe_key") WHERE "notifications"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("business_id","user_id","created_at") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at") WHERE "outbox_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_rules_type_uq" ON "reminder_rules" USING btree ("business_id","type");--> statement-breakpoint
CREATE INDEX "sync_mutations_device_idx" ON "sync_mutations" USING btree ("device_id","received_at");--> statement-breakpoint
CREATE INDEX "customer_product_stats_last_idx" ON "customer_product_stats" USING btree ("business_id","customer_id","last_purchased_on");--> statement-breakpoint
CREATE INDEX "sales_daily_customer_idx" ON "sales_daily_customer" USING btree ("business_id","customer_id","day");--> statement-breakpoint
CREATE INDEX "sales_daily_product_brand_idx" ON "sales_daily_product" USING btree ("business_id","brand_id","day");