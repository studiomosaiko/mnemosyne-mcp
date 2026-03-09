import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  type BlobStore,
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
  type LifecycleManager,
  type Memory,
  type MemoryInput,
  type MemoryStore,
  type MigrationResult,
  type Observation,
  type ObservationInput,
  type ProcedureDetailsInput,
  type Relation,
  type RelationInput,
  type RelationQuery,
  type ScoredMemory,
  type StructuredQuery,
  type TextSearchOptions,
  type TraversalOptions,
} from "../interfaces/index.js";
import { FilesystemBlobStore } from "../sqlite/backend.js";
import {
  DEFAULT_NAMESPACE,
  ensureDir,
  fileSize,
  hmacSha256,
  loadMigrations,
  newId,
  nowIso,
  parseJsonArray,
  parseJsonObject,
  removeIfExists,
  sanitizeText,
  sha256,
} from "../sqlite/utils.js";

type Row = QueryResultRow & Record<string, unknown>;

export interface PostgresBackendOptions {
  pool: Pool;
  blobsPath: string;
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

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function scoreText(query: string, memory: Memory): number {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  if (terms.length === 0) {
    return 0;
  }
  const haystack = `${memory.content} ${memory.summary ?? ""} ${memory.tags.join(" ")}`.toLowerCase();
  let matches = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      matches += 1;
    }
  }
  return Number((matches / terms.length).toFixed(6));
}

export class PostgresEventLog implements EventLog {
  constructor(private readonly pool: Pool) {}

