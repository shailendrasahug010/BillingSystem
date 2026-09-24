-- Run once per environment by an operator (needs CREATEROLE), after migrations:
--   psql "$DATABASE_URL" -v app_password='...' -f sql/app-role.sql
-- The API connects as vyapaar_app: a non-owner role, so row-level security applies,
-- and it cannot rewrite history in append-only tables even if a trigger were dropped.
SELECT format('CREATE ROLE vyapaar_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vyapaar_app')\gexec

GRANT USAGE ON SCHEMA public TO vyapaar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vyapaar_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vyapaar_app;

REVOKE UPDATE, DELETE ON stock_ledger, party_ledger_entries, audit_logs FROM vyapaar_app;
REVOKE DELETE ON gst_transactions FROM vyapaar_app;
-- Reference data is maintained by migrations / admin tooling only.
REVOKE INSERT, UPDATE, DELETE ON states, permissions FROM vyapaar_app;
