import { readFile } from "node:fs/promises";
import type { MnemosyneBackend } from "../interfaces/index.js";
import { detectEntities } from "../sqlite/backend.js";

export interface MemoryMarkdownImportOptions {
  filePath: string;
  namespace: string;
  source?: string;
  defaultImportance?: number;
}

export interface MemoryMarkdownImportResult {
  namespace: string;
  source: string;
  sections: number;
  memories: number;
  entities: number;
  relations: number;
}

interface ParsedSection {
  heading: string;
  level: 2 | 3;
  bullets: string[];
  paragraphs: string[];
}

const headerPattern = /^(##|###)\s+(.+?)\s*$/;
const bulletPattern = /^(\s*)[-*+]\s+(.*)$/;

function normalizeHeading(value: string): string {
  return value
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

function normalizeFact(value: string): string {
  return value
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function inferEntityType(level: 2 | 3): string {
  return level === 2 ? "topic" : "subtopic";
}

export function parseMemoryMarkdown(markdown: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    if (!current || paragraphBuffer.length === 0) {
      return;
    }
    const text = normalizeFact(paragraphBuffer.join(" "));
    if (text) {
      current.paragraphs.push(text);
    }
    paragraphBuffer = [];
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const header = line.match(headerPattern);
    if (header) {
      flushParagraph();
      current = {
        heading: normalizeHeading(header[2]),
        level: header[1].length as 2 | 3,
        bullets: [],
        paragraphs: [],
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const bullet = line.match(bulletPattern);
    if (bullet) {
      flushParagraph();
      const fact = normalizeFact(bullet[2]);
      if (fact) {
        current.bullets.push(fact);
      }
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    paragraphBuffer.push(line.trim());
  }

  flushParagraph();

  return sections.filter((section) => section.heading && (section.bullets.length > 0 || section.paragraphs.length > 0));
}

export async function importMemoryMarkdown(
  backend: MnemosyneBackend,
  options: MemoryMarkdownImportOptions,
): Promise<MemoryMarkdownImportResult> {
  const markdown = await readFile(options.filePath, "utf8");
  const sections = parseMemoryMarkdown(markdown);
  const source = options.source ?? options.filePath;
  const namespace = options.namespace;
  const defaultImportance = options.defaultImportance ?? 0.7;
  const entityIds = new Map<string, string>();
  let memoryCount = 0;
  let relationCount = 0;

  const ensureEntity = async (name: string, type: string) => {
    const cached = entityIds.get(name);
    if (cached) {
      return cached;
    }
    const entity = await backend.graph.createEntity({
      name,
      entityType: type,
      namespace,
    });
    entityIds.set(name, entity.id);
    return entity.id;
  };

  for (const section of sections) {
    const parentEntityId = await ensureEntity(section.heading, inferEntityType(section.level));
    const facts = [...section.paragraphs, ...section.bullets];

    for (const fact of facts) {
      const detected = detectEntities(fact).filter((entity) => entity !== section.heading);
      const tags = [
        "memory-md",
        section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
        ...detected.map((entity) => entity.toLowerCase()),
      ].filter(Boolean);

      await backend.memories.create({
        type: "fact",
        namespace,
        content: fact,
        summary: `${section.heading}: ${fact}`.slice(0, 240),
        category: "memory-md",
        tags: [...new Set(tags)],
        importance: defaultImportance,
        source,
        details: {
          entityName: section.heading,
          entityType: inferEntityType(section.level),
          factType: "memory_md",
          confidence: 0.85,
        },
      });
      memoryCount += 1;

      await backend.graph.addObservation({
        entityId: parentEntityId,
        namespace,
        content: fact,
        source,
        confidence: 0.85,
      });

      for (const name of detected) {
        const detectedId = await ensureEntity(name, "mention");
        if (detectedId === parentEntityId) {
          continue;
        }
        await backend.graph.createRelation({
          fromEntity: parentEntityId,
          toEntity: detectedId,
          relationType: "mentions",
          namespace,
          properties: { source: "memory-md-import" },
        });
        relationCount += 1;
      }
    }
  }

  return {
    namespace,
    source,
    sections: sections.length,
    memories: memoryCount,
    entities: entityIds.size,
    relations: relationCount,
  };
}
