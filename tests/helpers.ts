import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteMnemosyneBackend } from "../src/sqlite/backend.js";

export interface TestContext {
  rootDir: string;
  backend: SqliteMnemosyneBackend;
}

export async function createTestContext(): Promise<TestContext> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-test-"));
  const backend = new SqliteMnemosyneBackend({
    dbPath: path.join(rootDir, "mnemosyne.db"),
    blobsPath: path.join(rootDir, "blobs"),
    backupsPath: path.join(rootDir, "backups"),
    migrationsDir: path.join(process.cwd(), "migrations"),
  });
  await backend.lifecycle.initialize();
  return { rootDir, backend };
}

export async function destroyTestContext(context: TestContext | undefined): Promise<void> {
  if (!context) {
    return;
  }
  try {
    await context.backend.lifecycle.close();
  } catch {
    // Some tests intentionally exercise closed lifecycles.
  }
  await rm(context.rootDir, { recursive: true, force: true });
}

export function parseToolText(result: unknown): unknown {
  const response = result as { content?: Array<{ type: string; text: string }> };
  const text = response.content?.find((entry) => entry.type === "text")?.text;
  if (!text) {
    throw new Error("Tool response did not include text content");
  }
  return JSON.parse(text) as unknown;
}
