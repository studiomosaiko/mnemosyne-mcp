import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  type BlobFilter,
  type BlobInfo,
  type BlobMetadata,
  type BlobStore,
  type EmbeddingData,
  type Entity,
  type EntityInput,
  type EntityQuery,
  type EventFilter,
  type EventInput,
  type EventLog,
  type EventRecord,
  type FactDetailsInput,
  type GraphEdge,
  type GraphNode,
  type GraphResult,
  type GraphStore,
  type Job,
  type JobQueue,
  type LifecycleManager,
  type Memory,
  type MemoryInput,
  type MemoryStore,
  type MigrationResult,
  type MnemosyneBackend,
  type Observation,
  type ObservationInput,
  type ProcedureDetailsInput,
  type QueueStats,
  type Relation,
  type RelationInput,
  type RelationQuery,
  type ReindexFilter,
  type ScoredMemory,
  type ScoreBreakdown,
  type StructuredQuery,
  type TextSearchOptions,
  type TraversalOptions,
  type VectorSearchOptions,
  type VectorStore,
} from "../interfaces/index.js";
import {
  DEFAULT_NAMESPACE,
  cosineSimilarity,
  createBackupFile,
  decodeVector,
  encodeVector,
  ensureDir,
  fileSize,
  hmacSha256,
  loadMigrations,
  newId,
  nowIso,
  parseJsonArray,
  parseJsonObject,
  removeIfExists,
  restoreBackupFile,
  sanitizeText,
  sha256,
  writeBuffer,
} from "./utils.js";

type Db = InstanceType<typeof Database>;
type Row = Record<string, unknown>;

interface ClaimedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: "processing";
  priority: number;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  nextRetryAt: string | null;
}

export interface SqliteBackendOptions {
  dbPath?: string;
  blobsPath?: string;
  backupsPath?: string;
  migrationsDir?: string;
  defaultNamespace?: string;
}

function mapMemory(row: Row): Memory {
  return {
    id: String(row.id),
    type: row.type as Memory["type"],
    namespace: String(row.namespace),
    content: String(row.content),
    summary: row.summary ? String(row.summary) : null,
    contentHash: row.content_hash ? String(row.content_hash) : null,
    category: row.category ? String(row.category) : null,
    tags: parseJsonArray((row.tags as string | null) ?? null),
    importance: Number(row.importance ?? 0.5),
    source: row.source ? String(row.source) : null,
    agentId: row.agent_id ? String(row.agent_id) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    status: row.status as Memory["status"],
    supersededBy: row.superseded_by ? String(row.superseded_by) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    embeddingModel: row.embedding_model ? String(row.embedding_model) : null,
    embeddingVersion: Number(row.embedding_version ?? 0),
    embeddedAt: row.embedded_at ? String(row.embedded_at) : null,
  };
}

function mapEntity(row: Row): Entity {
  return {
    id: String(row.id),
    name: String(row.name),
    entityType: String(row.entity_type),
    namespace: String(row.namespace),
    description: row.description ? String(row.description) : null,
    properties: parseJsonObject((row.properties as string | null) ?? null),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    status: String(row.status ?? "active"),
  };
}

function mapRelation(row: Row): Relation {
  return {
    id: String(row.id),
    fromEntity: String(row.from_entity),
    toEntity: String(row.to_entity),
    relationType: String(row.relation_type),
    properties: parseJsonObject((row.properties as string | null) ?? null),
    weight: Number(row.weight ?? 1),
    bidirectional: Boolean(row.bidirectional),
    namespace: String(row.namespace),
    createdAt: String(row.created_at),
    status: String(row.status ?? "active"),
  };
}

function mapObservation(row: Row): Observation {
  return {
    id: String(row.id),
    entityId: String(row.entity_id),
    content: String(row.content),
    observer: row.observer ? String(row.observer) : null,
    namespace: String(row.namespace),
    observedAt: String(row.observed_at),
    confidence: Number(row.confidence ?? 0.8),
    source: row.source ? String(row.source) : null,
    status: String(row.status ?? "active"),
  };
}

function mapEvent(row: Row): EventRecord {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    agentId: row.agent_id ? String(row.agent_id) : null,
    action: row.action as EventRecord["action"],
    targetType: row.target_type as EventRecord["targetType"],
    targetId: String(row.target_id),
    data: row.data ? (JSON.parse(String(row.data)) as Record<string, unknown>) : null,
    prevHash: row.prev_hash ? String(row.prev_hash) : null,
    hash: String(row.hash),
  };
}

class SqliteEventLog implements EventLog {
  constructor(private readonly db: Db) {}

