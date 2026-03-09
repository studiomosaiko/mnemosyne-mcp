# 🧠 Mnemosyne — MCP Memory Server v4

> "Onde nada se perde."

A memória mais completa para agentes de IA do mercado. Inspirada na cognição humana, construída para o protocolo MCP.

**Versão do plano:** 4.0 — quarta revisão, zero débitos técnicos arquiteturais.

---

## 1. Visão

Um servidor MCP que dá aos agentes o que eles nunca tiveram: **memória real**. Não cache, não contexto temporário — memória persistente, semântica, relacional e temporal.

**Princípio zero:** qualquer dado que entra na Mnemosyne **nunca é perdido**. Pode ser arquivado, pode decair em relevância, mas o dado bruto existe para sempre. Campos mutáveis são rastreados via event log imutável.

**Exceção ao princípio zero (LGPD/GDPR):** `memory_purge` permite hard delete com audit trail criptografado, para compliance com direito ao esquecimento.

**Público-alvo:** qualquer agente de IA que fale MCP — Claude, GPT, Gemini, agentes custom. A memória é agnóstica ao modelo.

**Duas edições:**
- **Mnemosyne Personal** — SQLite, zero-config, local-first. Para um agente, uso pessoal, desenvolvimento.
- **Mnemosyne Server** — Postgres + Redis, multi-agent, HTTP/SSE. Para produção, equipes, SaaS.

Mesma API MCP, mesmo código, backend diferente via **Storage Driver abstraction**.

---

## 2. Arquitetura Geral

```
┌──────────────────────────────────────────────────────────────┐
│                        MNEMOSYNE                              │
│                    MCP Memory Server                          │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   MCP TRANSPORT LAYER                    │ │
│  │              stdio (local) | HTTP/SSE (remoto)           │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                   │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │                   TOOL ROUTER                            │ │
│  │         Recebe chamadas MCP → roteia para engines        │ │
│  │         Auth + rate limiting + logging                   │ │
│  └──┬──────────┬──────────┬──────────┬────────────────────┘ │
│     │          │          │          │                       │
│  ┌──▼───┐  ┌──▼───┐  ┌──▼───┐  ┌──▼──────────────────┐   │
│  │EPISOD│  │SEMANT│  │PROCED│  │ KNOWLEDGE GRAPH     │   │
│  │  IC  │  │  IC  │  │ URAL │  │                     │   │
│  │Engine│  │Engine│  │Engine│  │ Entity Manager      │   │
│  │      │  │      │  │      │  │ Relation Manager    │   │
│  │      │  │      │  │      │  │ Graph Traversal     │   │
│  └──┬───┘  └──┬───┘  └──┬───┘  └──┬──────────────────┘   │
│     │         │         │          │                       │
│  ┌──▼─────────▼─────────▼──────────▼──────────────────┐   │
│  │              HYBRID SEARCH ENGINE                    │   │
│  │                                                      │   │
│  │  Vector Search ──┐                                   │   │
│  │  Full-Text Search┼── Score Fusion → Ranked Results   │   │
│  │  Graph Traversal ┤                                   │   │
│  │  Structured Query┘                                   │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                         │                                   │
│  ┌──────────────────────▼──────────────────────────────┐   │
│  │         STORAGE DRIVER ABSTRACTION                   │   │
│  │                                                      │   │
│  │  ┌─────────────────┐    ┌──────────────────────┐    │   │
│  │  │ PERSONAL MODE   │    │ SERVER MODE          │    │   │
│  │  │                 │    │                      │    │   │
│  │  │ SQLite + WAL    │    │ Postgres + pgvector  │    │   │
│  │  │ sqlite-vec      │    │ Redis (queue/cache)  │    │   │
│  │  │ FTS5            │    │ S3/Supabase Storage  │    │   │
│  │  │ Filesystem blobs│    │ Supabase Auth        │    │   │
│  │  │ In-memory queue │    │ BullMQ job queue     │    │   │
│  │  └─────────────────┘    └──────────────────────┘    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              BACKGROUND SERVICES                      │   │
│  │                                                       │   │
│  │  ┌──────────────┐  ┌─────────────┐  ┌────────────┐  │   │
│  │  │ Consolidation│  │ Embedding   │  │ Backup     │  │   │
│  │  │ Engine       │  │ Pipeline    │  │ Manager    │  │   │
│  │  │              │  │             │  │            │  │   │
│  │  │ LLM-powered  │  │ Durable Q   │  │ Snapshots  │  │   │
│  │  │ Incremental  │  │ Chunking    │  │ Restore    │  │   │
│  │  │ Continuous   │  │ Re-embed    │  │ Rotation   │  │   │
│  │  └──────────────┘  └─────────────┘  └────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              EVENT LOG (truly append-only)             │   │
│  │                                                       │   │
│  │  Cada mutação gera um evento imutável.                │   │
│  │  Campos mutáveis (status, accessed_at) rastreados.    │   │
│  │  Hash chain para tamper detection.                    │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Storage Driver Abstraction

A abstração de storage é implementada desde o dia 1. Todo acesso a dados passa por interfaces, nunca por queries diretas.

A interface é composta por **5 sub-interfaces independentes**, cada uma substituível separadamente:

```typescript
// Sub-interface 1a: Memórias (CRUD + busca estruturada + FTS)
interface MemoryStore {
  create(memory: MemoryInput): Promise<Memory>;
  get(id: string): Promise<Memory | null>;
  update(id: string, fields: Partial<Memory>): Promise<void>;
  search(query: StructuredQuery): Promise<Memory[]>;
  textSearch(query: string, options: TextSearchOptions): Promise<ScoredMemory[]>;
  purge(id: string): Promise<void>;
}

