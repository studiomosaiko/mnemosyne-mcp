# 🧠 Mnemosyne — MCP Memory Server

> "Onde nada se perde."

The most complete memory system for AI agents. Inspired by human cognition, built for the MCP protocol.

## Overview

Mnemosyne gives AI agents what they've never had: **real memory** — persistent, semantic, relational, and temporal.

### Memory Types (inspired by human cognition)
- 🔵 **Episodic** — what happened (conversations, events, decisions)
- 🟢 **Semantic** — what is known (facts, concepts, preferences)
- 🟡 **Procedural** — how to do things (workflows, patterns, skills)

### Two Editions
- **Mnemosyne Personal** — SQLite, zero-config, local-first
- **Mnemosyne Server** — Postgres + Redis + Supabase, multi-agent, HTTP/SSE

### Key Features
- 15 MCP tools for reading, writing, and managing memory
- Hybrid search: vector + full-text + knowledge graph + structured
- Consolidation engine ("agent sleep") — compresses episodes into knowledge
- Multi-agent with namespace isolation enforced at schema level
- LGPD/GDPR compliant with full purge capability
- 7 composable sub-interfaces (mix and match storage backends)

## Status

🚧 **In development** — Phase 1 (Foundation)

See [PLAN.md](./PLAN.md) for the full architecture plan.

## License

TBD

---

*Built by [Studio Mosaiko](https://github.com/studiomosaiko) ⭐*
