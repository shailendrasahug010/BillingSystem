-- Extensions used by the schema.
-- pg_trgm: fuzzy / partial-name search on customers, suppliers and products (GIN trigram indexes).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