// Sub-interface 1b: Knowledge Graph (entidades, relações, observações)
interface GraphStore {
  createEntity(entity: EntityInput): Promise<Entity>;
  updateEntity(id: string, fields: Partial<Entity>): Promise<void>;
  createRelation(relation: RelationInput): Promise<Relation>;
  addObservation(obs: ObservationInput): Promise<Observation>;
  traverse(start: string, options: TraversalOptions): Promise<GraphResult>;
  searchEntities(query: EntityQuery): Promise<Entity[]>;
  searchRelations(query: RelationQuery): Promise<Relation[]>;
  purgeEntity(id: string): Promise<void>;
}

// Sub-interface 1c: Lifecycle (inicialização, backup, migrations)
interface LifecycleManager {
  initialize(): Promise<void>;
  backup(label?: string): Promise<string>;
  restore(backupId: string): Promise<void>;
  migrate(): Promise<MigrationResult>;
  close(): Promise<void>;
}

// Sub-interface 2: Busca vetorial
interface VectorStore {
  store(memoryId: string, chunkIndex: number, embedding: EmbeddingData): Promise<void>;
  search(embedding: number[], options: VectorSearchOptions): Promise<ScoredMemory[]>;
  delete(memoryId: string): Promise<void>;
  reindex(filter: ReindexFilter): Promise<number>;
}

// Sub-interface 3: Fila de jobs
interface JobQueue {
  enqueue(job: Job): Promise<string>;
  dequeue(): Promise<Job | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  retry(id: string): Promise<void>;
  stats(): Promise<QueueStats>;
}

// Sub-interface 4: Blobs
interface BlobStore {
  store(data: Buffer, metadata: BlobMetadata): Promise<string>;
  get(id: string): Promise<Buffer>;
  delete(id: string): Promise<void>;
  list(filter?: BlobFilter): Promise<BlobInfo[]>;
}

// Sub-interface 5: Event log
interface EventLog {
  append(event: Event): Promise<void>;
  query(filter: EventFilter): Promise<Event[]>;
  verify(): Promise<{ valid: boolean; brokenAt?: string }>;  // verificar hash chain
}

// Composição: o backend é a combinação de 7 sub-interfaces
interface MnemosyneBackend {
  memories: MemoryStore;
  graph: GraphStore;
  vectors: VectorStore;
  queue: JobQueue;
  blobs: BlobStore;
  events: EventLog;
  lifecycle: LifecycleManager;
}
```

**Vantagem:** Cada sub-interface pode ser implementada por um provider diferente. Exemplo:

```
Personal Mode:
  memories  → SqliteMemoryStore
  graph     → SqliteGraphStore
  vectors   → SqliteVecStore
  queue     → SqliteJobQueue
  blobs     → FilesystemBlobStore
  events    → SqliteEventLog
  lifecycle → SqliteLifecycle

Server Mode:
  memories  → PostgresMemoryStore
  graph     → PostgresGraphStore
  vectors   → PgVectorStore
  queue     → RedisJobQueue (BullMQ)
  blobs     → S3BlobStore
  events    → PostgresEventLog
  lifecycle → PostgresLifecycle

Hybrid Mode (upgrade path):
  memories  → PostgresMemoryStore
  graph     → PostgresGraphStore
  vectors   → QdrantVectorStore      ← Qdrant dedicado
  queue     → RedisJobQueue
  blobs     → SupabaseStorageBlobStore
  events    → PostgresEventLog
  lifecycle → PostgresLifecycle
```
```

### Implementações:

| Driver | Componentes | Use case |
|---|---|---|
| `SqliteDriver` | better-sqlite3, sqlite-vec, FTS5, filesystem | Personal, local, dev |
| `PostgresDriver` | pg + pgvector + Redis/BullMQ + S3 | Server, multi-agent, produção |
| `TursoDriver` | libSQL (SQLite-compatible, replicação) | Upgrade path do Personal |

---

## 4. Modelo de Dados

### 4.1 Event Log — A Verdadeira Fonte Imutável

Toda mutação gera um evento no event log. Esta é a única tabela verdadeiramente append-only.

**LGPD/GDPR Safe:** O event log **NUNCA** armazena conteúdo de dados pessoais. O campo `data` contém apenas metadados estruturais (campos alterados, IDs referenciados), nunca o conteúdo em si. Isso garante que `memory_purge` efetivamente elimina os dados pessoais sem deixar rastro no event log.

```sql
CREATE TABLE event_log (
  id            TEXT PRIMARY KEY,          -- ulid
  timestamp     TEXT NOT NULL,             -- ISO 8601
  agent_id      TEXT,
  action        TEXT NOT NULL,             -- 'create' | 'update' | 'archive' | 'purge' | 'search' | 'consolidate'
  target_type   TEXT NOT NULL,             -- 'memory' | 'entity' | 'relation' | 'observation'
  target_id     TEXT NOT NULL,
  data          TEXT,                      -- JSON: metadados estruturais APENAS (campos alterados, não conteúdo)
  prev_hash     TEXT,                      -- hash do evento anterior (tamper detection)
  hash          TEXT NOT NULL              -- SHA-256(id + timestamp + action + target_id + data + prev_hash)
);

CREATE INDEX idx_event_timestamp ON event_log(timestamp);
CREATE INDEX idx_event_target ON event_log(target_id);
CREATE INDEX idx_event_action ON event_log(action);
```

**O que `data` contém por ação:**

