ALTER TABLE "employees" ADD COLUMN "pf_member" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "eps_member" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "uan" varchar(12);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "esi_number" varchar(17);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "gender" varchar(6);--> statement-breakpoint
ALTER TABLE "salary_slips" ADD COLUMN "statutory" jsonb;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_gender_chk" CHECK ("employees"."gender" is null or "employees"."gender" in ('male', 'female', 'other'));