  async append(event: EventInput): Promise<void> {
    const timestamp = event.timestamp ?? nowIso();
    const id = event.id ?? newId();
    const last = this.db.prepare("SELECT hash FROM event_log ORDER BY rowid DESC LIMIT 1").get() as Row | undefined;
    const prevHash = last?.hash ? String(last.hash) : null;
    const data = event.data ? JSON.stringify(event.data) : null;
    const hash = sha256(`${id}${timestamp}${event.action}${event.targetId}${data ?? ""}${prevHash ?? ""}`);
    this.db
      .prepare(
        "INSERT INTO event_log (id, timestamp, agent_id, action, target_type, target_id, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, timestamp, event.agentId ?? null, event.action, event.targetType, event.targetId, data, prevHash, hash);
  }

  async query(filter: EventFilter): Promise<EventRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.targetId) {
      conditions.push("target_id = ?");
      params.push(filter.targetId);
    }
    if (filter.action) {
      conditions.push("action = ?");
      params.push(filter.action);
    }
    const sql = `SELECT * FROM event_log ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY timestamp DESC LIMIT ?`;
    params.push(filter.limit ?? 100);
    return this.db.prepare(sql).all(...params).map((row) => mapEvent(row as Row));
  }

  async verify(): Promise<{ valid: boolean; brokenAt?: string }> {
    const rows = this.db.prepare("SELECT * FROM event_log ORDER BY rowid ASC").all() as Row[];
    let previousHash: string | null = null;
    for (const row of rows) {
      const expected = sha256(
        `${row.id}${row.timestamp}${row.action}${row.target_id}${row.data ? String(row.data) : ""}${previousHash ?? ""}`,
      );
      if (expected !== row.hash || previousHash !== (row.prev_hash ? String(row.prev_hash) : null)) {
        return { valid: false, brokenAt: String(row.id) };
      }
      previousHash = String(row.hash);
    }
    return { valid: true };
  }
}

