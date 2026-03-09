-- Enable Row Level Security on ALL public tables
-- Blocks public API access (anon key) — only postgres role can access

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    -- Create policy only if it doesn't exist
    BEGIN
      EXECUTE format(
        'CREATE POLICY "service_full_access" ON %I FOR ALL TO postgres USING (true) WITH CHECK (true)',
        tbl
      );
    EXCEPTION WHEN duplicate_object THEN
      -- Policy already exists, skip
    END;
  END LOOP;
END
$$;
