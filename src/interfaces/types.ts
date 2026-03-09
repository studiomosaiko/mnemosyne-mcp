export type MemoryType = "episode" | "fact" | "procedure" | "blob_ref";
export type MemoryStatus = "active" | "archived" | "consolidated" | "superseded" | "purged";
export type EventAction = "create" | "update" | "archive" | "purge" | "search" | "consolidate";
export type EventTargetType = "memory" | "entity" | "relation" | "observation";
export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type SearchMode = "hybrid" | "semantic" | "exact" | "graph";

export interface Memory {
  id: string;
  type: MemoryType;
  namespace: string;
  content: string;
  summary: string | null;
  contentHash: string | null;
  category: string | null;
  tags: string[];
  importance: number;
  source: string | null;
  agentId: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  status: MemoryStatus;
  supersededBy: string | null;
  expiresAt: string | null;
  embeddingModel: string | null;
  embeddingVersion: number;
  embeddedAt: string | null;
}

export interface MemoryInput {
  id?: string;
  type: MemoryType;
  namespace?: string;
  content: string;
  summary?: string | null;
  contentHash?: string | null;
  category?: string | null;
  tags?: string[];
  importance?: number;
  source?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  status?: MemoryStatus;
  supersededBy?: string | null;
  expiresAt?: string | null;
  embeddingModel?: string | null;
  embeddingVersion?: number;
  embeddedAt?: string | null;
  details?: EpisodeDetailsInput | FactDetailsInput | ProcedureDetailsInput;
}

export interface StructuredQuery {
  ids?: string[];
  types?: MemoryType[];
  namespace?: string;
  tags?: string[];
  category?: string;
  importanceMin?: number;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
  timeRange?: { after?: string; before?: string };
  status?: MemoryStatus[];
  contentQuery?: string;
}

export interface MemoryCounts {
  total: number;
  byType: Record<string, number>;
  namespaces: string[];
}