  async append(event: EventInput): Promise<void> {
    const timestamp = event.timestamp ?? nowIso();
    const id = event.id ?? newId();
    const data = event.data ? JSON.stringify(event.data) : null;
    await withTransaction(this.pool, async (client) => {
      await client.query("LOCK TABLE event_log IN EXCLUSIVE MODE");
      const last = await client.query<{ hash: string }>(
        "SELECT hash FROM event_log ORDER BY timestamp DESC, id DESC LIMIT 1",
      );
      const prevHash = last.rows[0]?.hash ?? null;
      const hash = sha256(`${id}${timestamp}${event.action}${event.targetId}${data ?? ""}${prevHash ?? ""}`);
      await client.query(
        `INSERT INTO event_log (id, timestamp, agent_id, action, target_type, target_id, data, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, timestamp, event.agentId ?? null, event.action, event.targetType, event.targetId, data, prevHash, hash],
      );
    });
  }

  async query(filter: EventFilter): Promise<EventRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.targetId) {
      params.push(filter.targetId);
      conditions.push(`target_id = $${params.length}`);
    }
    if (filter.action) {
      params.push(filter.action);
      conditions.push(`action = $${params.length}`);
    }
    params.push(filter.limit ?? 100);
    const result = await this.pool.query(
      `SELECT * FROM event_log
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY timestamp DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => mapEvent(row));
  }

  async verify(): Promise<{ valid: boolean; brokenAt?: string }> {
    const result = await this.pool.query("SELECT * FROM event_log ORDER BY timestamp ASC, id ASC");
    let previousHash: string | null = null;
    for (const row of result.rows) {
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

export class PostgresMemoryStore implements MemoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly events: EventLog,
    private readonly defaultNamespace: string,
  ) {}

  async create(memory: MemoryInput): Promise<Memory> {
    const procedureDetails = memory.type === "procedure" ? ((memory.details ?? {}) as ProcedureDetailsInput) : null;
    const namespace = memory.namespace ?? this.defaultNamespace;
    const id = memory.id ?? newId();
    const timestamp = memory.createdAt ?? nowIso();
    const normalized = {
      id,
      type: memory.type,
      namespace,
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

    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO memories
         (id, type, namespace, content, summary, content_hash, category, tags, importance, source, agent_id, session_id,
          created_at, updated_at, status, superseded_by, expires_at, embedding_model, embedding_version, embedded_at)
         VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
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
        ],
      );

      if (memory.type === "episode") {
        const details = (memory.details ?? {}) as Exclude<MemoryInput["details"], undefined>;
        await client.query(
          `INSERT INTO episodes (memory_id, event_type, participants, location, outcome, emotions, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (memory_id) DO UPDATE SET
             event_type = excluded.event_type,
             participants = excluded.participants,
             location = excluded.location,
             outcome = excluded.outcome,
             emotions = excluded.emotions,
             duration_ms = excluded.duration_ms`,
          [
            id,
            "eventType" in details && details.eventType ? details.eventType : "general",
            JSON.stringify("participants" in details && details.participants ? details.participants : []),
            "location" in details ? (details.location ?? null) : null,
            "outcome" in details ? (details.outcome ?? null) : null,
            JSON.stringify("emotions" in details && details.emotions ? details.emotions : []),
            "durationMs" in details ? (details.durationMs ?? null) : null,
          ],
        );
      }

      if (memory.type === "fact") {
        const details = (memory.details ?? {}) as FactDetailsInput;
        await client.query(
          `INSERT INTO facts (memory_id, entity_name, entity_type, fact_type, confidence, valid_from, valid_until, contradicts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (memory_id) DO UPDATE SET
             entity_name = excluded.entity_name,
             entity_type = excluded.entity_type,
             fact_type = excluded.fact_type,
             confidence = excluded.confidence,
             valid_from = excluded.valid_from,
             valid_until = excluded.valid_until,
             contradicts = excluded.contradicts`,
          [
            id,
            details.entityName ?? "unknown",
            details.entityType ?? null,
            details.factType ?? "attribute",
            details.confidence ?? 0.8,
            details.validFrom ?? null,
            details.validUntil ?? null,
            details.contradicts ?? null,
          ],
        );
      }

      if (memory.type === "procedure") {
        const details = procedureDetails ?? {};
        await client.query(
          `INSERT INTO procedures
           (memory_id, name, namespace, version, steps, prerequisites, triggers, success_count, failure_count, avg_duration_ms, last_used_at, last_result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (name, namespace) DO UPDATE SET
             memory_id = excluded.memory_id,
             version = excluded.version,
             steps = excluded.steps,
             prerequisites = excluded.prerequisites,
             triggers = excluded.triggers,
             success_count = excluded.success_count,
             failure_count = excluded.failure_count,
             avg_duration_ms = excluded.avg_duration_ms,
             last_used_at = excluded.last_used_at,
             last_result = excluded.last_result`,
          [
            id,
            details.name ?? "unnamed-procedure",
            namespace,
            details.version ?? 1,
            JSON.stringify(details.steps ?? []),
            JSON.stringify(details.prerequisites ?? []),
            JSON.stringify(details.triggers ?? []),
            details.successCount ?? 0,
            details.failureCount ?? 0,
            details.avgDurationMs ?? null,
            details.lastUsedAt ?? null,
            details.lastResult ?? null,
          ],
        );
      }
    });

    await this.events.append({
      action: "create",
      targetType: "memory",
      targetId: id,
      agentId: memory.agentId ?? null,
      data: { type: memory.type, namespace, tags: memory.tags ?? [], importance: memory.importance ?? 0.5 },
    });

    return (await this.get(id)) as Memory;
  }

  async get(id: string): Promise<Memory | null> {
    const result = await this.pool.query("SELECT * FROM memories WHERE id = $1", [id]);
    return result.rows[0] ? mapMemory(result.rows[0]) : null;
  }

