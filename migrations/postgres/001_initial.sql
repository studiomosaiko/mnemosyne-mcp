CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS event_log (
  id          TEXT PRIMARY KEY,
  timestamp   TEXT NOT NULL,
  agent_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  data        TEXT,
  prev_hash   TEXT,
  hash        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_timestamp ON event_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_event_target ON event_log(target_id);
CREATE INDEX IF NOT EXISTS idx_event_action ON event_log(action);

CREATE OR REPLACE FUNCTION prevent_event_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'event_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_log_append_only_update ON event_log;
CREATE TRIGGER trg_event_log_append_only_update
BEFORE UPDATE ON event_log
FOR EACH ROW EXECUTE FUNCTION prevent_event_log_mutation();

DROP TRIGGER IF EXISTS trg_event_log_append_only_delete ON event_log;
CREATE TRIGGER trg_event_log_append_only_delete
BEFORE DELETE ON event_log
FOR EACH ROW EXECUTE FUNCTION prevent_event_log_mutation();

CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  namespace         TEXT NOT NULL DEFAULT '_',
  content           TEXT NOT NULL,
  summary           TEXT,
  content_hash      TEXT,
  category          TEXT,
  tags              TEXT,
  importance        DOUBLE PRECISION DEFAULT 0.5,
  source            TEXT,
  agent_id          TEXT,
  session_id        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  status            TEXT DEFAULT 'active',
  superseded_by     TEXT,
  expires_at        TEXT,
  embedding_model   TEXT,
  embedding_version INTEGER DEFAULT 0,
  embedded_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);

CREATE TABLE IF NOT EXISTS episodes (
  memory_id    TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  participants TEXT,
  location     TEXT,
  outcome      TEXT,
  emotions     TEXT,
  duration_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS facts (
  memory_id   TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  entity_type TEXT,
  fact_type   TEXT NOT NULL,
  confidence  DOUBLE PRECISION DEFAULT 0.8,
  valid_from  TEXT,
  valid_until TEXT,
  contradicts TEXT
);

CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_name);

CREATE TABLE IF NOT EXISTS procedures (
  memory_id       TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  namespace       TEXT NOT NULL DEFAULT '_',
  version         INTEGER DEFAULT 1,
  steps           TEXT NOT NULL,
  prerequisites   TEXT,
  triggers        TEXT,
  success_count   INTEGER DEFAULT 0,
  failure_count   INTEGER DEFAULT 0,
  avg_duration_ms INTEGER,
  last_used_at    TEXT,
  last_result     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_procedures_name_ns ON procedures(name, namespace);
CREATE INDEX IF NOT EXISTS idx_procedures_ns ON procedures(namespace);

CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  namespace   TEXT NOT NULL DEFAULT '_',
  description TEXT,
  properties  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  status      TEXT DEFAULT 'active'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_ns ON entities(name, namespace);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);

CREATE TABLE IF NOT EXISTS relations (
  id            TEXT PRIMARY KEY,
  from_entity   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  properties    TEXT,
  weight        DOUBLE PRECISION DEFAULT 1.0,
  bidirectional BOOLEAN DEFAULT FALSE,
  namespace     TEXT NOT NULL DEFAULT '_',
  created_at    TEXT NOT NULL,
  status        TEXT DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
CREATE INDEX IF NOT EXISTS idx_relations_ns ON relations(namespace);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique ON relations(from_entity, to_entity, relation_type);

CREATE OR REPLACE FUNCTION check_relation_namespace() RETURNS trigger AS $$
DECLARE
  from_ns TEXT;
  to_ns TEXT;
BEGIN
  SELECT namespace INTO from_ns FROM entities WHERE id = NEW.from_entity;
  SELECT namespace INTO to_ns FROM entities WHERE id = NEW.to_entity;
  IF NEW.namespace <> '_shared' AND (from_ns IS DISTINCT FROM NEW.namespace OR to_ns IS DISTINCT FROM NEW.namespace) THEN
    RAISE EXCEPTION 'relation namespace must match both entity namespaces (or use _shared)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_relations_ns_check_insert ON relations;
CREATE TRIGGER trg_relations_ns_check_insert
BEFORE INSERT ON relations
FOR EACH ROW EXECUTE FUNCTION check_relation_namespace();

DROP TRIGGER IF EXISTS trg_relations_ns_check_update ON relations;
CREATE TRIGGER trg_relations_ns_check_update
BEFORE UPDATE OF namespace, from_entity, to_entity ON relations
FOR EACH ROW EXECUTE FUNCTION check_relation_namespace();

CREATE TABLE IF NOT EXISTS observations (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  observer    TEXT,
  namespace   TEXT NOT NULL DEFAULT '_',
  observed_at TEXT NOT NULL,
  confidence  DOUBLE PRECISION DEFAULT 0.8,
  source      TEXT,
  status      TEXT DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_observations_ns ON observations(namespace);

CREATE OR REPLACE FUNCTION check_observation_namespace() RETURNS trigger AS $$
DECLARE
  entity_ns TEXT;
BEGIN
  SELECT namespace INTO entity_ns FROM entities WHERE id = NEW.entity_id;
  IF entity_ns IS DISTINCT FROM NEW.namespace THEN
    RAISE EXCEPTION 'observation namespace must match entity namespace';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_observations_ns_check ON observations;
CREATE TRIGGER trg_observations_ns_check
BEFORE INSERT ON observations
FOR EACH ROW EXECUTE FUNCTION check_observation_namespace();

DROP TRIGGER IF EXISTS trg_observations_ns_check_update ON observations;
CREATE TRIGGER trg_observations_ns_check_update
BEFORE UPDATE OF namespace, entity_id ON observations
FOR EACH ROW EXECUTE FUNCTION check_observation_namespace();

CREATE TABLE IF NOT EXISTS embeddings (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  chunk_index INTEGER DEFAULT 0,
  chunk_text  TEXT NOT NULL,
  vector      vector(512) NOT NULL,
  model       TEXT NOT NULL,
  dimensions  INTEGER NOT NULL,
  version     INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embeddings_memory ON embeddings(memory_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
CREATE INDEX IF NOT EXISTS idx_embeddings_version ON embeddings(version);

CREATE TABLE IF NOT EXISTS purge_tombstones (
  target_id   TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  purged_at   TEXT NOT NULL,
  reason_hmac TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_queue (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT DEFAULT 'pending',
  priority      INTEGER DEFAULT 0,
  attempts      INTEGER DEFAULT 0,
  max_attempts  INTEGER DEFAULT 3,
  error         TEXT,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT,
  next_retry_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_queue(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON job_queue(type);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version   INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum  TEXT NOT NULL
);
