#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exportMemories } from "./cli/export.js";
import { importMemoryMarkdown } from "./importers/memory-md.js";
import { backendMode, closeBackend, createBackend, initializeBackend } from "./runtime/backend.js";
import { callTool, listToolDefinitions } from "./server/tools.js";

function readFlagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readListFlag(name: string): string[] | undefined {
  const value = readFlagValue(name);
  if (!value) {
    return undefined;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function runImportCommand() {
  const filePath = readFlagValue("--import-memory");
  const namespace = readFlagValue("--namespace") ?? process.env.MNEMOSYNE_DEFAULT_NAMESPACE ?? "_";
  if (!filePath) {
    throw new Error("--import-memory requires a file path");
  }

  const backend = createBackend();
  process.stderr.write(`mnemosyne backend mode: ${backendMode()}\n`);
  try {
    await initializeBackend(backend);
    const result = await importMemoryMarkdown(backend, { filePath, namespace });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closeBackend(backend);
  }
}

async function runExportCommand() {
  const format = readFlagValue("--format");
  if (format !== "json" && format !== "csv") {
    throw new Error("--export requires --format json or --format csv");
  }

  const backend = createBackend();
  process.stderr.write(`mnemosyne backend mode: ${backendMode()}\n`);
  try {
    await initializeBackend(backend);
    const output = await exportMemories(backend, {
      format,
      namespace: readFlagValue("--namespace"),
      types: readListFlag("--type") as Array<"episode" | "fact" | "procedure" | "blob_ref"> | undefined,
      tags: readListFlag("--tags"),
      includeArchived: hasFlag("--include-archived"),
    });
    process.stdout.write(`${output}\n`);
  } finally {
    await closeBackend(backend);
  }
}

async function startServer() {
  const backend = createBackend();
  process.stderr.write(`mnemosyne backend mode: ${backendMode()}\n`);
  await initializeBackend(backend);

  const server = new Server(
    {
      name: "@studiomosaiko/mnemosyne",
      version: "4.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(backend, request.params.name, request.params.arguments ?? {});
    return result;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (hasFlag("--import-memory")) {
  await runImportCommand();
} else if (hasFlag("--export")) {
  await runExportCommand();
} else {
  await startServer();
}