class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: Db, private readonly events: EventLog, private readonly defaultNamespace: string) {}

  async create(memory: MemoryInput): Promise<Memory> {
    const procedureDetails = memory.type === "procedure" ? ((memory.details ?? {}) as ProcedureDetailsInput) : null;
    const existingProcedure =
      memory.type === "procedure" && procedureDetails?.name
        ? (this.db
            .prepare("SELECT p.memory_id, p.version FROM procedures p WHERE p.name = ? AND p.namespace = ?")
            .get(procedureDetails.name, memory.namespace ?? this.defaultNamespace) as Row | undefined)
        : undefined;
    const id = memory.id ?? (existingProcedure?.memory_id ? String(existingProcedure.memory_id) : newId());
    const timestamp = memory.createdAt ?? nowIso();
    const normalized = {
      id,
      type: memory.type,
      namespace: memory.namespace ?? this.defaultNamespace,
      content: sanitizeText(memory.content),
      summary: memory.summary ?? null,
      contentHash: memory.contentHash ?? sha256(memory.content),
      category: memory.category ?? null,
      tags: JSON.stringify(memory.tags ?? []),
      importance: memory.importance ?? 0.5,
      source: memory.source ?? null,
      agentId: memory.agentId ?? null,
      sessionId: memory.sessionId ?? null,
      createdAt: timestamp,
      updatedAt: memory.updatedAt ?? timestamp,
      status: memory.status ?? "active",
      supersededBy: memory.supersededBy ?? null,
      expiresAt: memory.expiresAt ?? null,
      embeddingModel: memory.embeddingModel ?? null,
      embeddingVersion: memory.embeddingVersion ?? 0,
      embeddedAt: memory.embeddedAt ?? null,
    };
    const tx = this.db.transaction(() => {
      if (existingProcedure?.memory_id) {
        this.db
          .prepare(
            `UPDATE memories SET
              type = ?, namespace = ?, content = ?, summary = ?, content_hash = ?, category = ?, tags = ?, importance = ?,
              source = ?, agent_id = ?, session_id = ?, updated_at = ?, status = ?, superseded_by = ?, expires_at = ?,
              embedding_model = ?, embedding_version = ?, embedded_at = ?
             WHERE id = ?`,
          )
          .run(
            normalized.type,
            normalized.namespace,
            normalized.content,
            normalized.summary,
            normalized.contentHash,
            normalized.category,
            normalized.tags,
            normalized.importance,
            normalized.source,
            normalized.agentId,
            normalized.sessionId,
            normalized.updatedAt,
            normalized.status,
            normalized.supersededBy,
            normalized.expiresAt,
            normalized.embeddingModel,
            normalized.embeddingVersion,
            normalized.embeddedAt,
            normalized.id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO memories
            (id, type, namespace, content, summary, content_hash, category, tags, importance, source, agent_id, session_id, created_at, updated_at, status, superseded_by, expires_at, embedding_model, embedding_version, embedded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            normalized.id,
            normalized.type,
            normalized.namespace,
            normalized.content,
            normalized.summary,
            normalized.contentHash,
            normalized.category,
            normalized.tags,
            normalized.importance,
            normalized.source,
            normalized.agentId,
            normalized.sessionId,
            normalized.createdAt,
            normalized.updatedAt,
            normalized.status,
            normalized.supersededBy,
            normalized.expiresAt,
            normalized.embeddingModel,
            normalized.embeddingVersion,
            normalized.embeddedAt,
          );
      }

      if (memory.type === "episode") {
        const details = (memory.details ?? {}) as Exclude<MemoryInput["details"], undefined>;
        this.db
          .prepare(
            "INSERT INTO episodes (memory_id, event_type, participants, location, outcome, emotions, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            "eventType" in details && details.eventType ? details.eventType : "general",
            JSON.stringify("participants" in details && details.participants ? details.participants : []),
            "location" in details ? (details.location ?? null) : null,
            "outcome" in details ? (details.outcome ?? null) : null,
            JSON.stringify("emotions" in details && details.emotions ? details.emotions : []),
            "durationMs" in details ? (details.durationMs ?? null) : null,
          );
      }
      if (memory.type === "fact") {
        const details = (memory.details ?? {}) as FactDetailsInput;
        this.db
          .prepare(
            "INSERT INTO facts (memory_id, entity_name, entity_type, fact_type, confidence, valid_from, valid_until, contradicts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            details.entityName ?? "unknown",
            details.entityType ?? null,
            details.factType ?? "attribute",
            details.confidence ?? 0.8,
            details.validFrom ?? null,
            details.validUntil ?? null,
            details.contradicts ?? null,
          );
      }
      if (memory.type === "procedure") {
        const details = procedureDetails ?? {};
        if (existingProcedure?.memory_id) {
          this.db
            .prepare(
              `UPDATE procedures SET
                version = ?,
                steps = ?,
                prerequisites = ?,
                triggers = ?,
                success_count = ?,
                failure_count = ?,
                avg_duration_ms = ?,
                last_used_at = ?,
                last_result = ?
               WHERE memory_id = ?`,
            )
            .run(
              Number(existingProcedure.version) + 1,
              JSON.stringify(details.steps ?? []),
              JSON.stringify(details.prerequisites ?? []),
              JSON.stringify(details.triggers ?? []),
              details.successCount ?? 0,
              details.failureCount ?? 0,
              details.avgDurationMs ?? null,
              details.lastUsedAt ?? null,
              details.lastResult ?? null,
              normalized.id,
            );
        } else {
          this.db
            .prepare(
              `INSERT INTO procedures
              (memory_id, name, namespace, version, steps, prerequisites, triggers, success_count, failure_count, avg_duration_ms, last_used_at, last_result)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              details.name ?? "unnamed-procedure",
              memory.namespace ?? this.defaultNamespace,
              details.version ?? 1,
              JSON.stringify(details.steps ?? []),
              JSON.stringify(details.prerequisites ?? []),
              JSON.stringify(details.triggers ?? []),
              details.successCount ?? 0,
              details.failureCount ?? 0,
              details.avgDurationMs ?? null,
              details.lastUsedAt ?? null,
              details.lastResult ?? null,
            );
        }
      }
    });
    tx();
    await this.events.append({
      action: existingProcedure?.memory_id ? "update" : "create",
      targetType: "memory",
      targetId: id,
      agentId: memory.agentId ?? null,
      data: {
        type: memory.type,
        namespace: memory.namespace ?? this.defaultNamespace,
        tags: memory.tags ?? [],
        importance: memory.importance ?? 0.5,
      },
    });
    return (await this.get(id)) as Memory;
  }

  async get(id: string): Promise<Memory | null> {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row ? mapMemory(row) : null;
  }

  async update(id: string, fields: Partial<Memory>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Memory ${id} not found`);
    }
    const updates: string[] = [];
    const params: unknown[] = [];
    const mapping: Record<string, string> = {
      type: "type",
      namespace: "namespace",
      content: "content",
      summary: "summary",
      contentHash: "content_hash",
      category: "category",
      tags: "tags",
      importance: "importance",
      source: "source",
      agentId: "agent_id",
      sessionId: "session_id",
      updatedAt: "updated_at",
      status: "status",
      supersededBy: "superseded_by",
      expiresAt: "expires_at",
      embeddingModel: "embedding_model",
      embeddingVersion: "embedding_version",
      embeddedAt: "embedded_at",
    };
    for (const [key, column] of Object.entries(mapping)) {
      const value = fields[key as keyof Memory];
      if (value !== undefined) {
        updates.push(`${column} = ?`);
        params.push(key === "tags" ? JSON.stringify(value) : value);
      }
    }
    updates.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    await this.events.append({
      action: fields.status === "archived" ? "archive" : "update",
      targetType: "memory",
      targetId: id,
      data: {
        fields_changed: Object.keys(fields),
        old_status: existing.status,
        new_status: fields.status ?? existing.status,
      },
    });
  }

  async search(query: StructuredQuery): Promise<Memory[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.ids?.length) {
      conditions.push(`id IN (${query.ids.map(() => "?").join(", ")})`);
      params.push(...query.ids);
    }
    if (query.types?.length) {
      conditions.push(`type IN (${query.types.map(() => "?").join(", ")})`);
      params.push(...query.types);
    }
    if (query.namespace) {
      conditions.push("namespace = ?");
      params.push(query.namespace);
    }
    if (query.category) {
      conditions.push("category = ?");
      params.push(query.category);
    }
    if (query.importanceMin !== undefined) {
      conditions.push("importance >= ?");
      params.push(query.importanceMin);
    }
    if (!query.includeArchived) {
      conditions.push("status = 'active'");
    }
    if (query.status?.length) {
      conditions.push(`status IN (${query.status.map(() => "?").join(", ")})`);
      params.push(...query.status);
    }
    if (query.timeRange?.after) {
      conditions.push("created_at >= ?");
      params.push(query.timeRange.after);
    }
    if (query.timeRange?.before) {
      conditions.push("created_at <= ?");
      params.push(query.timeRange.before);
    }
    if (query.contentQuery) {
      conditions.push("(content LIKE ? OR summary LIKE ?)");
      params.push(`%${query.contentQuery}%`, `%${query.contentQuery}%`);
    }
    if (query.tags?.length) {
      for (const tag of query.tags) {
        conditions.push("tags LIKE ?");
        params.push(`%${tag}%`);
      }
    }
    const sql = `SELECT * FROM memories ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(query.limit ?? 50, query.offset ?? 0);
    return this.db.prepare(sql).all(...params).map((row) => mapMemory(row as Row));
  }

  async textSearch(query: string, options: TextSearchOptions): Promise<ScoredMemory[]> {
    const limit = options.limit ?? 10;
    const matchQuery = query
      .split(/\s+/)
      .map((term) => term.replace(/[^a-zA-Z0-9_*]/g, ""))
      .filter(Boolean)
      .join(" OR ");
    if (!matchQuery) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(memories_fts, 10.0, 5.0, 2.0) AS rank
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ?
         ${options.namespace ? "AND m.namespace = ?" : ""}
         ${options.includeArchived ? "" : "AND m.status = 'active'"}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...(options.namespace ? [matchQuery, options.namespace, limit] : [matchQuery, limit])) as Row[];
    return rows.map((row) => ({
      ...mapMemory(row),
      score: 1 / (1 + Math.abs(Number(row.rank ?? 0))),
    }));
  }

  async purge(id: string): Promise<void> {
    this.db.prepare("DELETE FROM episodes WHERE memory_id = ?").run(id);
    this.db.prepare("DELETE FROM facts WHERE memory_id = ?").run(id);
    this.db.prepare("DELETE FROM procedures WHERE memory_id = ?").run(id);
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }
}

class SqliteGraphStore implements GraphStore {
  constructor(private readonly db: Db, private readonly events: EventLog, private readonly defaultNamespace: string) {}

  async createEntity(entity: EntityInput): Promise<Entity> {
    const id = entity.id ?? newId();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO entities (id, name, entity_type, namespace, description, properties, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, namespace) DO UPDATE SET
           entity_type = excluded.entity_type,
           description = excluded.description,
           properties = excluded.properties,
           updated_at = excluded.updated_at,
           status = excluded.status`,
      )
      .run(
        id,
        entity.name,
        entity.entityType,
        entity.namespace ?? this.defaultNamespace,
        entity.description ?? null,
        JSON.stringify(entity.properties ?? {}),
        timestamp,
        timestamp,
        "active",
      );
    const row = this.db
      .prepare("SELECT * FROM entities WHERE name = ? AND namespace = ?")
      .get(entity.name, entity.namespace ?? this.defaultNamespace) as Row;
    const record = mapEntity(row);
    if (entity.observations?.length) {
      for (const observation of entity.observations) {
        await this.addObservation({ ...observation, entityId: record.id, namespace: record.namespace });
      }
    }
    await this.events.append({
      action: "create",
      targetType: "entity",
      targetId: record.id,
      data: { namespace: record.namespace, entity_type: record.entityType },
    });
    return record;
  }

  async updateEntity(id: string, fields: Partial<Entity>): Promise<void> {
    const updates: string[] = [];
    const params: unknown[] = [];
    const mapping: Record<string, string> = {
      name: "name",
      entityType: "entity_type",
      namespace: "namespace",
      description: "description",
      properties: "properties",
      status: "status",
    };
    for (const [key, column] of Object.entries(mapping)) {
      const value = fields[key as keyof Entity];
      if (value !== undefined) {
        updates.push(`${column} = ?`);
        params.push(key === "properties" ? JSON.stringify(value) : value);
      }
    }
    updates.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db.prepare(`UPDATE entities SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    await this.events.append({
      action: "update",
      targetType: "entity",
      targetId: id,
      data: { fields_changed: Object.keys(fields) },
    });
  }

  async createRelation(relation: RelationInput): Promise<Relation> {
    const id = relation.id ?? newId();
    const createdAt = relation.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO relations (id, from_entity, to_entity, relation_type, properties, weight, bidirectional, namespace, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(from_entity, to_entity, relation_type) DO UPDATE SET
           properties = excluded.properties,
           weight = excluded.weight,
           bidirectional = excluded.bidirectional,
           status = excluded.status`,
      )
      .run(
        id,
        relation.fromEntity,
        relation.toEntity,
        relation.relationType,
        JSON.stringify(relation.properties ?? {}),
        relation.weight ?? 1,
        relation.bidirectional ? 1 : 0,
        relation.namespace ?? this.defaultNamespace,
        createdAt,
        relation.status ?? "active",
      );
    const row = this.db
      .prepare("SELECT * FROM relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ?")
      .get(relation.fromEntity, relation.toEntity, relation.relationType) as Row;
    const record = mapRelation(row);
    await this.events.append({
      action: "create",
      targetType: "relation",
      targetId: record.id,
      data: { namespace: record.namespace, relation_type: record.relationType },
    });
    return record;
  }

  async addObservation(obs: ObservationInput): Promise<Observation> {
    if (!obs.entityId) {
      throw new Error("Observation requires entityId");
    }
    const id = obs.id ?? newId();
    this.db
      .prepare(
        `INSERT INTO observations (id, entity_id, content, observer, namespace, observed_at, confidence, source, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        obs.entityId,
        sanitizeText(obs.content),
        obs.observer ?? null,
        obs.namespace ?? this.defaultNamespace,
        obs.observedAt ?? nowIso(),
        obs.confidence ?? 0.8,
        obs.source ?? null,
        obs.status ?? "active",
      );
    const row = this.db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as Row;
    const record = mapObservation(row);
    await this.events.append({
      action: "create",
      targetType: "observation",
      targetId: record.id,
      data: { namespace: record.namespace, confidence: record.confidence },
    });
    return record;
  }

  async traverse(start: string, options: TraversalOptions): Promise<GraphResult> {
    const depthLimit = options.depth ?? 2;
    const relationTypes = options.relationTypes ?? [];
    const visited = new Set<string>();
    const seenEdges = new Set<string>();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const queue: Array<{ entityId: string; depth: number }> = [{ entityId: start, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift() as { entityId: string; depth: number };
      if (visited.has(current.entityId) || current.depth > depthLimit) {
        continue;
      }
      visited.add(current.entityId);
      const entityRow = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(current.entityId) as Row | undefined;
      if (!entityRow) {
        continue;
      }
      nodes.push({ entity: mapEntity(entityRow), depth: current.depth });
      const relations = this.db
        .prepare(
          `SELECT * FROM relations
           WHERE status = 'active'
             AND namespace = ?
             AND (from_entity = ? OR to_entity = ?)
             ${relationTypes.length ? `AND relation_type IN (${relationTypes.map(() => "?").join(", ")})` : ""}
           LIMIT ?`,
        )
        .all(options.namespace ?? this.defaultNamespace, current.entityId, current.entityId, ...relationTypes, options.limit ?? 100) as Row[];
      for (const relationRow of relations) {
        const relation = mapRelation(relationRow);
        if (seenEdges.has(relation.id)) {
          continue;
        }
        seenEdges.add(relation.id);
        const from = mapEntity(this.db.prepare("SELECT * FROM entities WHERE id = ?").get(relation.fromEntity) as Row);
        const to = mapEntity(this.db.prepare("SELECT * FROM entities WHERE id = ?").get(relation.toEntity) as Row);
        edges.push({ relation, from, to });
        const next = relation.fromEntity === current.entityId ? relation.toEntity : relation.fromEntity;
        if (!visited.has(next)) {
          queue.push({ entityId: next, depth: current.depth + 1 });
        }
      }
    }
    return { nodes, edges };
  }

  async searchEntities(query: EntityQuery): Promise<Entity[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.namespace) {
      conditions.push("namespace = ?");
      params.push(query.namespace);
    }
    if (query.name) {
      conditions.push("name LIKE ?");
      params.push(`%${query.name}%`);
    }
    if (query.entityType) {
      conditions.push("entity_type = ?");
      params.push(query.entityType);
    }
    const sql = `SELECT * FROM entities ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`;
    params.push(query.limit ?? 20);
    return this.db.prepare(sql).all(...params).map((row) => mapEntity(row as Row));
  }

  async searchRelations(query: RelationQuery): Promise<Relation[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.namespace) {
      conditions.push("namespace = ?");
      params.push(query.namespace);
    }
    if (query.relationType) {
      conditions.push("relation_type = ?");
      params.push(query.relationType);
    }
    if (query.entityId) {
      conditions.push("(from_entity = ? OR to_entity = ?)");
      params.push(query.entityId, query.entityId);
    }
    const sql = `SELECT * FROM relations ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    params.push(query.limit ?? 20);
    return this.db.prepare(sql).all(...params).map((row) => mapRelation(row as Row));
  }

  async purgeEntity(id: string): Promise<void> {
    this.db.prepare("DELETE FROM observations WHERE entity_id = ?").run(id);
    this.db.prepare("DELETE FROM relations WHERE from_entity = ? OR to_entity = ?").run(id, id);
    this.db.prepare("DELETE FROM entities WHERE id = ?").run(id);
  }
}

class SqliteVectorStore implements VectorStore {
  constructor(private readonly db: Db) {}

  async store(memoryId: string, chunkIndex: number, embedding: EmbeddingData): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO embeddings (id, memory_id, chunk_index, chunk_text, vector, model, dimensions, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        embedding.id ?? newId(),
        memoryId,
        chunkIndex,
        embedding.chunkText,
        encodeVector(embedding.vector),
        embedding.model,
        embedding.dimensions,
        embedding.version ?? 1,
        embedding.createdAt ?? nowIso(),
      );
  }

  async search(embedding: number[], options: VectorSearchOptions): Promise<ScoredMemory[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.namespace) {
      conditions.push("m.namespace = ?");
      params.push(options.namespace);
    }
    if (!options.includeArchived) {
      conditions.push("m.status = 'active'");
    }
    if (options.types?.length) {
      conditions.push(`m.type IN (${options.types.map(() => "?").join(", ")})`);
      params.push(...options.types);
    }
    const rows = this.db
      .prepare(
        `SELECT e.vector, e.chunk_index, e.memory_id, m.*
         FROM embeddings e
         JOIN memories m ON m.id = e.memory_id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY m.created_at DESC, e.chunk_index ASC`,
      )
      .all(...params) as Array<Row & { vector: Buffer }>;

    const bestByMemory = new Map<string, ScoredMemory>();
    for (const row of rows) {
      const memory = mapMemory(row);
      const score = Number(cosineSimilarity(embedding, decodeVector(row.vector)).toFixed(6));
      const current = bestByMemory.get(memory.id);
      if (!current || score > current.score) {
        bestByMemory.set(memory.id, { ...memory, score });
      }
    }

    return [...bestByMemory.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, options.limit ?? 10);
  }

  async delete(memoryId: string): Promise<void> {
    this.db.prepare("DELETE FROM embeddings WHERE memory_id = ?").run(memoryId);
  }

  async reindex(filter: ReindexFilter): Promise<number> {
    const memories = this.db
      .prepare(
        `SELECT id FROM memories
         ${filter.namespace || filter.memoryIds?.length ? "WHERE " : ""}
         ${filter.namespace ? "namespace = ?" : ""}
         ${filter.namespace && filter.memoryIds?.length ? " AND " : ""}
         ${filter.memoryIds?.length ? `id IN (${filter.memoryIds.map(() => "?").join(", ")})` : ""}`,
      )
      .all(...[...(filter.namespace ? [filter.namespace] : []), ...(filter.memoryIds ?? [])]) as Row[];
    return memories.length;
  }
}

