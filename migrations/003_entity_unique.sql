CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_namespace_unique
ON entities(name, namespace);
