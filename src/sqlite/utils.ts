import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";

export const DEFAULT_NAMESPACE = "_";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return ulid();
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256(input: string, salt: Buffer): string {
  return createHmac("sha256", salt).update(input).digest("hex");
}

export function encodeVector(vector: number[]): Buffer {
  return Buffer.from(JSON.stringify(vector), "utf8");
}

export function decodeVector(blob: Buffer): number[] {
  return JSON.parse(blob.toString("utf8")) as number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    magA += a[index] ** 2;
    magB += b[index] ** 2;
  }
  if (magA === 0 || magB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function sanitizeText(input: string): string {
  return input.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

export function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function loadMigrations(migrationsDir: string): Promise<Array<{ version: number; name: string; sql: string; checksum: string }>> {
  const entries = await readdir(migrationsDir);
  const files = entries.filter((entry) => entry.endsWith(".sql")).sort();
  const migrations = await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      const [versionPart, ...nameParts] = file.replace(/\.sql$/, "").split("_");
      return {
        version: Number(versionPart),
        name: nameParts.join("_") || file,
        sql,
        checksum: sha256(sql),
      };
    }),
  );
  return migrations;
}

export async function createBackupFile(source: string, backupDir: string, label?: string): Promise<string> {
  await ensureDir(backupDir);
  const backupId = `${newId()}${label ? `-${label.replace(/[^a-zA-Z0-9-_]/g, "_")}` : ""}.db`;
  const target = path.join(backupDir, backupId);
  await copyFile(source, target);
  return backupId;
}

export async function restoreBackupFile(source: string, backupDir: string, backupId: string): Promise<void> {
  const target = path.join(backupDir, backupId);
  await copyFile(target, source);
}

export async function fileSize(filePath: string): Promise<number> {
  const info = await stat(filePath);
  return info.size;
}

export async function removeIfExists(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export function purgeReasonHmac(reason: string): string {
  return hmacSha256(reason, randomBytes(32));
}

export async function writeBuffer(filePath: string, buffer: Buffer): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, buffer);
}
