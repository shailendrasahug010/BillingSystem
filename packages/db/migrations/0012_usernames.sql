ALTER TABLE "users" ADD COLUMN "username" varchar(30);--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username");--> statement-breakpoint
-- Whether a member's account is also in another business. A business may set
-- the user ID and password only of accounts it alone uses (its staff), never
-- of someone who also works elsewhere. Row-level security hides other
-- businesses' memberships from the API, so this answers the one question
-- with the owner's rights and nothing more.
CREATE FUNCTION user_in_other_business(p_user uuid, p_business uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM business_members WHERE user_id = p_user AND business_id <> p_business) $$;