class SqliteJobQueue implements JobQueue {
  constructor(private readonly db: Db) {}

  async enqueue(job: Job): Promise<string> {
    const id = job.id ?? newId();
    this.db
      .prepare(
        `INSERT INTO job_queue (id, type, payload, status, priority, attempts, max_attempts, error, created_at, started_at, completed_at, next_retry_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        job.type,
        JSON.stringify(job.payload),
        job.status ?? "pending",
        job.priority ?? 0,
        job.attempts ?? 0,
        job.maxAttempts ?? 3,
        job.error ?? null,
        job.createdAt ?? nowIso(),
        job.startedAt ?? null,
        job.completedAt ?? null,
        job.nextRetryAt ?? null,
      );
    return id;
  }

  async dequeue(): Promise<Job | null> {
    return this.dequeueByType();
  }

  async dequeueByType(type?: string): Promise<Job | null> {
    const claimed = claimPendingJob(this.db, type);
    return claimed ? { ...claimed } : null;
  }

  async complete(id: string): Promise<void> {
    this.db.prepare("UPDATE job_queue SET status = 'completed', completed_at = ? WHERE id = ?").run(nowIso(), id);
  }

  async fail(id: string, error: string): Promise<void> {
    this.db
      .prepare(
        "UPDATE job_queue SET status = 'failed', error = ?, attempts = attempts + 1, next_retry_at = ? WHERE id = ?",
      )
      .run(error, new Date(Date.now() + 60_000).toISOString(), id);
  }

  async retry(id: string): Promise<void> {
    this.db.prepare("UPDATE job_queue SET status = 'pending', error = NULL WHERE id = ?").run(id);
  }

  async stats(): Promise<QueueStats> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM job_queue GROUP BY status").all() as Row[];
    const lookup = new Map(rows.map((row) => [String(row.status), Number(row.count)]));
    return {
      pending: lookup.get("pending") ?? 0,
      processing: lookup.get("processing") ?? 0,
      completed: lookup.get("completed") ?? 0,
      failed: lookup.get("failed") ?? 0,
    };
  }
}

export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly blobsPath: string, private readonly db: Db, private readonly defaultNamespace: string) {}

  async store(data: Buffer, metadata: BlobMetadata): Promise<string> {
    const id = newId();
    const namespace = metadata.namespace ?? this.defaultNamespace;
    const extension = metadata.filename?.includes(".") ? `.${metadata.filename.split(".").pop()}` : "";
    const filename = `${id}${extension}`;
    const relativePath = path.join(namespace, filename);
    const fullPath = path.join(this.blobsPath, relativePath);
    await writeBuffer(fullPath, data);
    this.db
      .prepare(
        "INSERT INTO memories (id, type, namespace, content, summary, content_hash, category, tags, importance, source, agent_id, session_id, created_at, updated_at, status) VALUES (?, 'blob_ref', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        namespace,
        relativePath,
        metadata.filename ?? null,
        sha256(data.toString("base64")),
        "blob",
        JSON.stringify([]),
        0.5,
        metadata.source ?? null,
        null,
        null,
        nowIso(),
        nowIso(),
        "active",
      );
    return id;
  }

  async get(id: string): Promise<Buffer> {
    const row = this.db.prepare("SELECT content FROM memories WHERE id = ? AND type = 'blob_ref'").get(id) as Row | undefined;
    if (!row) {
      throw new Error(`Blob ${id} not found`);
    }
    return readFile(path.join(this.blobsPath, String(row.content)));
  }

  async delete(id: string): Promise<void> {
    const row = this.db.prepare("SELECT content FROM memories WHERE id = ? AND type = 'blob_ref'").get(id) as Row | undefined;
    if (row) {
      await removeIfExists(path.join(this.blobsPath, String(row.content)));
    }
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  async list(filter?: BlobFilter): Promise<BlobInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT id, namespace, content, summary, source, created_at
         FROM memories
         WHERE type = 'blob_ref'
         ${filter?.namespace ? "AND namespace = ?" : ""}
         ORDER BY created_at DESC`,
      )
      .all(...(filter?.namespace ? [filter.namespace] : [])) as Row[];
    return Promise.all(
      rows.map(async (row) => ({
        id: String(row.id),
        namespace: String(row.namespace),
        path: String(row.content),
        filename: row.summary ? String(row.summary) : null,
        mimeType: null,
        size: await fileSize(path.join(this.blobsPath, String(row.content))),
        createdAt: String(row.created_at),
      })),
    );
  }
}

