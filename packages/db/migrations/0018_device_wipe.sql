ALTER TABLE "devices" ADD COLUMN "check_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wiped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "session_id" uuid;
--> statement-breakpoint
-- A device checking in with its secret, signed in or not: removed devices are
-- told to delete their copy. Row-level security hides every device without a
-- business chosen, so this answers only "active / removed" for the one device
-- whose secret matches (anything else is "unknown").
CREATE FUNCTION device_check(p_id uuid, p_hash text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
  DECLARE d record;
  BEGIN
    SELECT id, revoked_at, check_hash INTO d FROM devices WHERE id = p_id;
    IF d.id IS NULL OR d.check_hash IS NULL OR d.check_hash <> p_hash THEN
      RETURN 'unknown';
    END IF;
    IF d.revoked_at IS NULL THEN
      UPDATE devices SET last_seen_at = now() WHERE id = p_id;
      RETURN 'active';
    END IF;
    UPDATE devices SET wiped_at = coalesce(wiped_at, now()) WHERE id = p_id;
    RETURN 'removed';
  END
  $$;
