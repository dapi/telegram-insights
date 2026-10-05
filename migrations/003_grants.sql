-- Least-privilege grants for runtime roles. Roles are provisioned by
-- the infrastructure repository; tests and local setups may omit them.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_insights_archiver') THEN
    GRANT USAGE ON SCHEMA archive TO telegram_insights_archiver;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA archive TO telegram_insights_archiver;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA archive TO telegram_insights_archiver;
    GRANT USAGE ON SCHEMA search TO telegram_insights_archiver;
    GRANT SELECT ON search.cursor TO telegram_insights_archiver;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_insights_indexer') THEN
    GRANT USAGE ON SCHEMA archive TO telegram_insights_indexer;
    GRANT SELECT ON ALL TABLES IN SCHEMA archive TO telegram_insights_indexer;
    GRANT USAGE ON SCHEMA search TO telegram_insights_indexer;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA search TO telegram_insights_indexer;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_insights_reader') THEN
    GRANT USAGE ON SCHEMA archive TO telegram_insights_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA archive TO telegram_insights_reader;
    GRANT USAGE ON SCHEMA search TO telegram_insights_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA search TO telegram_insights_reader;
  END IF;
END
$$;