| Ação | Conteúdo de `data` |
|------|-------------------|
| create | `{"type":"episode","namespace":"sirius","tags":["..."],"importance":0.8}` — metadados, sem content |
| update | `{"fields_changed":["status","importance"],"old_status":"active","new_status":"archived"}` |
| purge | `{"reason_hmac":"hmac(motivo,salt)","records_purged":3,"content_hmac":"hmac(conteúdo,salt)"}` — salt descartado |
| search | `{"results_count":5,"time_ms":42}` — queries não são armazenadas (podem conter PII) |
| consolidate | `{"episodes_processed":50,"facts_created":12,"dedup_merged":3}` |

**Princípio:** O event log é auditável e rastreável sem expor dados pessoais. No purge, guarda-se apenas o hash do conteúdo deletado (prova de que existiu, sem revelar o que era).

**Hash com salt (anti-reidentificação):** Hashes de conteúdo purgado usam HMAC-SHA256 com salt aleatório por purge operation. Mesmo conteúdo de baixa entropia (ex: "sim", "não") gera hashes únicos e não-reidentificáveis. O salt é descartado após o purge — o hash serve apenas como prova de existência, não como lookup.

### 4.2 Tabela `memories` — Dados operacionais (mutável)

```sql
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,          -- ulid (ordenável por tempo)
  type          TEXT NOT NULL,             -- 'episode' | 'fact' | 'procedure' | 'blob_ref'
  namespace     TEXT NOT NULL DEFAULT '_', -- namespace do agente (multi-agent)
  
  -- Conteúdo
  content       TEXT NOT NULL,
  summary       TEXT,
  content_hash  TEXT,
  
  -- Classificação
  category      TEXT,
  tags          TEXT,                      -- JSON array
  importance    REAL DEFAULT 0.5,
  
  -- Contexto
  source        TEXT,
  agent_id      TEXT,
  session_id    TEXT,
  
  -- Temporal (imutáveis)
  created_at    TEXT NOT NULL,
  
  -- Temporal (mutáveis — rastreados via event_log)
  updated_at    TEXT NOT NULL,
  
  -- Lifecycle
  status        TEXT DEFAULT 'active',     -- 'active' | 'archived' | 'consolidated' | 'superseded' | 'purged'
  superseded_by TEXT,
  expires_at    TEXT,
  
  -- Embedding
  embedding_model   TEXT,
  embedding_version INTEGER DEFAULT 0,     -- incrementa no re-embed
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
```

**Mudança vs v1:** `accessed_at` e `access_count` removidos da tabela principal. Acessos são registrados apenas no event_log, eliminando write-on-read que causava lock contention.

### 4.3 Tabelas de detalhe (episodes, facts, procedures)

```sql
CREATE TABLE episodes (
  memory_id     TEXT PRIMARY KEY REFERENCES memories(id),
  event_type    TEXT NOT NULL,
  participants  TEXT,                      -- JSON array
  location      TEXT,
  outcome       TEXT,
  emotions      TEXT,                      -- JSON array
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
  namespace     TEXT NOT NULL DEFAULT '_', -- isolamento por namespace
  version       INTEGER DEFAULT 1,
  steps         TEXT NOT NULL,             -- JSON array
  prerequisites TEXT,                      -- JSON array
  triggers      TEXT,                      -- JSON array
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  avg_duration_ms INTEGER,
  last_used_at  TEXT,
  last_result   TEXT
);

CREATE UNIQUE INDEX idx_procedures_name_ns ON procedures(name, namespace); -- único por namespace, não global
CREATE INDEX idx_procedures_ns ON procedures(namespace);
```

### 4.4 Knowledge Graph

```sql
CREATE TABLE entities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  namespace     TEXT NOT NULL DEFAULT '_',
  description   TEXT,
  properties    TEXT,                      -- JSON object
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
  namespace     TEXT NOT NULL DEFAULT '_', -- isolamento por namespace
  created_at    TEXT NOT NULL,
  status        TEXT DEFAULT 'active'
);

CREATE INDEX idx_relations_from ON relations(from_entity);
CREATE INDEX idx_relations_to ON relations(to_entity);
CREATE INDEX idx_relations_type ON relations(relation_type);
CREATE INDEX idx_relations_ns ON relations(namespace);
CREATE UNIQUE INDEX idx_relations_unique ON relations(from_entity, to_entity, relation_type);

-- Constraint: relações só entre entidades do mesmo namespace (ou _shared)
-- Cobre INSERT e UPDATE de namespace, from_entity, to_entity
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
  namespace     TEXT NOT NULL DEFAULT '_', -- isolamento por namespace
  observed_at   TEXT NOT NULL,
  confidence    REAL DEFAULT 0.8,
  source        TEXT,
  status        TEXT DEFAULT 'active'
);

CREATE INDEX idx_observations_entity ON observations(entity_id);
CREATE INDEX idx_observations_ns ON observations(namespace);

-- Constraint de consistência: namespace da observation DEVE ser igual ao da entity referenciada.
-- Enforced via trigger (SQLite não suporta CHECK com subquery cross-table).
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
```

**Mudança vs v1:** Relações agora têm `namespace` — isolamento entre agentes no grafo, sem vazamento semântico.

### 4.5 Embeddings com Chunking e Versionamento

```sql
CREATE TABLE embeddings (
  id            TEXT PRIMARY KEY,          -- ulid
  memory_id     TEXT NOT NULL REFERENCES memories(id),
  chunk_index   INTEGER DEFAULT 0,         -- 0 = summary/title, 1+ = chunks do body
  chunk_text    TEXT NOT NULL,             -- o texto que foi embeddado
  vector        BLOB NOT NULL,
  model         TEXT NOT NULL,
  dimensions    INTEGER NOT NULL,
  version       INTEGER DEFAULT 1,         -- incrementa no re-embed
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_embeddings_memory ON embeddings(memory_id);
CREATE INDEX idx_embeddings_model ON embeddings(model);
CREATE INDEX idx_embeddings_version ON embeddings(version);
```

