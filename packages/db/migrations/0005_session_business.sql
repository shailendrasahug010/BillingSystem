ALTER TABLE "refresh_tokens" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A signed-in user may READ their own memberships in any business (to list and
-- switch businesses), but may only CREATE or CHANGE memberships of the current
-- business, so a bug can never attach a user to someone else's tenant.
DROP POLICY tenant_isolation ON business_members;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON business_members
  USING (
    business_id = nullif(current_setting('app.business_id', true), '')::uuid
    OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
--> statement-breakpoint
-- The business switcher shows the user's role in each of their businesses
-- before one is selected, so a user may read the roles of their own memberships.
CREATE POLICY own_membership_roles ON roles FOR SELECT USING (
  id IN (
    SELECT bm.role_id FROM business_members bm
    WHERE bm.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND bm.is_active
  )
);
