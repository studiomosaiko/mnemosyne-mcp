import type { MnemosyneBackend } from "../interfaces/index.js";
import { ServerMnemosyneBackend } from "../server-backend.js";
import { SqliteMnemosyneBackend } from "../sqlite/backend.js";

export function createBackend(): MnemosyneBackend {
  if (process.env.DATABASE_URL) {
    return new ServerMnemosyneBackend({
      databaseUrl: process.env.DATABASE_URL,
      redisUrl: process.env.REDIS_URL,
      qdrantUrl: process.env.QDRANT_URL,
      qdrantApiKey: process.env.QDRANT_API_KEY,
      blobsPath: process.env.MNEMOSYNE_BLOBS_PATH,
      defaultNamespace: process.env.MNEMOSYNE_DEFAULT_NAMESPACE,
    });
  }

  return new SqliteMnemosyneBackend({
    dbPath: process.env.MNEMOSYNE_DB_PATH,
    blobsPath: process.env.MNEMOSYNE_BLOBS_PATH,
    backupsPath: process.env.MNEMOSYNE_BACKUPS_PATH,
    defaultNamespace: process.env.MNEMOSYNE_DEFAULT_NAMESPACE,
  });
}

export async function initializeBackend(backend: MnemosyneBackend): Promise<void> {
  if (backend instanceof ServerMnemosyneBackend) {
    await backend.initialize();
    return;
  }

  await backend.lifecycle.initialize();
}

export async function closeBackend(backend: MnemosyneBackend): Promise<void> {
  await backend.lifecycle.close();
}

export function backendMode(): "server" | "sqlite" {
  return process.env.DATABASE_URL ? "server" : "sqlite";
}