**Mudança vs v1:**
- Múltiplos embeddings por memória (chunking)
- `chunk_text` registra exatamente o que foi embeddado
- `version` permite re-embedding incremental
- Relações textualizadas também são embeddadas (ex: "Vinicius → works_at → Arcahub")

### 4.6 Job Queue (durável)

```sql
CREATE TABLE job_queue (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,             -- 'embed' | 'consolidate' | 're-embed' | 'backup'
  payload       TEXT NOT NULL,             -- JSON
  status        TEXT DEFAULT 'pending',    -- 'pending' | 'processing' | 'completed' | 'failed'
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
```

**Mudança vs v1:** Queue agora é durável (persiste no banco). Se o processo morre, jobs não se perdem. No Server mode, substitui por Redis/BullMQ.

### 4.7 Schema Migrations

```sql
CREATE TABLE schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  applied_at    TEXT NOT NULL,
  checksum      TEXT NOT NULL
);
```

Migrations versionadas em arquivos SQL sequenciais:
```
migrations/
  001_initial.sql
  002_add_chunking.sql
  003_add_job_queue.sql
  ...
```

---

## 5. MCP Tools — Simplificadas

Reduzido de 24 para **15 tools** focadas. Uma tool de escrita principal + especializadas de leitura.

### 5.1 Escrita (5 tools)

| Tool | Descrição |
|------|-----------|
| `memory_add` | Armazena qualquer dado. Classifica tipo via heurística (regex + keywords, sem LLM). Aceita campos opcionais pra forçar tipo. |
| `entity_upsert` | Cria ou atualiza entidade + observações no knowledge graph. |
| `relation_upsert` | Cria ou atualiza relação entre entidades. |
| `procedure_save` | Salva/atualiza workflow com versionamento automático. |
| `blob_store` | Armazena arquivo/mídia com referência. |

### 5.2 Leitura (7 tools)

| Tool | Descrição |
|------|-----------|
| `memory_recall` | **Principal.** Busca híbrida (vector + FTS + graph + structured). Score fusion. |
| `memory_search` | Busca estruturada com filtros precisos, paginação. |
| `fact_query` | Consulta fatos sobre entidade com busca semântica. |
| `graph_traverse` | Navega knowledge graph a partir de entidade. |
| `graph_search` | Busca entidades e relações. |
| `timeline` | Linha do tempo de eventos. |
| `procedure_get` | Recupera workflow por nome ou busca semântica. |

### 5.3 Gestão (3 tools)

| Tool | Descrição |
|------|-----------|
| `memory_consolidate` | Dispara consolidação manual. |
| `memory_stats` | Estatísticas da memória. |
| `memory_purge` | **Hard delete** para compliance LGPD/GDPR. Registra audit trail criptografado. |

**Mudança vs v1:** Eliminadas tools redundantes (episode_record, fact_store, observation_add — todas absorvidas por memory_add e entity_upsert). Export/import movidos pra CLI commands, não tools MCP.

### 5.4 Detalhes das tools principais

#### `memory_add`
```typescript
Input: {
  content: string,                    // OBRIGATÓRIO
  type?: 'episode' | 'fact' | 'procedure' | 'auto',  // default: 'auto'
  
  // Classificação
  category?: string,
  tags?: string[],
  importance?: number,                // 0.0-1.0, default: 0.5
  
  // Contexto
  namespace?: string,
  metadata?: Record<string, any>,
  
  // Tipo-específico (opcionais)
  event_type?: string,                // episode
  participants?: string[],            // episode
  entity_name?: string,               // fact
  fact_type?: string,                 // fact
  confidence?: number,                // fact
  name?: string,                      // procedure
  steps?: string[],                   // procedure
}

Output: {
  id: string,
  type: string,                       // tipo classificado
  entities_detected: string[],        // entidades auto-detectadas
  queued_for_embedding: boolean,
}
```

**Auto-classificação (heurística, sem LLM):**
- Se tem `steps` ou `name` com padrão de workflow → procedure
- Se tem `entity_name` + `fact_type` ou `confidence` → fact
- Se tem `event_type` ou `participants` → episode
- Se content contém "prefere", "gosta", "usa", "mora" → fact (detected)
- Default: episode

#### `memory_recall`
```typescript
Input: {
  query: string,                      // OBRIGATÓRIO
  types?: string[],
  tags?: string[],
  namespace?: string,
  time_range?: { after?: string, before?: string },
  importance_min?: number,
  limit?: number,                     // default: 10, max: 50
  include_archived?: boolean,
  search_mode?: 'hybrid' | 'semantic' | 'exact' | 'graph',
}

Output: {
  results: Array<{
    id: string,
    type: string,
    content: string,
    summary?: string,
    score: number,
    score_breakdown: {
      semantic: number,
      text: number,
      graph: number,
      recency: number,
      importance: number,
    },
    tags?: string[],
    created_at: string,
  }>,
  query_time_ms: number,
}
```

**Score Fusion:**
```
final_score = (
  0.35 * semantic_score +
  0.20 * text_score +
  0.15 * graph_proximity +
  0.15 * recency_score +
  0.15 * importance
)

recency = 1.0 / (1.0 + days_since_creation * 0.01)
```

