import type { Memory, MemoryType, MnemosyneBackend } from "../interfaces/index.js";

export interface ExportOptions {
  format: "json" | "csv";
  namespace?: string;
  types?: MemoryType[];
  tags?: string[];
  includeArchived?: boolean;
}

async function fetchMemories(backend: MnemosyneBackend, options: ExportOptions): Promise<Memory[]> {
  const pageSize = 500;
  const output: Memory[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const page = await backend.memories.search({
      namespace: options.namespace,
      types: options.types,
      tags: options.tags,
      includeArchived: options.includeArchived,
      limit: pageSize,
      offset,
    });
    output.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }

  return output;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const stringValue =
    typeof value === "string" ? value : Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value);
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replace(/"/g, "\"\"")}"`;
}

export function memoriesToCsv(memories: Memory[]): string {
  const headers = [
    "id",
    "type",
    "namespace",
    "content",
    "summary",
    "category",
    "tags",
    "importance",
    "source",
    "status",
    "createdAt",
    "updatedAt",
  ];
  const rows = memories.map((memory) =>
    [
      memory.id,
      memory.type,
      memory.namespace,
      memory.content,
      memory.summary,
      memory.category,
      memory.tags,
      memory.importance,
      memory.source,
      memory.status,
      memory.createdAt,
      memory.updatedAt,
    ]
      .map(csvEscape)
      .join(","),
  );
  return `${headers.join(",")}\n${rows.join("\n")}`;
}

export async function exportMemories(backend: MnemosyneBackend, options: ExportOptions): Promise<string> {
  const memories = await fetchMemories(backend, options);
  if (options.format === "csv") {
    return memoriesToCsv(memories);
  }
  return JSON.stringify(memories, null, 2);
}