export interface TextSearchOptions {
  namespace?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface ScoredMemory extends Memory {
  score: number;
  scoreBreakdown?: ScoreBreakdown;
}

export interface ScoreBreakdown {
  semantic: number;
  text: number;
  graph: number;
  recency: number;
  importance: number;
}

export interface EpisodeDetails {
  eventType: string;
  participants: string[];
  location: string | null;
  outcome: string | null;
  emotions: string[];
  durationMs: number | null;
}

export interface EpisodeDetailsInput extends Partial<EpisodeDetails> {
  eventType?: string;
}

export interface FactDetails {
  entityName: string;
  entityType: string | null;
  factType: string;
  confidence: number;
  validFrom: string | null;
  validUntil: string | null;
  contradicts: string | null;
}

export interface FactDetailsInput extends Partial<FactDetails> {
  entityName?: string;
  factType?: string;
}

export interface ProcedureDetails {
  name: string;
  namespace: string;
  version: number;
  steps: string[];
  prerequisites: string[];
  triggers: string[];
  successCount: number;
  failureCount: number;
  avgDurationMs: number | null;
  lastUsedAt: string | null;
  lastResult: string | null;
}

export interface ProcedureDetailsInput extends Partial<ProcedureDetails> {
  name?: string;
  steps?: string[];
}

export interface Entity {
  id: string;
  name: string;
  entityType: string;
  namespace: string;
  description: string | null;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  status: string;
}

export interface EntityInput {
  id?: string;
  name: string;
  entityType: string;
  namespace?: string;
  description?: string | null;
  properties?: Record<string, unknown>;
  observations?: ObservationInput[];
}

export interface Relation {
  id: string;
  fromEntity: string;
  toEntity: string;
  relationType: string;
  properties: Record<string, unknown>;
  weight: number;
  bidirectional: boolean;
  namespace: string;
  createdAt: string;
  status: string;
}

export interface RelationInput {
  id?: string;
  fromEntity: string;
  toEntity: string;
  relationType: string;
  properties?: Record<string, unknown>;
  weight?: number;
  bidirectional?: boolean;
  namespace?: string;
  createdAt?: string;
  status?: string;
}

export interface Observation {
  id: string;
  entityId: string;
  content: string;
  observer: string | null;
  namespace: string;
  observedAt: string;
  confidence: number;
  source: string | null;
  status: string;
}

export interface ObservationInput {
  id?: string;
  entityId?: string;
  content: string;
  observer?: string | null;
  namespace?: string;
  observedAt?: string;
  confidence?: number;
  source?: string | null;
  status?: string;
}

export interface TraversalOptions {
  namespace?: string;
  depth?: number;
  relationTypes?: string[];
  limit?: number;
}

export interface GraphNode {
  entity: Entity;
  depth: number;
}

export interface GraphEdge {
  relation: Relation;
  from: Entity;
  to: Entity;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface EntityQuery {
  namespace?: string;
  name?: string;
  entityType?: string;
  limit?: number;
}

export interface RelationQuery {
  namespace?: string;
  relationType?: string;
  entityId?: string;
  limit?: number;
}

export interface MigrationResult {
  applied: number;
  versions: number[];
}

export interface EmbeddingData {
  id?: string;
  chunkText: string;
  vector: number[];
  model: string;
  dimensions: number;
  version?: number;
  createdAt?: string;
}

export interface VectorSearchOptions {
  namespace?: string;
  limit?: number;
  includeArchived?: boolean;
  types?: MemoryType[];
}

export interface ReindexFilter {
  namespace?: string;
  memoryIds?: string[];
}

export interface Job {
  id?: string;
  type: string;
  payload: Record<string, unknown>;
  status?: JobStatus;
  priority?: number;
  attempts?: number;
  maxAttempts?: number;
  error?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  nextRetryAt?: string | null;
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export interface BlobMetadata {
  namespace?: string;
  filename?: string;
  mimeType?: string;
  source?: string;
}

export interface BlobFilter {
  namespace?: string;
}

export interface BlobInfo {
  id: string;
  namespace: string;
  path: string;
  filename: string | null;
  mimeType: string | null;
  size: number;
  createdAt: string;
}

export interface EventRecord {
  id: string;
  timestamp: string;
  agentId: string | null;
  action: EventAction;
  targetType: EventTargetType;
  targetId: string;
  data: Record<string, unknown> | null;
  prevHash: string | null;
  hash: string;
}

export interface EventInput {
  id?: string;
  timestamp?: string;
  agentId?: string | null;
  action: EventAction;
  targetType: EventTargetType;
  targetId: string;
  data?: Record<string, unknown> | null;
}

export interface EventFilter {
  targetId?: string;
  action?: EventAction;
  limit?: number;
}

export interface MemoryStore {
  create(memory: MemoryInput): Promise<Memory>;
  get(id: string): Promise<Memory | null>;
  update(id: string, fields: Partial<Memory>): Promise<void>;
  search(query: StructuredQuery): Promise<Memory[]>;
  textSearch(query: string, options: TextSearchOptions): Promise<ScoredMemory[]>;
  countByType(namespace?: string): Promise<MemoryCounts>;
  purge(id: string): Promise<void>;
}

export interface GraphStore {
  createEntity(entity: EntityInput): Promise<Entity>;
  updateEntity(id: string, fields: Partial<Entity>): Promise<void>;
  createRelation(relation: RelationInput): Promise<Relation>;
  addObservation(obs: ObservationInput): Promise<Observation>;
  traverse(start: string, options: TraversalOptions): Promise<GraphResult>;
  searchEntities(query: EntityQuery): Promise<Entity[]>;
  searchRelations(query: RelationQuery): Promise<Relation[]>;
  purgeEntity(id: string): Promise<void>;
}

export interface LifecycleManager {
  initialize(): Promise<void>;
  backup(label?: string): Promise<string>;
  restore(backupId: string): Promise<void>;
  migrate(): Promise<MigrationResult>;
  close(): Promise<void>;
}

export interface VectorStore {
  store(memoryId: string, chunkIndex: number, embedding: EmbeddingData): Promise<void>;
  search(embedding: number[], options: VectorSearchOptions): Promise<ScoredMemory[]>;
  delete(memoryId: string): Promise<void>;
  reindex(filter: ReindexFilter): Promise<number>;
}

export interface JobQueue {
  enqueue(job: Job): Promise<string>;
  dequeue(): Promise<Job | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  retry(id: string): Promise<void>;
  stats(): Promise<QueueStats>;
}

export interface BlobStore {
  store(data: Buffer, metadata: BlobMetadata): Promise<string>;
  get(id: string): Promise<Buffer>;
  delete(id: string): Promise<void>;
  list(filter?: BlobFilter): Promise<BlobInfo[]>;
}

export interface EventLog {
  append(event: EventInput): Promise<void>;
  query(filter: EventFilter): Promise<EventRecord[]>;
  verify(): Promise<{ valid: boolean; brokenAt?: string }>;
}

export interface MnemosyneBackend {
  memories: MemoryStore;
  graph: GraphStore;
  vectors: VectorStore;
  queue: JobQueue;
  blobs: BlobStore;
  events: EventLog;
  lifecycle: LifecycleManager;
  hasEmbeddings(namespace?: string): Promise<boolean>;
}