#### `memory_purge` (LGPD/GDPR)
```typescript
Input: {
  target_id: string,                  // OBRIGATÓRIO: memory, entity, ou relation ID
  reason: string,                     // OBRIGATÓRIO: motivo do purge
  cascade?: boolean,                  // deletar dados relacionados (default: true)
}

Output: {
  purged: number,                     // registros deletados
  audit_id: string,                   // ID do audit trail criptografado
}
```

Processo:
1. Registra audit trail criptografado (apenas motivo + timestamp + HMAC hash com salt descartável)
2. Deleta embeddings associados (todas as chunks)
3. Deleta da tabela principal (hard delete, não soft)
4. Se cascade: deleta observações, relações orphãs, blobs vinculados
5. **Purge de backups:** marca o `target_id` numa tabela `purge_tombstones`. O Backup Manager exclui esses IDs ao restaurar qualquer backup anterior ao purge.
6. **Purge de cache (Server Mode):** invalida keys no Redis que referenciam o `target_id`
7. Registra evento no event_log com `action: 'purge'` (sem dados pessoais, com HMAC hash)

```sql
-- Tombstones: garante que dados purgados não ressuscitam via restore de backup
CREATE TABLE purge_tombstones (
  target_id     TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL,
  purged_at     TEXT NOT NULL,
  reason_hmac   TEXT NOT NULL              -- HMAC-SHA256(reason, random_salt)
);
```

**Invariante LGPD:** Após `memory_purge`, o dado pessoal **não existe** em nenhuma camada: tabelas principais, embeddings, blobs, event log, cache Redis, e é excluído na restauração de qualquer backup.

---

## 6. Embedding Pipeline — Revisado

### 6.1 Estratégia de Embedding

| Conteúdo | O que é embeddado | Chunks |
|----------|-------------------|--------|
| Episode curto (<500 tokens) | content completo | 1 |
| Episode longo (>500 tokens) | summary (chunk 0) + body chunks sobrepostos (chunk 1+) | N |
| Fact | entity_name + ": " + content | 1 |
| Procedure | name + steps completos (todos) | 1-N |
| Entity | name + type + description | 1 |
| Relation | textualizado: "Entity A → relation → Entity B" | 1 |

### 6.2 Chunking

```
Texto longo → split em chunks de 300 tokens com 50 tokens de overlap
Cada chunk gera um embedding separado vinculado ao mesmo memory_id
chunk_index 0 = summary/título (sempre gerado)
chunk_index 1+ = body chunks
```

### 6.3 Summary Generation

Para episódios longos, summary é gerado por:
1. **Provider configurável** (LLM call) — default: modelo barato e rápido (ex: gpt-4o-mini, gemini-flash)
2. **Fallback:** primeiros 500 tokens do content como summary
3. **Configuração:**
```json
{
  "summary": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "max_tokens": 150,
    "fallback": "truncate",
    "threshold_tokens": 500
  }
}
```

### 6.4 Dimensions e Providers

```json
{
  "embedding": {
    "provider": "supabase",            // 'supabase' | 'openai' | 'local' | 'ollama'
    "dimensions": 512,
    "batch_size": 50,
    "auto_embed": true,
    "retry_attempts": 3,
    "retry_delay_ms": 1000,
    "importance_threshold": 0.0,
    "providers": {
      "supabase": {
        "project_url": "env:SUPABASE_URL",
        "service_key": "env:SUPABASE_SERVICE_KEY",
        "model": "gte-small"           // via Supabase AI / Edge Functions
      },
      "openai": {
        "api_key": "env:OPENAI_API_KEY",
        "model": "text-embedding-3-small"
      },
      "local": {
        "model": "all-MiniLM-L6-v2",
        "dimensions": 384
      }
    },
    "heuristic": {
      "use_local_below_importance": 0.3
    }
  }
}
```

**Mudança vs v1:** 512 dims (1/3 do storage, ~95% da qualidade), chunking completo, heurística de provider por importância.

### 6.5 Re-embedding

```typescript
// CLI command (não tool MCP)
mnemosyne re-embed --from-model "text-embedding-3-small" --to-model "text-embedding-3-large" --batch 100 --priority low
```

Processo:
1. Filtra embeddings pelo modelo antigo
2. Processa em batches de baixa prioridade (não bloqueia operações normais)
3. Incrementa `version` em cada embedding atualizado
4. Mantém embedding antigo até o novo ser gerado (zero downtime)

---

## 7. Consolidation Engine — "O Sono do Agente" (Revisado)

### 7.1 Princípio: Nunca alterar o original

Consolidação **NUNCA deleta ou modifica** memórias originais. Ela:
- Cria novas memórias (fatos extraídos de episódios)
- Marca originais como `status: 'consolidated'` (mas preserva conteúdo intacto)
- Cria relações no knowledge graph
- Todo o processo é rastreável via event_log

### 7.2 LLM para Consolidação

A extração de fatos e detecção de contradições requer um LLM.

```json
{
  "consolidation": {
    "llm": {
      "provider": "openai",
      "model": "gpt-4o-mini",          // barato e rápido
      "max_tokens": 500,
      "fallback": "skip",              // se API indisponível, pula consolidação
      "cost_budget_daily_usd": 1.0     // limite de custo diário
    }
  }
}
```

### 7.3 Processo Incremental e Contínuo

**Mudança vs v1:** Consolidação agora é **incremental** (mini-batches contínuos), não batch diário.

| Trigger | Ação | Batch size |
|---------|------|------------|
| A cada 50 novos episódios | Extração de fatos | 50 |
| A cada 200 novas memórias | Deduplicação | 200 |
| A cada 100 novas memórias | Auto-conexão no grafo | 100 |
| Diário (4AM) | Importance decay + cleanup | All |
| Manual | O que o agente pedir | Configurável |
| 80% storage | Arquivamento de baixa importância | Agressivo |

