-- SaaS tenancy: the businesses table itself is also isolated. The API role can
-- see a business only when it is the current one (app.business_id) or when the
-- signed-in user (app.user_id) is an active member of it; it can only create
-- or change the current business.
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON businesses
  USING (
    id = nullif(current_setting('app.business_id', true), '')::uuid
    OR id IN (
      SELECT bm.business_id FROM business_members bm
      WHERE bm.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND bm.is_active
    )
  )
  WITH CHECK (id = nullif(current_setting('app.business_id', true), '')::uuid);
