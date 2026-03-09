DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'entities_name_namespace_unique'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_name_namespace_unique
      UNIQUE USING INDEX idx_entities_name_ns;
  END IF;
END $$;