### 7.4 Dedup Calibrado por Modelo

```json
{
  "dedup": {
    "thresholds": {
      "text-embedding-3-small": 0.92,
      "all-MiniLM-L6-v2": 0.88,
      "default": 0.90
    }
  }
}
```

### 7.5 Importance Decay

```
new_importance = importance * (1 - decay_rate * days_since_creation)
Mínimo: 0.05
decay_rate: 0.005 (mais conservador que v1)
```

**Mudança:** Decay baseado em `created_at` (imutável), não `accessed_at` (que foi removido). Acessos são contados via event_log se necessário, mas não afetam a tabela principal.

---

## 8. Multi-Agent (Revisado)

### 8.1 Isolamento Completo por Namespace

**Mudança vs v1:** Relações no knowledge graph agora são **isoladas por namespace** (não globais). Sem risco de vazamento semântico.

```
namespace: "sirius"     → tudo do Sirius (memórias, entidades, relações, embeddings)
namespace: "_shared"    → compartilhado explicitamente
namespace: "_"          → default (agente solo)
```

### 8.2 Permissões Granulares

```json
{
  "agents": {
    "sirius": {
      "namespace": "sirius",
      "permissions": {
        "sirius": ["read", "write", "admin"],
        "_shared": ["read", "write"],
        "agent-002": []                // sem acesso
      },
      "type_restrictions": {
        "agent-002": ["fact", "entity"] // se tiver acesso, só esses tipos
      }
    }
  }
}
```

**Mudança vs v1:** Permissões granulares por tipo de memória (não apenas por namespace inteiro).

### 8.3 Compartilhamento Explícito

Memórias só aparecem em `_shared` quando explicitamente copiadas. Nenhum dado é automaticamente compartilhado.

---

## 9. Segurança (Nova seção)

### 9.1 Encryption at Rest

```json
{
  "security": {
    "encryption_at_rest": true,        // SQLite: sqlcipher | Postgres: native
    "encryption_key_source": "env",    // 'env' | '1password' | 'vault'
    "env_key": "MNEMOSYNE_ENCRYPTION_KEY"
  }
}
```

### 9.2 Auth (Server mode)

- **Personal mode:** sem auth (local, single-user)
- **Server mode:** Bearer token + optional mTLS
- **Supabase mode:** Supabase Auth integrado (JWT)

### 9.3 Data Retention

```json
{
  "retention": {
    "default_ttl_days": null,          // null = para sempre
    "purge_on_request": true,          // LGPD: hard delete habilitado
    "audit_retention_days": 365,       // audit logs mantidos por 1 ano
    "auto_archive_days": null          // auto-arquivar após N dias (opcional)
  }
}
```

### 9.4 Input Sanitization

Todo content é sanitizado antes de entrar no FTS5 (previne SQL injection via FTS query syntax).

---

## 10. Stack Técnica

### Personal Mode

| Componente | Tecnologia | Motivo |
|---|---|---|
| Runtime | TypeScript / Node.js | MCP SDK compatible |
| Banco | SQLite via better-sqlite3 | Zero-config, embedded |
| FTS | SQLite FTS5 | Nativo |
| Vector | sqlite-vec | Embutido |
| Queue | Tabela `job_queue` no SQLite | Durável, simples |
| Blobs | Filesystem | Simples |
| IDs | ULID | Ordenáveis |
| Validation | Zod | Input validation |
| MCP | @modelcontextprotocol/sdk | Padrão |
| Migrations | SQL sequenciais custom | Leve |

### Server Mode

| Componente | Tecnologia | Motivo |
|---|---|---|
| Runtime | TypeScript / Node.js | Mesmo código |
| Banco | Postgres (Supabase/Neon) | Row-level locking, escala |
| FTS | Postgres tsvector | Nativo |
| Vector | pgvector | Maduro, performático |
| Queue | Redis + BullMQ | Durável, distribuído |
| Cache | Redis | Resultados de busca, rate limiting |
| Blobs | S3 / Supabase Storage | Escalável |
| Auth | Supabase Auth / JWT | Pronto |
| Migrations | Drizzle Kit | ORM type-safe |

### Upgrade Path

```
Personal (SQLite) → Turso (libSQL, SQLite-compatible com replicação) → Server (Postgres)
```

---

## 11. Performance — Estimativas Honestas

### Personal Mode (single agent, <100k memórias)

| Operação | Latência | Nota |
|---|---|---|
| memory_add | < 5ms | Escrita local + queue job |
| memory_recall (hybrid) | 20-80ms | Depende de cardinalidade e cache |
| memory_search | < 10ms | SQL indexed |
| graph_traverse (depth 2) | < 20ms | BFS indexed |
| consolidation (100 episodes) | 2-5s | LLM call incluso |
| embedding (1 item, OpenAI) | ~200ms | API call, async |

### Server Mode (multi-agent, >100k memórias)

| Operação | Latência | Nota |
|---|---|---|
| memory_add | < 10ms | Postgres insert + Redis queue |
| memory_recall (hybrid) | 30-100ms | pgvector + tsvector + cache |
| memory_search | < 15ms | Postgres indexed |
| graph_traverse (depth 2) | < 30ms | Postgres CTE |
| consolidation | Background | Não impacta latência de leitura |

**Nota:** Estas são estimativas que serão validadas com benchmarks em datasets reais (10k, 50k, 100k, 500k memórias) antes da publicação.

---

## 12. Configuração Completa