  async update(id: string, fields: Partial<Memory>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Memory ${id} not found`);
    }
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
    const updates: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(mapping)) {
      const value = fields[key as keyof Memory];
      if (value !== undefined) {
        params.push(key === "tags" ? JSON.stringify(value) : value);
        updates.push(`${column} = $${params.length}`);
      }
    }
    params.push(nowIso());
    updates.push(`updated_at = $${params.length}`);
    params.push(id);
    await this.pool.query(`UPDATE memories SET ${updates.join(", ")} WHERE id = $${params.length}`, params);
    await this.events.append({
      action: fields.status === "archived" ? "archive" : "update",
      targetType: "memory",
      targetId: id,
      data: { fields_changed: Object.keys(fields), old_status: existing.status, new_status: fields.status ?? existing.status },
    });
  }

  async search(query: StructuredQuery): Promise<Memory[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.ids?.length) {
      params.push(query.ids);
      conditions.push(`id = ANY($${params.length})`);
    }
    if (query.types?.length) {
      params.push(query.types);
      conditions.push(`type = ANY($${params.length})`);
    }
    if (query.namespace) {
      params.push(query.namespace);
      conditions.push(`namespace = $${params.length}`);
    }
    if (query.category) {
      params.push(query.category);
      conditions.push(`category = $${params.length}`);
    }
    if (query.importanceMin !== undefined) {
      params.push(query.importanceMin);
      conditions.push(`importance >= $${params.length}`);
    }
    if (!query.includeArchived) {
      conditions.push("status = 'active'");
    }
    if (query.status?.length) {
      params.push(query.status);
      conditions.push(`status = ANY($${params.length})`);
    }
    if (query.timeRange?.after) {
      params.push(query.timeRange.after);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (query.timeRange?.before) {
      params.push(query.timeRange.before);
      conditions.push(`created_at <= $${params.length}`);
    }
    if (query.contentQuery) {
      params.push(`%${query.contentQuery}%`);
      params.push(`%${query.contentQuery}%`);
      conditions.push(`(content ILIKE $${params.length - 1} OR summary ILIKE $${params.length})`);
    }
    if (query.tags?.length) {
      for (const tag of query.tags) {
        params.push(`%${tag}%`);
        conditions.push(`tags ILIKE $${params.length}`);
      }
    }
    params.push(query.limit ?? 50);
    params.push(query.offset ?? 0);
    const result = await this.pool.query(
      `SELECT * FROM memories
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows.map((row) => mapMemory(row));
  }

  async textSearch(query: string, options: TextSearchOptions): Promise<ScoredMemory[]> {
    const result = await this.pool.query(
      `SELECT * FROM memories
       WHERE ($1::text IS NULL OR namespace = $1)
         AND ($2::boolean OR status = 'active')
         AND (content ILIKE $3 OR COALESCE(summary, '') ILIKE $3 OR COALESCE(tags, '') ILIKE $3)
       ORDER BY created_at DESC
       LIMIT $4`,
      [options.namespace ?? null, Boolean(options.includeArchived), `%${query}%`, (options.limit ?? 10) * 4],
    );
    return result.rows
      .map((row) => mapMemory(row))
      .map((memory) => ({ ...memory, score: scoreText(query, memory) }))
      .filter((memory) => memory.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.limit ?? 10);
  }

  async countByType(namespace?: string): Promise<{ total: number; byType: Record<string, number>; namespaces: string[] }> {
    const counts = await this.pool.query<{ type: string; count: string }>(
      `SELECT type, COUNT(*)::text AS count
       FROM memories
       WHERE ($1::text IS NULL OR namespace = $1)
       GROUP BY type`,
      [namespace ?? null],
    );
    const namespacesResult = namespace
      ? { rows: [{ namespace }] }
      : await this.pool.query<{ namespace: string }>("SELECT DISTINCT namespace FROM memories ORDER BY namespace");
    const byType = counts.rows.reduce<Record<string, number>>((accumulator, row) => {
      accumulator[row.type] = Number(row.count);
      return accumulator;
    }, {});
    return {
      total: counts.rows.reduce((sum, row) => sum + Number(row.count), 0),
      byType,
      namespaces: namespacesResult.rows.map((row) => row.namespace),
    };
  }

  async purge(id: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("DELETE FROM episodes WHERE memory_id = $1", [id]);
      await client.query("DELETE FROM facts WHERE memory_id = $1", [id]);
      await client.query("DELETE FROM procedures WHERE memory_id = $1", [id]);
      await client.query("DELETE FROM memories WHERE id = $1", [id]);
    });
  }
}

export class PostgresGraphStore implements GraphStore {
  constructor(
    private readonly pool: Pool,
    private readonly events: EventLog,
    private readonly defaultNamespace: string,
  ) {}