class SqliteLifecycleManager implements LifecycleManager {
  constructor(
    private readonly db: Db,
    private readonly options: Required<SqliteBackendOptions>,
  ) {}

  async initialize(): Promise<void> {
    await ensureDir(path.dirname(this.options.dbPath));
    await ensureDir(this.options.blobsPath);
    await ensureDir(this.options.backupsPath);
    await this.migrate();
  }

  async backup(label?: string): Promise<string> {
    this.db.pragma("wal_checkpoint(FULL)");
    return createBackupFile(this.options.dbPath, this.options.backupsPath, label);
  }

  async restore(backupId: string): Promise<void> {
    this.db.close();
    await restoreBackupFile(this.options.dbPath, this.options.backupsPath, backupId);
  }

  async migrate(): Promise<MigrationResult> {
    const migrations = await loadMigrations(this.options.migrationsDir);
    const hasTable = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as Row | undefined;
    const appliedRows = hasTable ? ((this.db.prepare("SELECT version, checksum FROM schema_migrations").all() as Row[])) : [];
    const applied = new Map(appliedRows.map((row) => [Number(row.version), String(row.checksum)]));
    const versions: number[] = [];
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing === migration.checksum) {
        continue;
      }
      if (existing && existing !== migration.checksum) {
        throw new Error(`Migration checksum mismatch for version ${migration.version}`);
      }
      this.db.exec(migration.sql);
      this.db
        .prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, nowIso(), migration.checksum);
      versions.push(migration.version);
    }
    return { applied: versions.length, versions };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export class SqliteMnemosyneBackend implements MnemosyneBackend {
  public readonly db: Db;
  public readonly memories: MemoryStore;
  public readonly graph: GraphStore;
  public readonly vectors: VectorStore;
  public readonly queue: JobQueue;
  public readonly blobs: BlobStore;
  public readonly events: EventLog;
  public readonly lifecycle: LifecycleManager;
  public readonly options: Required<SqliteBackendOptions>;

  constructor(options: SqliteBackendOptions = {}) {
    this.options = {
      dbPath: options.dbPath ?? path.join(process.cwd(), "data", "mnemosyne.db"),
      blobsPath: options.blobsPath ?? path.join(process.cwd(), "data", "blobs"),
      backupsPath: options.backupsPath ?? path.join(process.cwd(), "data", "backups"),
      migrationsDir: options.migrationsDir ?? path.join(__dirname, "..", "migrations"),
      defaultNamespace: options.defaultNamespace ?? DEFAULT_NAMESPACE,
    };
    mkdirSync(path.dirname(this.options.dbPath), { recursive: true });
    mkdirSync(this.options.blobsPath, { recursive: true });
    mkdirSync(this.options.backupsPath, { recursive: true });
    this.db = new Database(this.options.dbPath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.events = new SqliteEventLog(this.db);
    this.memories = new SqliteMemoryStore(this.db, this.events, this.options.defaultNamespace);
    this.graph = new SqliteGraphStore(this.db, this.events, this.options.defaultNamespace);
    this.vectors = new SqliteVectorStore(this.db);
    this.queue = new SqliteJobQueue(this.db);
    this.blobs = new FilesystemBlobStore(this.options.blobsPath, this.db, this.options.defaultNamespace);
    this.lifecycle = new SqliteLifecycleManager(this.db, this.options);
  }
}

function claimPendingJob(db: Db, type?: string): ClaimedJob | null {
  const timestamp = nowIso();
  const row = db
    .prepare(
      `SELECT * FROM job_queue
       WHERE status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ${type ? "AND type = ?" : ""}
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
    )
    .get(...(type ? [timestamp, type] : [timestamp])) as Row | undefined;
  if (!row) {
    return null;
  }
  db.prepare("UPDATE job_queue SET status = 'processing', started_at = ? WHERE id = ?").run(timestamp, row.id);
  return {
    id: String(row.id),
    type: String(row.type),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    status: "processing",
    priority: Number(row.priority ?? 0),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    startedAt: timestamp,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : null,
  };
}

export async function dequeueTypedJob(backend: SqliteMnemosyneBackend, type: string): Promise<Job | null> {
  return claimPendingJob(backend.db, type);
}

export interface PurgeResult {
  purged: number;
  auditId: string;
}

export async function purgeTarget(backend: SqliteMnemosyneBackend, targetId: string, reason: string, cascade = true): Promise<PurgeResult> {
  const salt = randomBytes(32);
  const reasonHmac = hmacSha256(reason, salt);
  const auditId = newId();
  let purged = 0;
  let blobPath: string | null = null;
  const tx = backend.db.transaction(() => {
    const memory = backend.db.prepare("SELECT id, type, content FROM memories WHERE id = ?").get(targetId) as Row | undefined;
    const entity = backend.db.prepare("SELECT id FROM entities WHERE id = ?").get(targetId) as Row | undefined;
    const relation = backend.db.prepare("SELECT id FROM relations WHERE id = ?").get(targetId) as Row | undefined;
    if (memory) {
      backend.db.prepare("DELETE FROM embeddings WHERE memory_id = ?").run(targetId);
      if (cascade && String(memory.type) === "blob_ref") {
        blobPath = path.join(backend.options.blobsPath, String(memory.content));
      }
      backend.db.prepare("DELETE FROM episodes WHERE memory_id = ?").run(targetId);
      backend.db.prepare("DELETE FROM facts WHERE memory_id = ?").run(targetId);
      backend.db.prepare("DELETE FROM procedures WHERE memory_id = ?").run(targetId);
      backend.db.prepare("DELETE FROM memories WHERE id = ?").run(targetId);
      purged += 1;
      backend.db
        .prepare("INSERT OR REPLACE INTO purge_tombstones (target_id, target_type, purged_at, reason_hmac) VALUES (?, ?, ?, ?)")
        .run(targetId, "memory", nowIso(), reasonHmac);
    } else if (entity) {
      if (cascade) {
        backend.db.prepare("DELETE FROM observations WHERE entity_id = ?").run(targetId);
        backend.db.prepare("DELETE FROM relations WHERE from_entity = ? OR to_entity = ?").run(targetId, targetId);
      }
      backend.db.prepare("DELETE FROM entities WHERE id = ?").run(targetId);
      purged += 1;
      backend.db
        .prepare("INSERT OR REPLACE INTO purge_tombstones (target_id, target_type, purged_at, reason_hmac) VALUES (?, ?, ?, ?)")
        .run(targetId, "entity", nowIso(), reasonHmac);
    } else if (relation) {
      backend.db.prepare("DELETE FROM relations WHERE id = ?").run(targetId);
      purged += 1;
      backend.db
        .prepare("INSERT OR REPLACE INTO purge_tombstones (target_id, target_type, purged_at, reason_hmac) VALUES (?, ?, ?, ?)")
        .run(targetId, "relation", nowIso(), reasonHmac);
    } else {
      throw new Error(`Target ${targetId} not found`);
    }
  });
  tx();
  if (blobPath) {
    await removeIfExists(blobPath);
  }
  await backend.events.append({
    id: auditId,
    action: "purge",
    targetType: "memory",
    targetId,
    data: {
      reason_hmac: reasonHmac,
      records_purged: purged,
      content_hmac: hmacSha256(targetId, salt),
    },
  });
  return { purged, auditId };
}

export function synthesizeEmbedding(text: string, dimensions = 16): number[] {
  const output = new Array<number>(dimensions).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    output[index % dimensions] += text.charCodeAt(index) / 255;
  }
  return output.map((value) => Number((value / Math.max(text.length, 1)).toFixed(6)));
}

export function detectEntities(content: string): string[] {
  const matches = content.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) ?? [];
  return [...new Set(matches)].slice(0, 10);
}

export function classifyMemory(input: {
  content: string;
  type?: "episode" | "fact" | "procedure" | "auto";
  name?: string;
  steps?: string[];
  entityName?: string;
  factType?: string;
  confidence?: number;
  eventType?: string;
  participants?: string[];
}): "episode" | "fact" | "procedure" {
  if (input.type && input.type !== "auto") {
    return input.type;
  }
  const normalized = input.content.toLowerCase();
  const workflowPattern = /(step\s+\d+|first[, ]|then[, ]|finally[, ]|procedure|workflow|runbook)/;
  if ((input.steps && input.steps.length > 0) || (input.name && workflowPattern.test(`${input.name} ${input.content}`.toLowerCase()))) {
    return "procedure";
  }
  if ((input.entityName && input.factType) || input.confidence !== undefined) {
    return "fact";
  }
  if (input.eventType || (input.participants && input.participants.length > 0)) {
    return "episode";
  }
  if (/(prefere|gosta|usa|mora)/.test(normalized)) {
    return "fact";
  }
  return "episode";
}

export function recencyScore(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  const days = Math.max(0, (Date.now() - created) / 86_400_000);
  return 1 / (1 + days * 0.01);
}

export function importanceDecay(importance: number, createdAt: string, lastAccessedAt?: string | null): number {
  const referenceTime = Math.max(new Date(createdAt).getTime(), new Date(lastAccessedAt ?? createdAt).getTime());
  const days = Math.max(0, (Date.now() - referenceTime) / 86_400_000);
  return Number(Math.max(0.1, importance * 0.95 ** days).toFixed(6));
}

export function fuseScores(parts: ScoreBreakdown): number {
  return Number(
    (
      0.35 * parts.semantic +
      0.2 * parts.text +
      0.15 * parts.graph +
      0.15 * parts.recency +
      0.15 * parts.importance
    ).toFixed(6),
  );
}