```json
{
  "mnemosyne": {
    "version": "4.0.0",
    "mode": "personal",                 // 'personal' | 'server'
    
    "storage": {
      "driver": "sqlite",               // 'sqlite' | 'postgres' | 'turso'
      "sqlite": {
        "path": "./data/mnemosyne.db",
        "wal_mode": true,
        "max_db_size_mb": 5000
      },
      "postgres": {
        "connection_string": "env:DATABASE_URL",
        "pool_size": 10
      },
      "blobs": {
        "driver": "filesystem",          // 'filesystem' | 's3' | 'supabase'
        "path": "./data/blobs"
      }
    },
    
    "embedding": {
      "provider": "supabase",            // 'supabase' | 'openai' | 'local' | 'ollama'
      "model": "gte-small",             // modelo via Supabase AI
      "dimensions": 512,
      "chunk_size_tokens": 300,
      "chunk_overlap_tokens": 50,
      "batch_size": 50,
      "auto_embed": true,
      "heuristic": {
        "use_local_below_importance": 0.3
      }
    },
    
    "summary": {
      "provider": "openai",
      "model": "gpt-4o-mini",
      "max_tokens": 150,
      "threshold_tokens": 500
    },
    
    "search": {
      "default_limit": 10,
      "max_limit": 50,
      "weights": {
        "semantic": 0.35,
        "text": 0.20,
        "graph": 0.15,
        "recency": 0.15,
        "importance": 0.15
      }
    },
    
    "consolidation": {
      "enabled": true,
      "mode": "incremental",
      "episode_batch": 50,
      "dedup_batch": 200,
      "daily_schedule": "0 4 * * *",
      "llm": {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "cost_budget_daily_usd": 1.0
      },
      "dedup_thresholds": {
        "text-embedding-3-small": 0.92,
        "default": 0.90
      },
      "importance_decay_rate": 0.005,
      "importance_minimum": 0.05
    },
    
    "queue": {
      "driver": "sqlite",               // 'sqlite' | 'redis'
      "redis": {
        "url": "env:REDIS_URL"
      }
    },
    
    "agents": {
      "default_namespace": "_",
      "isolation": "namespace"
    },
    
    "security": {
      "encryption_at_rest": false,
      "auth": "none",                   // 'none' | 'bearer' | 'supabase'
      "input_sanitization": true
    },
    
    "retention": {
      "default_ttl_days": null,
      "purge_enabled": true,
      "audit_retention_days": 365
    },
    
    "transport": {
      "stdio": true,
      "http": {
        "enabled": false,
        "port": 3100
      }
    },
    
    "backup": {
      "enabled": true,
      "schedule": "0 3 * * *",
      "retention_days": 30
    }
  }
}
```

---

## 13. Fases de Desenvolvimento (Timeline Realista)

### Fase 1 — Fundação (Semana 1-3)
**Objetivo:** MCP server funcional com Personal mode.

- [ ] Setup TypeScript + MCP SDK + build pipeline
- [ ] Storage Driver interface + SqliteDriver
- [ ] Schema migrations system
- [ ] SQLite schema completo
- [ ] Event log com hash chain
- [ ] Job queue durável (SQLite)
- [ ] `memory_add` com auto-classificação (heurística)
- [ ] `memory_search` com filtros estruturados
- [ ] Knowledge graph: `entity_upsert`, `relation_upsert`, `graph_search`, `graph_traverse`
- [ ] FTS5 integration
- [ ] `memory_stats`
- [ ] Input sanitization
- [ ] Testes unitários
- [ ] stdio transport

**Entregável:** `npx mnemosyne` com 12 tools funcionando.

### Fase 2 — Inteligência (Semana 4-7)
**Objetivo:** Busca semântica, chunking, consolidação.

- [ ] Embedding pipeline com chunking
- [ ] sqlite-vec integration
- [ ] `memory_recall` com hybrid search + score fusion
- [ ] Summary generation pipeline (LLM)
- [ ] Embedding de relações textualizadas
- [ ] Heurística de provider (local vs API por importância)
- [ ] `timeline` tool
- [ ] `fact_query` com busca semântica
- [ ] `procedure_get` com busca semântica
- [ ] Consolidation engine incremental (LLM-powered)
- [ ] Importance decay
- [ ] Dedup calibrado por modelo
- [ ] `memory_purge` (LGPD)
- [ ] Testes de integração
- [ ] **Benchmark com datasets: 10k, 50k, 100k memórias**

**Entregável:** Busca semântica + consolidação + compliance.

### Fase 3 — Server Mode (Semana 8-11)
**Objetivo:** Postgres + Redis, multi-agent, HTTP.

- [ ] PostgresDriver (pg + pgvector)
- [ ] Redis queue driver (BullMQ)
- [ ] Redis cache layer
- [ ] Multi-agent (namespaces, permissões granulares)
- [ ] HTTP/SSE transport
- [ ] Auth (Bearer + Supabase)
- [ ] Encryption at rest
- [ ] S3/Supabase blob storage
- [ ] `memory_consolidate` (manual trigger)
- [ ] Re-embedding CLI command
- [ ] Backup automático
- [ ] Benchmark Server mode (concorrência, latência)

**Entregável:** Server mode pronto para produção.

### Fase 4 — Polish (Semana 12+)
**Objetivo:** Documentação, publicação.

- [ ] TursoDriver (upgrade path)
- [ ] Import de MCP Core Memory / MEMORY.md
- [ ] Export CLI commands (JSON, CSV)
- [ ] Dashboard web (opcional, read-only)
- [ ] Documentação completa
- [ ] README com exemplos
- [ ] Publicação npm: `@mosaiko/mnemosyne`
- [ ] Publicação MCP registry

