import { z } from "zod";
import type { Memory, MnemosyneBackend, ProcedureDetailsInput, ScoredMemory } from "../interfaces/index.js";
import { StubEmbeddingProvider } from "../embeddings/stub-provider.js";
import { ServerMnemosyneBackend } from "../server-backend.js";
import {
  classifyMemory,
  detectEntities,
  fuseScores,
  importanceDecay,
  purgeTarget,
  recencyScore,
} from "../sqlite/backend.js";

const namespaceSchema = z.string().min(1).default("_");

const memoryAddSchema = z.object({
  content: z.string().min(1),
  type: z.enum(["episode", "fact", "procedure", "auto"]).optional().default("auto"),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional().default(0.5),
  namespace: namespaceSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  event_type: z.string().optional(),
  participants: z.array(z.string()).optional(),
  entity_name: z.string().optional(),
  fact_type: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  name: z.string().optional(),
  steps: z.array(z.string()).optional(),
});

const memorySearchSchema = z.object({
  types: z.array(z.enum(["episode", "fact", "procedure", "blob_ref"])).optional(),
  tags: z.array(z.string()).optional(),
  namespace: namespaceSchema.optional(),
  category: z.string().optional(),
  importance_min: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  include_archived: z.boolean().optional().default(false),
  query: z.string().optional(),
  time_range: z
    .object({
      after: z.string().optional(),
      before: z.string().optional(),
    })
    .optional(),
});

const memoryRecallSchema = z.object({
  query: z.string().min(1),
  types: z.array(z.enum(["episode", "fact", "procedure", "blob_ref"])).optional(),
  tags: z.array(z.string()).optional(),
  namespace: namespaceSchema.optional(),
  time_range: z
    .object({
      after: z.string().optional(),
      before: z.string().optional(),
    })
    .optional(),
  importance_min: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(50).optional().default(10),
  include_archived: z.boolean().optional().default(false),
  search_mode: z.enum(["hybrid", "semantic", "exact", "graph"]).optional().default("hybrid"),
});

const entityUpsertSchema = z.object({
  name: z.string().min(1),
  entity_type: z.string().min(1),
  namespace: namespaceSchema.optional(),
  description: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  observations: z
    .array(
      z.object({
        content: z.string().min(1),
        observer: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        source: z.string().optional(),
      }),
    )
    .optional(),
});

const relationUpsertSchema = z.object({
  from_entity: z.string().min(1),
  to_entity: z.string().min(1),
  relation_type: z.string().min(1),
  namespace: namespaceSchema.optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  weight: z.number().positive().optional().default(1),
  bidirectional: z.boolean().optional().default(false),
});

const graphTraverseSchema = z.object({
  start: z.string().min(1),
  namespace: namespaceSchema.optional(),
  depth: z.number().int().min(0).max(5).optional().default(2),
  relation_types: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(200).optional().default(100),
});

