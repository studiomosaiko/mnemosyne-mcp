CREATE TABLE event_log (
  id            TEXT PRIMARY KEY,
  timestamp     TEXT NOT NULL,
  agent_id      TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  data          TEXT,
  prev_hash     TEXT,
  hash          TEXT NOT NULL
);

CREATE INDEX idx_event_timestamp ON event_log(timestamp);
CREATE INDEX idx_event_target ON event_log(target_id);
CREATE INDEX idx_event_action ON event_log(action);

CREATE TRIGGER trg_event_log_append_only_update
BEFORE UPDATE ON event_log
BEGIN
  SELECT RAISE(ABORT, 'event_log is append-only');
END;

CREATE TRIGGER trg_event_log_append_only_delete
BEFORE DELETE ON event_log
BEGIN
  SELECT RAISE(ABORT, 'event_log is append-only');
END;

CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  namespace     TEXT NOT NULL DEFAULT '_',
  content       TEXT NOT NULL,
  summary       TEXT,
  content_hash  TEXT,
  category      TEXT,
  tags          TEXT,
  importance    REAL DEFAULT 0.5,
  source        TEXT,
  agent_id      TEXT,
  session_id    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  status        TEXT DEFAULT 'active',
  superseded_by TEXT,
  expires_at    TEXT,
  embedding_model   TEXT,
  embedding_version INTEGER DEFAULT 0,
  embedded_at       TEXT
);

CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_namespace ON memories(namespace);
CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_created ON memories(created_at);
CREATE INDEX idx_memories_importance ON memories(importance);
CREATE INDEX idx_memories_content_hash ON memories(content_hash);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, summary, tags,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary, tags)
  VALUES (new.rowid, new.content, new.summary, new.tags);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
  VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
  VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
  INSERT INTO memories_fts(rowid, content, summary, tags)
  VALUES (new.rowid, new.content, new.summary, new.tags);
END;

CREATE TABLE episodes (
  memory_id     TEXT PRIMARY KEY REFERENCES memories(id),
  event_type    TEXT NOT NULL,
  participants  TEXT,
  location      TEXT,
  outcome       TEXT,
  emotions      TEXT,
  duration_ms   INTEGER
);

CREATE TABLE facts (
  memory_id     TEXT PRIMARY KEY REFERENCES memories(id),
  entity_name   TEXT NOT NULL,
  entity_type   TEXT,
  fact_type     TEXT NOT NULL,
  confidence    REAL DEFAULT 0.8,
  valid_from    TEXT,
  valid_until   TEXT,
  contradicts   TEXT
);

CREATE INDEX idx_facts_entity ON facts(entity_name);

CREATE TABLE procedures (
  memory_id     TEXT PRIMARY KEY REFERENCES memories(id),
  name          TEXT NOT NULL,
  namespace     TEXT NOT NULL DEFAULT '_',
  version       INTEGER DEFAULT 1,
  steps         TEXT NOT NULL,
  prerequisites TEXT,
  triggers      TEXT,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  avg_duration_ms INTEGER,
  last_used_at  TEXT,
  last_result   TEXT
);

CREATE UNIQUE INDEX idx_procedures_name_ns ON procedures(name, namespace);
CREATE INDEX idx_procedures_ns ON procedures(namespace);

CREATE TABLE entities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  namespace     TEXT NOT NULL DEFAULT '_',
  description   TEXT,
  properties    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  status        TEXT DEFAULT 'active'
);

CREATE UNIQUE INDEX idx_entities_name_ns ON entities(name, namespace);
CREATE INDEX idx_entities_type ON entities(entity_type);

CREATE TABLE relations (
  id            TEXT PRIMARY KEY,
  from_entity   TEXT NOT NULL REFERENCES entities(id),
  to_entity     TEXT NOT NULL REFERENCES entities(id),
  relation_type TEXT NOT NULL,
  properties    TEXT,
  weight        REAL DEFAULT 1.0,
  bidirectional INTEGER DEFAULT 0,
  namespace     TEXT NOT NULL DEFAULT '_',
  created_at    TEXT NOT NULL,
  status        TEXT DEFAULT 'active'
);

CREATE INDEX idx_relations_from ON relations(from_entity);
CREATE INDEX idx_relations_to ON relations(to_entity);
CREATE INDEX idx_relations_type ON relations(relation_type);
CREATE INDEX idx_relations_ns ON relations(namespace);
CREATE UNIQUE INDEX idx_relations_unique ON relations(from_entity, to_entity, relation_type);

CREATE TRIGGER trg_relations_ns_check_insert
BEFORE INSERT ON relations
BEGIN
  SELECT CASE
    WHEN NEW.namespace != '_shared'
    AND (
      (SELECT namespace FROM entities WHERE id = NEW.from_entity) != NEW.namespace
      OR (SELECT namespace FROM entities WHERE id = NEW.to_entity) != NEW.namespace
    )
    THEN RAISE(ABORT, 'relation namespace must match both entity namespaces (or use _shared)')
  END;
END;

CREATE TRIGGER trg_relations_ns_check_update
BEFORE UPDATE OF namespace, from_entity, to_entity ON relations
BEGIN
  SELECT CASE
    WHEN NEW.namespace != '_shared'
    AND (
      (SELECT namespace FROM entities WHERE id = NEW.from_entity) != NEW.namespace
      OR (SELECT namespace FROM entities WHERE id = NEW.to_entity) != NEW.namespace
    )
    THEN RAISE(ABORT, 'relation namespace must match both entity namespaces (or use _shared)')
  END;
END;

CREATE TABLE observations (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES entities(id),
  content       TEXT NOT NULL,
  observer      TEXT,
  namespace     TEXT NOT NULL DEFAULT '_',
  observed_at   TEXT NOT NULL,
  confidence    REAL DEFAULT 0.8,
  source        TEXT,
  status        TEXT DEFAULT 'active'
);

CREATE INDEX idx_observations_entity ON observations(entity_id);
CREATE INDEX idx_observations_ns ON observations(namespace);

CREATE TRIGGER trg_observations_ns_check
BEFORE INSERT ON observations
BEGIN
  SELECT CASE
    WHEN (SELECT namespace FROM entities WHERE id = NEW.entity_id) != NEW.namespace
    THEN RAISE(ABORT, 'observation namespace must match entity namespace')
  END;
END;

CREATE TRIGGER trg_observations_ns_check_update
BEFORE UPDATE OF namespace, entity_id ON observations
BEGIN
  SELECT CASE
    WHEN (SELECT namespace FROM entities WHERE id = NEW.entity_id) != NEW.namespace
    THEN RAISE(ABORT, 'observation namespace must match entity namespace')
  END;
END;

CREATE TABLE embeddings (
  id            TEXT PRIMARY KEY,
  memory_id     TEXT NOT NULL REFERENCES memories(id),
  chunk_index   INTEGER DEFAULT 0,
  chunk_text    TEXT NOT NULL,
  vector        BLOB NOT NULL,
  model         TEXT NOT NULL,
  dimensions    INTEGER NOT NULL,
  version       INTEGER DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_embeddings_memory ON embeddings(memory_id);
CREATE INDEX idx_embeddings_model ON embeddings(model);
CREATE INDEX idx_embeddings_version ON embeddings(version);

CREATE TABLE job_queue (
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

CREATE INDEX idx_jobs_status ON job_queue(status, priority, created_at);
CREATE INDEX idx_jobs_type ON job_queue(type);

CREATE TABLE schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  applied_at    TEXT NOT NULL,
  checksum      TEXT NOT NULL
);