**Entregável:** Publicado e documentado.

**Timeline total: ~14 semanas** (vs 7 do plano v1 — 2x mais realista).

---

## 14. Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| sqlite-vec não escala >100k vetores | Média | Alto | Benchmark cedo; Qdrant como fallback |
| Custo de LLM na consolidação | Alta | Médio | Budget diário configurável; fallback skip |
| MCP SDK breaking changes | Média | Alto | Pin version; abstraction layer |
| Complexidade do hybrid search | Alta | Médio | Iterar: começar só com FTS, adicionar vector depois |
| Concorrência SQLite em Personal mode | Baixa | Médio | Rate limit; documentar limites |
| Vendor lock-in em provider de embedding | Média | Médio | Interface de provider; re-embed CLI |

---

## 15. Nome

### Mnemosyne (Μνημοσύνη)

Na mitologia grega, **Mnemosyne** é a titânide da memória e mãe das nove musas. Ela personifica a memória como fonte de toda criação e conhecimento.

**npm package:** `@mosaiko/mnemosyne`
**CLI:** `mnemosyne`
**Alias:** `mnemo`

---

## 16. Changelog do Plano

### v4.0 (09/03/2026) — Zero débitos técnicos (target: 10/10)

- **[LGPD]** Hash de purge agora usa HMAC-SHA256 com salt descartável (anti-reidentificação)
- **[LGPD]** `purge_tombstones` table — garante que dados purgados não ressuscitam via restore de backup
- **[LGPD]** Purge agora cobre: tabelas, embeddings, blobs, event log, cache Redis, e backups (via tombstones)
- **[LGPD]** Invariante explícita: após purge, dado pessoal não existe em nenhuma camada
- **[Multi-tenant]** Trigger `trg_observations_ns_check`: observation.namespace DEVE igualar entity.namespace
- **[Multi-tenant]** Trigger `trg_relations_ns_check`: relações só entre entidades do mesmo namespace (ou _shared)
- **[Multi-tenant]** Isolamento agora é enforced no schema (triggers), não apenas na aplicação
- **[Arquitetura]** `DataStore` split em 3: `MemoryStore`, `GraphStore`, `LifecycleManager`
- **[Arquitetura]** Backend agora composto por 7 sub-interfaces (de 5)
- **[Arquitetura]** Cada sub-interface tem responsabilidade single-purpose
- **[Arquitetura]** `GraphStore` inclui `purgeEntity` para cascade LGPD no grafo

### v3.0 (09/03/2026) — Correção de falhas críticas (Codex GPT-5.4)

- **[LGPD]** Event log não armazena mais conteúdo pessoal — apenas metadados estruturais e hashes
- **[LGPD]** `memory_purge` agora é real: dado pessoal é eliminado de todas as tabelas, event log guarda apenas hash-prova
- **[Multi-tenant]** `observations` agora tem `namespace` + index
- **[Multi-tenant]** `procedures.name` UNIQUE por namespace (não mais global) — dois agentes podem ter procedures homônimas
- **[Arquitetura]** `StorageDriver` split em 5 sub-interfaces: `DataStore`, `VectorStore`, `JobQueue`, `BlobStore`, `EventLog`
- **[Arquitetura]** Nova composição `MnemosyneBackend` permite mix de providers (ex: Postgres + Qdrant + Redis)
- **[Arquitetura]** Hybrid Mode adicionado como terceira opção de deployment

### v2.0 (09/03/2026) — Pós-análise crítica
Revisores: Gemini 3.0, Claude Sonnet 4, Codex GPT-5.4, Claude Opus 4

- **[Arquitetura]** Duas edições: Personal (SQLite) + Server (Postgres+Redis)
- **[Arquitetura]** Storage Driver abstraction desde dia 1
- **[Dados]** Event log com hash chain (verdadeiramente append-only)
- **[Dados]** Removido `accessed_at` e `access_count` da tabela principal (elimina write-on-read)
- **[Dados]** Relações com namespace (isolamento no grafo)
- **[Dados]** Schema migrations system
- **[Dados]** Job queue durável em SQLite (não mais in-memory)
- **[Embedding]** Dimensões reduzidas: 1536 → 512
- **[Embedding]** Chunking para textos longos
- **[Embedding]** Re-embedding com versionamento
- **[Embedding]** Embedding de relações textualizadas
- **[Embedding]** Heurística de provider por importância
- **[Consolidation]** Incremental e contínuo (não mais batch diário)
- **[Consolidation]** LLM provider especificado com budget
- **[Consolidation]** Dedup calibrado por modelo de embedding
- **[Consolidation]** Nunca modifica originais (apenas marca status)
- **[Segurança]** LGPD/GDPR: `memory_purge` com hard delete
- **[Segurança]** Encryption at rest
- **[Segurança]** Input sanitization para FTS5
- **[Segurança]** Permissões granulares por tipo de memória
- **[Tools]** Reduzidas de 24 para 15
- **[Tools]** Auto-classificação por heurística (sem LLM)
- **[Performance]** Estimativas honestas com nota de benchmark pendente
- **[Timeline]** Ajustada: 7 semanas → 14 semanas
- **[Riscos]** Seção de riscos e mitigações adicionada

---

*Planejado por Sirius ⭐ em 09/03/2026*
*v2 revisado com Gemini 3.0, Claude Sonnet 4, Codex GPT-5.4 e Claude Opus 4.*
*v3 corrigido após falhas críticas identificadas pelo Codex GPT-5.4.*
*Para Studio Mosaiko — onde nada se perde.*