  async createEntity(entity: EntityInput): Promise<Entity> {
    const namespace = entity.namespace ?? this.defaultNamespace;
    const existing = (
      await this.pool.query<{ id: string }>("SELECT id FROM entities WHERE name = $1 AND namespace = $2", [entity.name, namespace])
    ).rows[0];
    const id = existing?.id ?? entity.id ?? newId();
    const timestamp = nowIso();
    await this.pool.query(
      `INSERT INTO entities (id, name, entity_type, namespace, description, properties, created_at, updated_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (name, namespace) DO UPDATE SET
         entity_type = excluded.entity_type,
         description = excluded.description,
         properties = excluded.properties,
         updated_at = excluded.updated_at,
         status = excluded.status`,
      [id, entity.name, entity.entityType, namespace, entity.description ?? null, JSON.stringify(entity.properties ?? {}), timestamp, timestamp, "active"],
    );
    const row = (
      await this.pool.query("SELECT * FROM entities WHERE name = $1 AND namespace = $2", [entity.name, namespace])
    ).rows[0];
    const record = mapEntity(row);
    if (entity.observations?.length) {
      for (const observation of entity.observations) {
        await this.addObservation({ ...observation, entityId: record.id, namespace: record.namespace });
      }
    }
    await this.events.append({
      action: existing ? "update" : "create",
      targetType: "entity",
      targetId: record.id,
      data: { namespace: record.namespace, entity_type: record.entityType },
    });
    return record;
  }

