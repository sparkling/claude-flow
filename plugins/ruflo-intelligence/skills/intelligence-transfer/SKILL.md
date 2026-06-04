---
name: intelligence-transfer
description: Transfer learned patterns from another project on disk into this one -- the project-to-project pattern transfer that hooks_transfer performs
argument-hint: "--source <project-path> [--filter <type>] [--min-confidence <0-1>]"
allowed-tools: mcp__ruflo__hooks_transfer mcp__ruflo__hooks_intelligence_pattern-search mcp__ruflo__hooks_intelligence_pattern-store mcp__ruflo__neural_patterns mcp__ruflo__neural_status Bash
---

# Intelligence Transfer

Project-to-project pattern sharing. Reads the learned patterns from another
project's memory store on disk and reports what would transfer into this one.

## What hooks_transfer actually does

`hooks_transfer` is a local, on-disk operation — it reads a source project's
memory store (`<sourcePath>/.claude-flow/memory/store.json`) and counts the
patterns it can transfer, grouped by type (file-patterns, task-routing,
command-risk, agent-success). There is no IPFS, no Pinata, no CID, and no
network call — this skill previously documented a surface the tool never had
(ADR-0293 D10).

### Parameters

- `sourcePath` (required) — filesystem path to the source project.
- `filter` (optional) — only transfer pattern types whose key contains this
  string (e.g. `routing`).
- `minConfidence` (optional, default 0.7) — minimum confidence threshold.

## Workflow

```bash
# Inspect what's stored locally first
mcp tool call neural_patterns --json -- '{"action": "list"}'

# Transfer patterns from a sibling project on disk
mcp tool call hooks_transfer --json -- '{"sourcePath": "/path/to/peer-project"}'

# Filter to a single pattern family, with a confidence floor
mcp tool call hooks_transfer --json -- '{"sourcePath": "/path/to/peer-project", "filter": "routing", "minConfidence": 0.8}'
```

On success the response is:

```json
{ "success": true, "sourcePath": "...", "transferred": { "total": 2, "byType": { "task-routing": 1, "agent-success": 1, "...": 0 } }, "dataSource": "source-project" }
```

If the source has no patterns (empty or nonexistent), the response is honest —
it does NOT fabricate demo data (ADR-0293 D2):

```json
{ "success": false, "message": "No patterns found in source project", "sourcePath": "...", "transferred": 0 }
```

## When to use this skill

- **Before a fresh project starts** — pull the relevant patterns from a parent
  project on the same machine so the new project's agents start with prior
  knowledge instead of cold.
- **Consolidating a monorepo or fleet** — fold a sibling project's learned
  patterns into a shared project.

## When NOT to use

- Across machines / over a network — `hooks_transfer` is local-disk only. There
  is no remote/IPFS transport in this build. Copy the source project's
  `.claude-flow/memory/store.json` to the target machine first, then run this
  against the local copy.
- For sensitive patterns — strip PII (use `aidefence_has_pii` first) before
  sharing a store between projects.

## Caveats

- This reads only the intelligence-side memory store; it does NOT export
  AgentDB rows. To ship full memory, use the `agentdb_*` / `memory_export`
  tools (out of scope here).
- The counts reflect the source project's actual entries — an empty source
  yields `success: false`, never a fabricated count.

## Related

- `ruflo-agentdb` ADR-0001 §"Namespace convention" — the `pattern` namespace
- `neural-train` skill — produces the patterns this skill transfers
