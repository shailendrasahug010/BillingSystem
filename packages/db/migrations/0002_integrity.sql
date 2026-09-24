-- Integrity rules enforced by the database itself, so that no bug, script or
-- manual query can silently corrupt money, stock or history.

-- 1. updated_at is maintained automatically on every table that has it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_set_updated_at', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 2. Ledgers and the audit log are append-only. Corrections are new rows.
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed (write a reversing entry instead)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_ledger_append_only BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER party_ledger_entries_append_only BEFORE UPDATE OR DELETE ON party_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint

-- GST register rows may only be flagged as cancelled, never edited or deleted.
CREATE OR REPLACE FUNCTION gst_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gst_transactions rows cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'is_cancelled') IS DISTINCT FROM (to_jsonb(OLD) - 'is_cancelled')
     OR (OLD.is_cancelled AND NOT NEW.is_cancelled) THEN
    RAISE EXCEPTION 'gst_transactions rows can only be marked cancelled' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER gst_transactions_guard BEFORE UPDATE OR DELETE ON gst_transactions
  FOR EACH ROW EXECUTE FUNCTION gst_transactions_guard();
--> statement-breakpoint

-- 3. Posted financial documents are cancelled (voided), never physically deleted.
CREATE OR REPLACE FUNCTION forbid_delete_posted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'posted % cannot be deleted; cancel it instead', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_no_delete_posted BEFORE DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION forbid_delete_posted();
--> statement-breakpoint
CREATE TRIGGER purchases_no_delete_posted BEFORE DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION forbid_delete_posted();
--> statement-breakpoint
CREATE TRIGGER payments_no_delete_posted BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_delete_posted();
--> statement-breakpoint
CREATE TRIGGER credit_debit_notes_no_delete_posted BEFORE DELETE ON credit_debit_notes
  FOR EACH ROW EXECUTE FUNCTION forbid_delete_posted();
--> statement-breakpoint
CREATE TRIGGER stock_adjustments_no_delete_posted BEFORE DELETE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_delete_posted();
--> statement-breakpoint

-- 4. GST period lock: once GSTR-1 for a month is locked/filed, invoices and
-- notes dated in it cannot change their tax-relevant content or be cancelled.
-- Payment fields (amount_paid, balance_due, payment_status) stay updatable.
CREATE OR REPLACE FUNCTION gst_period_locked(p_business uuid, p_date date) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM gst_return_periods
    WHERE business_id = p_business AND return_type = 'GSTR1'
      AND period = to_char(p_date, 'YYYY-MM') AND status IN ('locked', 'filed')
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invoices_period_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND gst_period_locked(OLD.business_id, OLD.invoice_date) AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
    OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.party_gstin IS DISTINCT FROM OLD.party_gstin
    OR NEW.place_of_supply IS DISTINCT FROM OLD.place_of_supply
    OR NEW.taxable_total IS DISTINCT FROM OLD.taxable_total
    OR NEW.cgst_total IS DISTINCT FROM OLD.cgst_total
    OR NEW.sgst_total IS DISTINCT FROM OLD.sgst_total
    OR NEW.igst_total IS DISTINCT FROM OLD.igst_total
    OR NEW.cess_total IS DISTINCT FROM OLD.cess_total
    OR NEW.grand_total IS DISTINCT FROM OLD.grand_total) THEN
    RAISE EXCEPTION 'GST period % is locked: issue a credit/debit note instead of changing invoice %',
      to_char(OLD.invoice_date, 'YYYY-MM'), OLD.invoice_number USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_period_lock BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_period_lock_guard();
--> statement-breakpoint

-- 5. Tenant isolation (defence in depth). The API connects as a non-owner role
-- and runs `SET LOCAL app.business_id = '<uuid>'` at the start of each
-- transaction; rows of other businesses are then invisible even if a query
-- forgets its WHERE business_id = ... clause. Migrations/owner are unaffected.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'business_id' AND tb.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('business_members', 'gst_config', 'audit_logs')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON business_members USING (
  business_id = nullif(current_setting('app.business_id', true), '')::uuid
  OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
);
--> statement-breakpoint
ALTER TABLE gst_config ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON gst_config USING (
  business_id IS NULL OR business_id = nullif(current_setting('app.business_id', true), '')::uuid
);
--> statement-breakpoint
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_logs USING (
  business_id = nullif(current_setting('app.business_id', true), '')::uuid
  OR (business_id IS NULL AND user_id = nullif(current_setting('app.user_id', true), '')::uuid)
);