  async updateEntity(id: string, fields: Partial<Entity>): Promise<void> {
    const mapping: Record<string, string> = {
      name: "name",
      entityType: "entity_type",
      namespace: "namespace",
      description: "description",
      properties: "properties",
      status: "status",
    };
    const updates: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(mapping)) {
      const value = fields[key as keyof Entity];
      if (value !== undefined) {
        params.push(key === "properties" ? JSON.stringify(value) : value);
        updates.push(`${column} = $${params.length}`);
      }
    }
    params.push(nowIso());
    updates.push(`updated_at = $${params.length}`);
    params.push(id);
    await this.pool.query(`UPDATE entities SET ${updates.join(", ")} WHERE id = $${params.length}`, params);
    await this.events.append({ action: "update", targetType: "entity", targetId: id, data: { fields_changed: Object.keys(fields) } });
  }

  async createRelation(relation: RelationInput): Promise<Relation> {
    const id = relation.id ?? newId();
    const createdAt = relation.createdAt ?? nowIso();
    await this.pool.query(
      `INSERT INTO relations (id, from_entity, to_entity, relation_type, properties, weight, bidirectional, namespace, created_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (from_entity, to_entity, relation_type) DO UPDATE SET
         properties = excluded.properties,
         weight = excluded.weight,
         bidirectional = excluded.bidirectional,
         status = excluded.status`,
      [
        id,
        relation.fromEntity,
        relation.toEntity,
        relation.relationType,
        JSON.stringify(relation.properties ?? {}),
        relation.weight ?? 1,
        relation.bidirectional ?? false,
        relation.namespace ?? this.defaultNamespace,
        createdAt,
        relation.status ?? "active",
      ],
    );
    const row = (
      await this.pool.query(
        "SELECT * FROM relations WHERE from_entity = $1 AND to_entity = $2 AND relation_type = $3",
        [relation.fromEntity, relation.toEntity, relation.relationType],
      )
    ).rows[0];
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
    await this.pool.query(
      `INSERT INTO observations (id, entity_id, content, observer, namespace, observed_at, confidence, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        obs.entityId,
        sanitizeText(obs.content),
        obs.observer ?? null,
        obs.namespace ?? this.defaultNamespace,
        obs.observedAt ?? nowIso(),
        obs.confidence ?? 0.8,
        obs.source ?? null,
        obs.status ?? "active",
      ],
    );
    const row = (await this.pool.query("SELECT * FROM observations WHERE id = $1", [id])).rows[0];
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
      const entityRow = (await this.pool.query("SELECT * FROM entities WHERE id = $1", [current.entityId])).rows[0];
      if (!entityRow) {
        continue;
      }
      nodes.push({ entity: mapEntity(entityRow), depth: current.depth });
      const params: unknown[] = [options.namespace ?? this.defaultNamespace, current.entityId, current.entityId];
      const relationFilter = relationTypes.length ? `AND relation_type = ANY($4)` : "";
      if (relationTypes.length) {
        params.push(relationTypes);
      }
      params.push(options.limit ?? 100);
      const relations = await this.pool.query(
        `SELECT * FROM relations
         WHERE status = 'active'
           AND namespace = $1
           AND (from_entity = $2 OR to_entity = $3)
           ${relationFilter}
         LIMIT $${params.length}`,
        params,
      );
      for (const relationRow of relations.rows) {
        const relation = mapRelation(relationRow);
        if (seenEdges.has(relation.id)) {
          continue;
        }
        seenEdges.add(relation.id);
        const [fromRow, toRow] = await Promise.all([
          this.pool.query("SELECT * FROM entities WHERE id = $1", [relation.fromEntity]),
          this.pool.query("SELECT * FROM entities WHERE id = $1", [relation.toEntity]),
        ]);
        const from = mapEntity(fromRow.rows[0]);
        const to = mapEntity(toRow.rows[0]);
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
      params.push(query.namespace);
      conditions.push(`namespace = $${params.length}`);
    }
    if (query.name) {
      params.push(`%${query.name}%`);
      conditions.push(`name ILIKE $${params.length}`);
    }
    if (query.entityType) {
      params.push(query.entityType);
      conditions.push(`entity_type = $${params.length}`);
    }
    params.push(query.limit ?? 20);
    const result = await this.pool.query(
      `SELECT * FROM entities
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY updated_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => mapEntity(row));
  }

  async searchRelations(query: RelationQuery): Promise<Relation[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.namespace) {
      params.push(query.namespace);
      conditions.push(`namespace = $${params.length}`);
    }
    if (query.relationType) {
      params.push(query.relationType);
      conditions.push(`relation_type = $${params.length}`);
    }
    if (query.entityId) {
      params.push(query.entityId, query.entityId);
      conditions.push(`(from_entity = $${params.length - 1} OR to_entity = $${params.length})`);
    }
    params.push(query.limit ?? 20);
    const result = await this.pool.query(
      `SELECT * FROM relations
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => mapRelation(row));
  }

  async purgeEntity(id: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("DELETE FROM observations WHERE entity_id = $1", [id]);
      await client.query("DELETE FROM relations WHERE from_entity = $1 OR to_entity = $1", [id]);
      await client.query("DELETE FROM entities WHERE id = $1", [id]);
    });
  }
}

export class PostgresLifecycle implements LifecycleManager {
  private readonly migrationsDir: string;

  constructor(private readonly pool: Pool, options: Pick<PostgresBackendOptions, "migrationsDir">) {
    this.migrationsDir = options.migrationsDir ?? path.join(__dirname, "..", "migrations", "postgres");
  }

  async initialize(): Promise<void> {
    await this.migrate();
  }

  async backup(): Promise<string> {
    throw new Error("Postgres backup is not implemented in-process");
  }

  async restore(): Promise<void> {
    throw new Error("Postgres restore is not implemented in-process");
  }

  async migrate(): Promise<MigrationResult> {
    const migrations = await loadMigrations(this.migrationsDir);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL,
         checksum TEXT NOT NULL
       )`,
    );
    const appliedRows = await this.pool.query<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const applied = new Map(appliedRows.rows.map((row) => [Number(row.version), String(row.checksum)]));
    const versions: number[] = [];
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing === migration.checksum) {
        continue;
      }
      if (existing && existing !== migration.checksum) {
        throw new Error(`Migration checksum mismatch for version ${migration.version}`);
      }
      await withTransaction(this.pool, async (client) => {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, name, applied_at, checksum)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (version) DO NOTHING`,
          [migration.version, migration.name, nowIso(), migration.checksum],
        );
      });
      versions.push(migration.version);
    }
    return { applied: versions.length, versions };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface PostgresPurgeResult {
  purged: number;
  auditId: string;
}

export async function purgePostgresTarget(
  pool: Pool,
  events: EventLog,
  blobs: BlobStore,
  targetId: string,
  reason: string,
  cascade = true,
): Promise<PostgresPurgeResult> {
  const salt = randomBytes(32);
  const reasonHmac = hmacSha256(reason, salt);
  const auditId = newId();
  let purged = 0;
  let isBlob = false;

  await withTransaction(pool, async (client) => {
    const memory = (await client.query("SELECT id, type FROM memories WHERE id = $1", [targetId])).rows[0];
    const entity = (await client.query("SELECT id FROM entities WHERE id = $1", [targetId])).rows[0];
    const relation = (await client.query("SELECT id FROM relations WHERE id = $1", [targetId])).rows[0];

    if (memory) {
      isBlob = String(memory.type) === "blob_ref";
      await client.query("DELETE FROM embeddings WHERE memory_id = $1", [targetId]);
      await client.query("DELETE FROM episodes WHERE memory_id = $1", [targetId]);
      await client.query("DELETE FROM facts WHERE memory_id = $1", [targetId]);
      await client.query("DELETE FROM procedures WHERE memory_id = $1", [targetId]);
      await client.query("DELETE FROM memories WHERE id = $1", [targetId]);
      purged += 1;
      await client.query(
        `INSERT INTO purge_tombstones (target_id, target_type, purged_at, reason_hmac)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (target_id) DO UPDATE SET
           target_type = excluded.target_type,
           purged_at = excluded.purged_at,
           reason_hmac = excluded.reason_hmac`,
        [targetId, "memory", nowIso(), reasonHmac],
      );
      return;
    }

    if (entity) {
      if (cascade) {
        await client.query("DELETE FROM observations WHERE entity_id = $1", [targetId]);
        await client.query("DELETE FROM relations WHERE from_entity = $1 OR to_entity = $1", [targetId]);
      }
      await client.query("DELETE FROM entities WHERE id = $1", [targetId]);
      purged += 1;
      await client.query(
        `INSERT INTO purge_tombstones (target_id, target_type, purged_at, reason_hmac)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (target_id) DO UPDATE SET
           target_type = excluded.target_type,
           purged_at = excluded.purged_at,
           reason_hmac = excluded.reason_hmac`,
        [targetId, "entity", nowIso(), reasonHmac],
      );
      return;
    }

    if (relation) {
      await client.query("DELETE FROM relations WHERE id = $1", [targetId]);
      purged += 1;
      await client.query(
        `INSERT INTO purge_tombstones (target_id, target_type, purged_at, reason_hmac)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (target_id) DO UPDATE SET
           target_type = excluded.target_type,
           purged_at = excluded.purged_at,
           reason_hmac = excluded.reason_hmac`,
        [targetId, "relation", nowIso(), reasonHmac],
      );
      return;
    }

    throw new Error(`Target ${targetId} not found`);
  });

  if (isBlob && cascade) {
    try {
      await blobs.delete(targetId);
    } catch {
      // The memory row is already gone at this point; fall back to removing the file directly.
      const result = await pool.query("SELECT content FROM memories WHERE id = $1", [targetId]);
      const relativePath = result.rows[0]?.content ? String(result.rows[0].content) : null;
      if (relativePath) {
        await removeIfExists(relativePath);
      }
    }
  }

  await events.append({
    id: auditId,
    action: "purge",
    targetType: "memory",
    targetId,
    data: { reason_hmac: reasonHmac, records_purged: purged, content_hmac: hmacSha256(targetId, salt) },
  });
  return { purged, auditId };
}

export async function createPostgresBlobStore(options: PostgresBackendOptions): Promise<BlobStore> {
  await ensureDir(options.blobsPath);
  const dbAdapter = {
    prepare() {
      throw new Error("FilesystemBlobStore is only directly supported with SQLite");
    },
  };
  void dbAdapter;
  throw new Error("Use ServerMnemosyneBackend to construct the blob store");
}

export async function blobInfoFromPath(blobsPath: string, namespace: string, content: string, id: string, summary: string | null, source: string | null, createdAt: string) {
  return {
    id,
    namespace,
    path: content,
    filename: summary,
    mimeType: null,
    size: await fileSize(path.join(blobsPath, content)),
    createdAt,
    source,
  };
}

export async function readBlobFile(blobsPath: string, relativePath: string): Promise<Buffer> {
  return readFile(path.join(blobsPath, relativePath));
}