const graphSearchSchema = z.object({
  namespace: namespaceSchema.optional(),
  entity_name: z.string().optional(),
  entity_type: z.string().optional(),
  relation_type: z.string().optional(),
  entity_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const timelineSchema = z.object({
  namespace: namespaceSchema.optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const procedureGetSchema = z.object({
  name: z.string().optional(),
  query: z.string().optional(),
  namespace: namespaceSchema.optional(),
  limit: z.number().int().min(1).max(20).optional().default(10),
});

const procedureSaveSchema = z.object({
  name: z.string().min(1),
  namespace: namespaceSchema.optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional().default(0.5),
  steps: z.array(z.string()).min(1),
  prerequisites: z.array(z.string()).optional(),
  triggers: z.array(z.string()).optional(),
});

const blobStoreSchema = z.object({
  data_base64: z.string().min(1),
  namespace: namespaceSchema.optional(),
  filename: z.string().optional(),
  mime_type: z.string().optional(),
  source: z.string().optional(),
});

const memoryConsolidateSchema = z.object({
  namespace: namespaceSchema.optional(),
  limit: z.number().int().min(1).max(500).optional().default(50),
});

const memoryPurgeSchema = z.object({
  target_id: z.string().min(1),
  reason: z.string().min(1),
  cascade: z.boolean().optional().default(true),
});

const factQuerySchema = z.object({
  entity_name: z.string().min(1),
  namespace: namespaceSchema.optional(),
  limit: z.number().int().min(1).max(50).optional().default(10),
});

const statsSchema = z.object({
  namespace: namespaceSchema.optional(),
});

export function listToolDefinitions() {
  return [
    { name: "memory_add", description: "Store a memory with heuristic auto-classification.", inputSchema: z.toJSONSchema(memoryAddSchema) },
    { name: "memory_search", description: "Run structured memory search with pagination.", inputSchema: z.toJSONSchema(memorySearchSchema) },
    { name: "memory_recall", description: "Run hybrid recall with score fusion.", inputSchema: z.toJSONSchema(memoryRecallSchema) },
    { name: "fact_query", description: "Query facts for an entity.", inputSchema: z.toJSONSchema(factQuerySchema) },
    { name: "entity_upsert", description: "Create or update an entity plus optional observations.", inputSchema: z.toJSONSchema(entityUpsertSchema) },
    { name: "relation_upsert", description: "Create or update a graph relation.", inputSchema: z.toJSONSchema(relationUpsertSchema) },
    { name: "graph_traverse", description: "Traverse the knowledge graph.", inputSchema: z.toJSONSchema(graphTraverseSchema) },
    { name: "graph_search", description: "Search graph entities and relations.", inputSchema: z.toJSONSchema(graphSearchSchema) },
    { name: "timeline", description: "Return a timeline of memory events.", inputSchema: z.toJSONSchema(timelineSchema) },
    { name: "procedure_get", description: "Fetch procedures by name or semantic hint.", inputSchema: z.toJSONSchema(procedureGetSchema) },
    { name: "procedure_save", description: "Persist a procedure with versioning.", inputSchema: z.toJSONSchema(procedureSaveSchema) },
    { name: "blob_store", description: "Store a blob and create a blob_ref memory.", inputSchema: z.toJSONSchema(blobStoreSchema) },
    { name: "memory_consolidate", description: "Queue manual consolidation.", inputSchema: z.toJSONSchema(memoryConsolidateSchema) },
    { name: "memory_stats", description: "Return memory and queue statistics.", inputSchema: z.toJSONSchema(statsSchema) },
    { name: "memory_purge", description: "Hard-delete memory or graph records for GDPR/LGPD.", inputSchema: z.toJSONSchema(memoryPurgeSchema) },
  ];
}

function asText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function graphProximity(query: string, memoryContent: string): number {
  const queryTerms = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  const contentTerms = new Set(memoryContent.toLowerCase().split(/\W+/).filter(Boolean));
  const overlap = [...queryTerms].filter((term) => contentTerms.has(term)).length;
  return queryTerms.size === 0 ? 0 : overlap / queryTerms.size;
}

const queryEmbeddingProvider = new StubEmbeddingProvider();

async function hasEmbeddings(backend: MnemosyneBackend, namespace?: string): Promise<boolean> {
  return backend.hasEmbeddings(namespace);
}

async function resolveEntityReference(backend: MnemosyneBackend, reference: string, namespace?: string): Promise<string> {
  const entities = await backend.graph.searchEntities({
    namespace,
    name: reference,
    limit: 1,
  });
  return entities[0]?.id ?? reference;
}

async function findProcedureVersions(backend: MnemosyneBackend, name: string, namespace?: string): Promise<Memory[]> {
  const procedureNamespace = namespace ?? "_";
  const matches = await backend.memories.search({
    namespace: procedureNamespace,
    types: ["procedure"],
    includeArchived: true,
    contentQuery: name,
    limit: 100,
  });
  return matches.filter((memory) => memory.summary === name);
}

async function semanticSearch(
  backend: MnemosyneBackend,
  query: string,
  options: { namespace?: string; limit: number; includeArchived?: boolean; types?: Memory["type"][] },
) {
  const embedding = await queryEmbeddingProvider.embed(query);
  return backend.vectors.search(embedding, {
    namespace: options.namespace,
    limit: options.limit,
    includeArchived: options.includeArchived,
    types: options.types,
  });
}

async function exactTextSearch(
  backend: MnemosyneBackend,
  query: string,
  options: { namespace?: string; limit: number; includeArchived?: boolean; types?: Memory["type"][] },
) {
  const results = await backend.memories.textSearch(query, {
    namespace: options.namespace,
    limit: options.limit * 3,
    includeArchived: options.includeArchived,
  });
  return results.filter((memory) => !options.types?.length || options.types.includes(memory.type)).slice(0, options.limit);
}

async function semanticFirstSearch(
  backend: MnemosyneBackend,
  query: string,
  options: { namespace?: string; limit: number; includeArchived?: boolean; types?: Memory["type"][] },
) {
  const [semantic, exact] = await Promise.all([
    semanticSearch(backend, query, {
      namespace: options.namespace,
      limit: options.limit * 3,
      includeArchived: options.includeArchived,
      types: options.types,
    }),
    exactTextSearch(backend, query, {
      namespace: options.namespace,
      limit: options.limit * 3,
      includeArchived: options.includeArchived,
      types: options.types,
    }),
  ]);

  const merged = new Map<string, ScoredMemory>();
  for (const result of semantic) {
    merged.set(result.id, { ...result, score: Number((result.score * 0.35).toFixed(6)) });
  }
  for (const result of exact) {
    const current = merged.get(result.id);
    const score = Number((((current?.score ?? 0) + result.score * 0.65)).toFixed(6));
    merged.set(result.id, { ...result, score });
  }
  return [...merged.values()].sort((left, right) => right.score - left.score).slice(0, options.limit);
}

function scoreForMode(
  mode: z.infer<typeof memoryRecallSchema>["search_mode"],
  breakdown: { semantic: number; text: number; graph: number; recency: number; importance: number },
): number {
  switch (mode) {
    case "semantic":
      return Number((0.7 * breakdown.semantic + 0.15 * breakdown.recency + 0.15 * breakdown.importance).toFixed(6));
    case "exact":
      return Number(breakdown.text.toFixed(6));
    case "graph":
      return Number((0.7 * breakdown.graph + 0.15 * breakdown.recency + 0.15 * breakdown.importance).toFixed(6));
    case "hybrid":
    default:
      return fuseScores(breakdown);
  }
}

async function computeRecall(backend: MnemosyneBackend, args: z.infer<typeof memoryRecallSchema>) {
  const structured = await backend.memories.search({
    types: args.types,
    tags: args.tags,
    namespace: args.namespace,
    timeRange: args.time_range,
    importanceMin: args.importance_min,
    includeArchived: args.include_archived,
    limit: args.limit * 3,
  });
  const textResults =
    args.search_mode === "semantic" || args.search_mode === "graph"
      ? []
      : (
          await backend.memories.textSearch(args.query, {
            namespace: args.namespace,
            limit: args.limit * 3,
            includeArchived: args.include_archived,
          })
        ).filter((memory) => !args.types?.length || args.types.includes(memory.type));
  const semanticResults =
    args.search_mode === "exact" || args.search_mode === "graph"
      ? []
      : await semanticSearch(backend, args.query, {
          namespace: args.namespace,
          limit: args.limit * 3,
          includeArchived: args.include_archived,
          types: args.types,
        });

  const candidates = new Map<string, { memory: Memory; text: number; semantic: number }>();
  for (const item of structured) {
    candidates.set(item.id, { memory: item, text: 0, semantic: 0 });
  }
  for (const item of textResults) {
    const current = candidates.get(item.id) ?? { memory: item, text: 0, semantic: 0 };
    current.text = Math.max(current.text, item.score);
    candidates.set(item.id, current);
  }
  for (const item of semanticResults) {
    const current = candidates.get(item.id) ?? { memory: item, text: 0, semantic: 0 };
    current.semantic = Math.max(current.semantic, item.score);
    candidates.set(item.id, current);
  }

  return [...candidates.values()]
    .map(({ memory, semantic, text }) => {
      const decayedImportance = importanceDecay(memory.importance, memory.createdAt);
      const breakdown = {
        semantic,
        text,
        graph: graphProximity(args.query, `${memory.summary ?? ""} ${memory.content}`),
        recency: recencyScore(memory.createdAt),
        importance: decayedImportance,
      };
      return {
        id: memory.id,
        type: memory.type,
        content: memory.content,
        summary: memory.summary ?? undefined,
        score: scoreForMode(args.search_mode, breakdown),
        score_breakdown: breakdown,
        tags: memory.tags,
        created_at: memory.createdAt,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, args.limit);
}

export async function callTool(backend: MnemosyneBackend, name: string, rawArgs: unknown) {
  switch (name) {
    case "memory_add": {
      const args = memoryAddSchema.parse(rawArgs ?? {});
      const type = classifyMemory({
        content: args.content,
        type: args.type,
        name: args.name,
        steps: args.steps,
        entityName: args.entity_name,
        factType: args.fact_type,
        confidence: args.confidence,
        eventType: args.event_type,
        participants: args.participants,
      });
      const memory = await backend.memories.create({
        type,
        namespace: args.namespace,
        content: args.content,
        category: args.category,
        tags: args.tags,
        importance: args.importance,
        details:
          type === "fact"
            ? {
                entityName: args.entity_name,
                factType: args.fact_type,
                confidence: args.confidence,
              }
            : type === "procedure"
              ? ({
                  name: args.name,
                  steps: args.steps,
                } satisfies ProcedureDetailsInput)
              : {
                  eventType: args.event_type,
                  participants: args.participants,
                },
      });
      await backend.queue.enqueue({ type: "embed", payload: { memory_id: memory.id } });
      return asText({
        id: memory.id,
        type,
        entities_detected: detectEntities(args.content),
        queued_for_embedding: true,
      });
    }
    case "memory_search": {
      const args = memorySearchSchema.parse(rawArgs ?? {});
      const results = await backend.memories.search({
        types: args.types,
        tags: args.tags,
        namespace: args.namespace,
        category: args.category,
        importanceMin: args.importance_min,
        limit: args.limit,
        offset: args.offset,
        includeArchived: args.include_archived,
        contentQuery: args.query,
        timeRange: args.time_range,
      });
      return asText({ results, count: results.length });
    }
    case "memory_recall": {
      const args = memoryRecallSchema.parse(rawArgs ?? {});
      const started = Date.now();
      const results = await computeRecall(backend, args);
      await backend.events.append({
        action: "search",
        targetType: "memory",
        targetId: args.namespace ?? "_",
        data: { results_count: results.length, time_ms: Date.now() - started },
      });
      return asText({
        results,
        query_time_ms: Date.now() - started,
      });
    }
    case "fact_query": {
      const args = factQuerySchema.parse(rawArgs ?? {});
      const results = (await hasEmbeddings(backend, args.namespace))
        ? await semanticFirstSearch(backend, args.entity_name, {
            namespace: args.namespace,
            limit: args.limit,
            includeArchived: true,
            types: ["fact"],
          })
        : await exactTextSearch(backend, args.entity_name, {
            namespace: args.namespace,
            limit: args.limit,
            includeArchived: true,
            types: ["fact"],
          });
      return asText({ results });
    }
    case "entity_upsert": {
      const args = entityUpsertSchema.parse(rawArgs ?? {});
      const entity = await backend.graph.createEntity({
        name: args.name,
        entityType: args.entity_type,
        namespace: args.namespace,
        description: args.description,
        properties: args.properties,
        observations: args.observations?.map((observation) => ({
          content: observation.content,
          observer: observation.observer,
          confidence: observation.confidence,
          source: observation.source,
          namespace: args.namespace,
        })),
      });
      return asText(entity);
    }
    case "relation_upsert": {
      const args = relationUpsertSchema.parse(rawArgs ?? {});
      const [fromEntity, toEntity] = await Promise.all([
        resolveEntityReference(backend, args.from_entity, args.namespace),
        resolveEntityReference(backend, args.to_entity, args.namespace),
      ]);
      const relation = await backend.graph.createRelation({
        fromEntity,
        toEntity,
        relationType: args.relation_type,
        namespace: args.namespace,
        properties: args.properties,
        weight: args.weight,
        bidirectional: args.bidirectional,
      });
      return asText(relation);
    }
    case "graph_traverse": {
      const args = graphTraverseSchema.parse(rawArgs ?? {});
      return asText(
        await backend.graph.traverse(args.start, {
          namespace: args.namespace,
          depth: args.depth,
          relationTypes: args.relation_types,
          limit: args.limit,
        }),
      );
    }
    case "graph_search": {
      const args = graphSearchSchema.parse(rawArgs ?? {});
      const entities = await backend.graph.searchEntities({
        namespace: args.namespace,
        name: args.entity_name,
        entityType: args.entity_type,
        limit: args.limit,
      });
      const relations = await backend.graph.searchRelations({
        namespace: args.namespace,
        relationType: args.relation_type,
        entityId: args.entity_id,
        limit: args.limit,
      });
      return asText({ entities, relations });
    }
    case "timeline": {
      const args = timelineSchema.parse(rawArgs ?? {});
      const results = await backend.memories.search({
        namespace: args.namespace,
        timeRange: { after: args.after, before: args.before },
        includeArchived: true,
        limit: args.limit,
      });
      return asText({ results });
    }
    case "procedure_get": {
      const args = procedureGetSchema.parse(rawArgs ?? {});
      const query = args.name ?? args.query ?? "";
      const results =
        query && (await hasEmbeddings(backend, args.namespace))
          ? await semanticFirstSearch(backend, query, {
              namespace: args.namespace,
              limit: args.limit,
              includeArchived: true,
              types: ["procedure"],
            })
          : query
            ? await exactTextSearch(backend, query, {
                namespace: args.namespace,
                limit: args.limit,
                includeArchived: true,
                types: ["procedure"],
              })
            : await backend.memories.search({
                namespace: args.namespace,
                types: ["procedure"],
                limit: args.limit,
                includeArchived: true,
              });
      return asText({ results });
    }
    case "procedure_save": {
      const args = procedureSaveSchema.parse(rawArgs ?? {});
      const existingVersions = await findProcedureVersions(backend, args.name, args.namespace);
      const current = existingVersions.find((memory) => memory.status === "active");
      const version = existingVersions.length + 1;
      const memory = await backend.memories.create({
        type: "procedure",
        namespace: args.namespace,
        content: args.content ?? args.steps.join("\n"),
        summary: args.summary ?? args.name,
        category: args.category,
        tags: args.tags,
        importance: args.importance,
        details: {
          name: args.name,
          namespace: args.namespace ?? "_",
          version,
          steps: args.steps,
          prerequisites: args.prerequisites ?? [],
          triggers: args.triggers ?? [],
        },
      });
      if (current) {
        await backend.memories.update(current.id, {
          status: "archived",
          supersededBy: memory.id,
        });
      }
      await backend.queue.enqueue({ type: "embed", payload: { memory_id: memory.id } });
      return asText(memory);
    }
    case "blob_store": {
      const args = blobStoreSchema.parse(rawArgs ?? {});
      const id = await backend.blobs.store(Buffer.from(args.data_base64, "base64"), {
        namespace: args.namespace,
        filename: args.filename,
        mimeType: args.mime_type,
        source: args.source,
      });
      return asText({ id });
    }
    case "memory_consolidate": {
      const args = memoryConsolidateSchema.parse(rawArgs ?? {});
      const queuedId = await backend.queue.enqueue({
        type: "consolidate",
        payload: { namespace: args.namespace, limit: args.limit },
      });
      await backend.events.append({
        action: "consolidate",
        targetType: "memory",
        targetId: args.namespace ?? "_",
        data: { episodes_processed: args.limit, facts_created: 0, dedup_merged: 0 },
      });
      return asText({ job_id: queuedId, queued: true });
    }
    case "memory_stats": {
      const args = statsSchema.parse(rawArgs ?? {});
      const queue = await backend.queue.stats();
      const counts = await backend.memories.countByType(args.namespace);
      return asText({
        total_memories: counts.total,
        by_type: counts.byType,
        namespaces: counts.namespaces,
        queue,
        event_log: await backend.events.verify(),
      });
    }
    case "memory_purge": {
      const args = memoryPurgeSchema.parse(rawArgs ?? {});
      const result =
        backend instanceof ServerMnemosyneBackend
          ? await backend.purgeTarget(args.target_id, args.reason, args.cascade)
          : await purgeTarget(backend as SqliteMnemosyneBackend, args.target_id, args.reason, args.cascade);
      return asText({ purged: result.purged, audit_id: result.auditId });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
