# 🧠 Mnemosyne

> The memory layer for AI agents. Where nothing is lost.

Mnemosyne is an [MCP](https://modelcontextprotocol.io) server that gives AI agents persistent, semantic, relational memory — inspired by human cognition.

## Why

Every time you close a conversation with an AI, it forgets everything. Mnemosyne fixes that.

- **Episodic** memory — what happened (conversations, events, decisions)
- **Semantic** memory — what is known (facts, preferences, knowledge)
- **Procedural** memory — how to do things (workflows, checklists, patterns)

## Quick Start

```bash
npx @studiomosaiko/mnemosyne
```

That's it. Mnemosyne starts as an MCP server using SQLite — zero external services needed.

> **Note:** Personal mode uses SQLite (single file, no setup). Server mode requires Postgres (Supabase), Redis, and Qdrant Cloud — see [Server Mode](#server-cloud) below.

### Connect to Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["@studiomosaiko/mnemosyne"]
    }
  }
}
```

## Features

### 15 MCP Tools

| Tool | What it does |
|---|---|
| `memory_add` | Store a memory (auto-classifies type) |
| `memory_search` | Filter memories by type, tags, namespace |
| `memory_recall` | Hybrid search: text + semantic + graph + recency + importance |
| `fact_query` | "What do I know about Alice?" |
| `timeline` | Chronological memory view |
| `entity_upsert` | Create/update people, projects, concepts |
| `relation_upsert` | "Alice works_with Bob" |
| `graph_traverse` | Navigate the knowledge graph |
| `graph_search` | Search entities and relations |
| `procedure_save` | Store versioned workflows with steps |
| `procedure_get` | Retrieve procedures by name or semantics |
| `blob_store` | Store binary files (images, PDFs) |
| `memory_consolidate` | Group related memories into summaries |
| `memory_stats` | Counts, queue state, event log integrity |
| `memory_purge` | GDPR/LGPD hard delete with audit trail |

### Hybrid Search

Every recall combines 5 scoring factors:

```
semantic (0.35) + text (0.20) + graph (0.15) + recency (0.15) + importance (0.15)
```

Four search modes: `hybrid`, `semantic`, `exact`, `graph`.

### Knowledge Graph

Entities, relations, and observations — all queryable and traversable. Namespace-isolated with schema-enforced triggers.

### Privacy by Design

- HMAC-SHA256 hashes (salt discarded) for purge audit trails
- Purge tombstones prevent deleted data from resurfacing in backups
- Event log stores only structural metadata — never personal content
- Full LGPD/GDPR `memory_purge` with cascade

## Two Modes

### Personal (SQLite)

No external services. Everything in a single `.db` file. Perfect for one agent.

**Requirements:** Node.js 22+

```bash
npx @studiomosaiko/mnemosyne
```

### Server (Cloud)

For teams and multi-agent setups. Requires cloud infrastructure:

| Service | Role | Required |
|---|---|---|
| **Supabase** (Postgres + pgvector) | Database + embeddings | ✅ |
| **Redis Cloud** (BullMQ) | Durable job queue | ✅ |
| **Qdrant Cloud** | Optimized vector search | ✅ |

**Requirements:** Node.js 22+ and accounts on all three services above.

```bash
DATABASE_URL=postgresql://... \
DATABASE_PASSWORD=... \
REDIS_URL=redis://... \
QDRANT_URL=https://... \
QDRANT_API_KEY=... \
npx @studiomosaiko/mnemosyne
```

Auto-detected: if `DATABASE_URL` is set → Server mode. Otherwise → Personal (SQLite).

## CLI

### Import existing memory

```bash
npx @studiomosaiko/mnemosyne --import-memory ./MEMORY.md --namespace myagent
```

### Export

```bash
npx @studiomosaiko/mnemosyne --export --format json --namespace myagent
npx @studiomosaiko/mnemosyne --export --format csv --namespace myagent --type fact --tags profile
```

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `MNEMOSYNE_DB_PATH` | SQLite database path | `./data/mnemosyne.db` |
| `MNEMOSYNE_BLOBS_PATH` | Blob storage directory | `./data/blobs` |
| `MNEMOSYNE_DEFAULT_NAMESPACE` | Default namespace | `_` |
| `DATABASE_URL` | Postgres connection (enables Server mode) | — |
| `DATABASE_PASSWORD` | Separate password (for special chars) | — |
| `REDIS_URL` | Redis connection | — |
| `QDRANT_URL` | Qdrant endpoint | — |
| `QDRANT_API_KEY` | Qdrant API key | — |

## Architecture

```
              ┌─────────────────────┐
              │    MCP Transport    │
              │   (stdio / HTTP)    │
              └────────┬────────────┘
                       │
              ┌────────▼────────────┐
              │    15 MCP Tools     │
              └────────┬────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
    ┌────▼────┐  ┌─────▼─────┐ ┌────▼────┐
    │ Memory  │  │ Knowledge │ │  Hybrid │
    │  Store  │  │   Graph   │ │ Recall  │
    └────┬────┘  └─────┬─────┘ └────┬────┘
         │             │             │
    ┌────▼─────────────▼─────────────▼────┐
    │         7 Pluggable Interfaces      │
    ├─────────────────────────────────────┤
    │ MemoryStore · GraphStore · Vectors  │
    │ JobQueue · BlobStore · EventLog     │
    │ LifecycleManager                    │
    └────────┬───────────────┬────────────┘
             │               │
    ┌────────▼──────┐ ┌──────▼──────────┐
    │   Personal    │ │     Server      │
    │   (SQLite)    │ │  (Cloud infra)  │
    └───────────────┘ └─────────────────┘
```

Each interface is independently swappable. Mix SQLite memory store with Qdrant vectors? Go ahead.

## Dependencies

### Runtime

| Package | Purpose | Mode |
|---|---|---|
| `better-sqlite3` | SQLite driver | Personal |
| `pg` | Postgres driver | Server |
| `ioredis` + `bullmq` | Redis client + job queue | Server |
| `@qdrant/js-client-rest` | Qdrant vector search client | Server |
| `@modelcontextprotocol/sdk` | MCP protocol | Both |
| `zod` | Schema validation | Both |

### Development

| Package | Purpose |
|---|---|
| `vitest` | Test runner |
| `tsup` | ESM bundler |
| `typescript` | Type checking |

## Development

```bash
git clone https://github.com/studiomosaiko/mnemosyne-mcp.git
cd mnemosyne-mcp
npm install
npm run build
npm test
```

## License

MIT — [Studio Mosaiko](https://github.com/studiomosaiko)
