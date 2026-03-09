import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type QueryResultRow } from "pg";
import type {
  BlobFilter,
  BlobInfo,
  BlobMetadata,
  BlobStore,
  Job,
  MnemosyneBackend,
} from "./interfaces/index.js";
import {
  PostgresEventLog,
  PostgresGraphStore,
  PostgresLifecycle,
  PostgresMemoryStore,
  purgePostgresTarget,
} from "./postgres/backend.js";
import { QdrantVectorStore } from "./qdrant/vector-store.js";
import { RedisJobQueue } from "./redis/job-queue.js";
import { ensureDir, fileSize, newId, nowIso, removeIfExists, sha256, writeBuffer } from "./sqlite/utils.js";

type Row = QueryResultRow & Record<string, unknown>;

export interface ServerMnemosyneBackendOptions {
  databaseUrl?: string;
  redisUrl?: string;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollection?: string;
  blobsPath?: string;
  migrationsDir?: string;
  defaultNamespace?: string;
}

class ServerFilesystemBlobStore implements BlobStore {
  constructor(
    private readonly blobsPath: string,
    private readonly pool: Pool,
    private readonly defaultNamespace: string,
  ) {}

  async store(data: Buffer, metadata: BlobMetadata): Promise<string> {
    const id = newId();
    const namespace = metadata.namespace ?? this.defaultNamespace;
    const extension = metadata.filename?.includes(".") ? `.${metadata.filename.split(".").pop()}` : "";
    const filename = `${id}${extension}`;
    const relativePath = path.join(namespace, filename);
    await writeBuffer(path.join(this.blobsPath, relativePath), data);
    await this.pool.query(
      `INSERT INTO memories
       (id, type, namespace, content, summary, content_hash, category, tags, importance, source, agent_id, session_id, created_at, updated_at, status)
       VALUES ($1, 'blob_ref', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
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
      ],
    );
    return id;
  }

  async get(id: string): Promise<Buffer> {
    const result = await this.pool.query("SELECT content FROM memories WHERE id = $1 AND type = 'blob_ref'", [id]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Blob ${id} not found`);
    }
    return readFile(path.join(this.blobsPath, String(row.content)));
  }

  async delete(id: string): Promise<void> {
    const result = await this.pool.query("SELECT content FROM memories WHERE id = $1 AND type = 'blob_ref'", [id]);
    const row = result.rows[0];
    if (row?.content) {
      await removeIfExists(path.join(this.blobsPath, String(row.content)));
    }
    await this.pool.query("DELETE FROM memories WHERE id = $1", [id]);
  }

  async list(filter?: BlobFilter): Promise<BlobInfo[]> {
    const result = await this.pool.query(
      `SELECT id, namespace, content, summary, created_at
       FROM memories
       WHERE type = 'blob_ref'
         AND ($1::text IS NULL OR namespace = $1)
       ORDER BY created_at DESC`,
      [filter?.namespace ?? null],
    );
    return Promise.all(
      result.rows.map(async (row) => ({
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

export class ServerMnemosyneBackend implements MnemosyneBackend {
  public readonly pool: Pool;
  public readonly memories: PostgresMemoryStore;
  public readonly graph: PostgresGraphStore;
  public readonly vectors: QdrantVectorStore;
  public readonly queue: RedisJobQueue;
  public readonly blobs: BlobStore;
  public readonly events: PostgresEventLog;
  public readonly lifecycle: PostgresLifecycle;
  public readonly options: Required<ServerMnemosyneBackendOptions>;

  constructor(options: ServerMnemosyneBackendOptions = {}) {
    const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for server mode");
    }
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is required for server mode");
    }
    const qdrantUrl = options.qdrantUrl ?? process.env.QDRANT_URL;
    if (!qdrantUrl) {
      throw new Error("QDRANT_URL is required for server mode");
    }
    this.options = {
      databaseUrl,
      redisUrl,
      qdrantUrl,
      qdrantApiKey: options.qdrantApiKey ?? process.env.QDRANT_API_KEY ?? "",
      qdrantCollection: options.qdrantCollection ?? process.env.QDRANT_COLLECTION ?? "mnemosyne_memories",
      blobsPath: options.blobsPath ?? path.join(process.cwd(), "data", "blobs"),
      migrationsDir: options.migrationsDir ?? path.join(process.cwd(), "migrations", "postgres"),
      defaultNamespace: options.defaultNamespace ?? process.env.MNEMOSYNE_DEFAULT_NAMESPACE ?? "_",
    };

    const dbUrl = this.options.databaseUrl;
    const useSSL = dbUrl?.includes('supabase') || dbUrl?.includes('sslmode=require') || process.env.DATABASE_SSL === 'true';
    const sslConfig = useSSL ? { rejectUnauthorized: false } : undefined;

    // If DATABASE_PASSWORD is set separately, parse the URL manually to avoid encoding issues
    if (process.env.DATABASE_PASSWORD && dbUrl) {
      const url = new URL(dbUrl);
      this.pool = new Pool({
        host: url.hostname,
        port: Number(url.port) || 5432,
        database: url.pathname.replace('/', '') || 'postgres',
        user: url.username || 'postgres',
        password: process.env.DATABASE_PASSWORD,
        ssl: sslConfig,
      });
    } else {
      this.pool = new Pool({
        connectionString: dbUrl,
        ssl: sslConfig,
      });
    }
    this.events = new PostgresEventLog(this.pool);
    this.memories = new PostgresMemoryStore(this.pool, this.events, this.options.defaultNamespace);
    this.graph = new PostgresGraphStore(this.pool, this.events, this.options.defaultNamespace);
    this.vectors = new QdrantVectorStore({
      url: this.options.qdrantUrl,
      apiKey: this.options.qdrantApiKey || undefined,
      collectionName: this.options.qdrantCollection,
      memories: this.memories,
    });
    this.queue = new RedisJobQueue(this.options.redisUrl);
    this.blobs = new ServerFilesystemBlobStore(this.options.blobsPath, this.pool, this.options.defaultNamespace);
    this.lifecycle = new PostgresLifecycle(this.pool, { migrationsDir: this.options.migrationsDir });
  }

  async initialize(): Promise<void> {
    await ensureDir(this.options.blobsPath);
    await this.lifecycle.initialize();
  }

  async hasEmbeddings(namespace?: string): Promise<boolean> {
    return this.vectors.hasEmbeddings(namespace);
  }

  async purgeTarget(targetId: string, reason: string, cascade = true): Promise<{ purged: number; auditId: string }> {
    return purgePostgresTarget(this.pool, this.events, this.blobs, targetId, reason, cascade);
  }

  async dequeueByType(type: string): Promise<Job | null> {
    return this.queue.dequeueByType(type);
  }
}
