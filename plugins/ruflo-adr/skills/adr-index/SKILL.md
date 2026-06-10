---
name: adr-index
description: Build or rebuild the ADR index + dependency graph in AgentDB by running the in-process `agentdb index` command (one cold-start, all surfaces in one pass — no per-record npx round-trips). Handles v3-style and plugin-style ADR formats.
argument-hint: ""
allowed-tools: Bash mcp__ruflo__memory_list mcp__ruflo__memory_search mcp__ruflo__agentdb_hierarchical-query
---

# ADR Index

Builds the canonical ADR index over all three skill surfaces in ONE in-process
pass via the `agentdb index` command (ADR-0273):

- **hierarchical `adr/<id>`** — the records `agentdb_hierarchical-query adr/*` reads (SQLite, ADR-0176 key map)
- **`causal-edges`** — typed dependency edges (`supersedes` / `depends-on` / `implements`) plus their derived inverses (`superseded-by` / `depended-on-by` / `implemented-by`), written via `recordCausalEdge` (ADR-0273 D8)
- **`adr-patterns`** — a semantic excerpt per ADR (RVF + embedding), the namespace `memory_search` queries

This replaces the legacy `scripts/import.mjs`, which persisted every record and
edge with a separate `npx @sparkleideas/cli@latest memory store` subprocess —
one process per item (~840 on a 300-ADR corpus, ~0.5 s each, ~0.4 s of it pure
`@latest` registry-resolution tax; ADR-0088 / `reference-cli-cmd-helper`). The
in-process builder cold-starts the registry + embedder ONCE (~12-18 s) then
writes every surface in memory. It runs alongside a live MCP server with no
stop-server step (ADR-0274's read/write handle split). Handles both ADR formats
found in the Ruflo monorepo:

- **v3-style**: `# ADR-097: Title` heading + frontmatter
- **plugin-style**: YAML frontmatter (`status:`, `date:`, `tags:`, relation slots) — the canonical MADR shape (ADR-0271)

## When to use

- After importing ADRs from another project
- When the AgentDB graph is out of sync with the on-disk ADR files
- Bootstrapping ADR tracking on an existing codebase

## Steps

1. **Run the builder** (one Bash call — drives the in-process command, not a
   per-record subprocess loop):

   ```bash
   ruflo agentdb index --dir docs/adr
   ```

   Flags:
   - `--dir <path>` — ADR directory to scan (default: `docs/adr`). Scope this to
     the real corpus; do NOT scan the repo root (the `.claude/worktrees`
     over-reach the legacy cwd-walk suffered).
   - `--dry-run` — parse + report planned record/edge counts, write nothing.
   - `--purge` — clear all four index surfaces (hierarchical `adr/*`,
     `adr-patterns`, the `causal-edges` RVF/KV namespace, AND the SQLite
     `causal_edges` + `adr_node_ids` tables) before rebuilding, for a
     deterministic, idempotent re-index (ADR-0285 P1/P2). Use this for a
     rebuild; omit it only when appending to a known-empty index.

   The command prints `Parsed N ADR record(s)…` then, on completion,
   `agentdb index complete: <R>/<N> hierarchical records, <P> adr-patterns,
   <E> edges + <I> inverses`. A non-zero exit means one or more surface writes
   failed (the failures are listed) — investigate before trusting the index.

2. **Inspect the summary** — record count, adr-patterns count, forward edge
   count + derived-inverse count, and any write failures or
   silently-dropped-edge reconciliation warnings (ADR-0285).

3. **Verify the records are queryable** (optional but recommended):

   ```
   agentdb_hierarchical-query --pathPattern "adr/*"
   ```

   returns one record per indexed ADR.

4. **Search semantically** via `memory_search` against the populated namespace:

   ```
   memory_search --query "federation budget" --namespace adr-patterns
   ```

## Storage shape

`adr/<id>` hierarchical record (SQLite, `tier: semantic`), value (JSON):

```json
{ "id": "ADR-0097", "title": "…", "status": "accepted", "date": "2026-05-30",
  "tags": ["…"], "file": "ADR-0097-….md", "context": "<first paragraph of Context>" }
```

`adr-patterns` namespace (RVF + embedding), key `<ADR-id>`, value (text):
`<title> — <first paragraph of Context and Problem Statement>`.

`causal-edges` namespace (written via `recordCausalEdge`; ADR-0273 D8), key
`<from>→<to>` (arrow-joined ADR ids), value:

```json
{ "sourceId": "ADR-0097", "targetId": "ADR-0086", "relation": "supersedes", "weight": 1 }
```

Three forward relations are parsed from frontmatter — `supersedes`,
`depends-on`, `implements` — and exactly three inverses are derived caller-side
(`superseded-by`, `depended-on-by`, `implemented-by`; ADR-0273 D10). Never author
an inverse by hand.

## Parity with the legacy importer

The builder writes the **same records** and the **same forward edges** as the
legacy `import.mjs` for the three canonical relations, and *additionally* writes
the three derived inverses (which `import.mjs` never wrote). No record or forward
edge is lost in the migration — the inverses are an enhancement (traversable
typed edges in the causal graph, not opaque `adr-edges` blobs). `import.mjs` is
retained in `scripts/` as a documented fallback only; the canonical path is this
command.

## Cross-references

- `adr-create` — produces the ADR files this skill consumes (and emits the same canonical frontmatter the builder parses)
- `adr-review` — runs over `adr-patterns` for compliance checks
- `adr-verify` (sibling skill) — graph-integrity gating. NOTE: `adr-verify`'s
  `scripts/verify.mjs` currently reads the legacy `adr-edges` namespace; this
  builder writes edges to `causal-edges`. Run `adr-verify` against an index
  built by the legacy `import.mjs`, or migrate `verify.mjs` to read
  `causal-edges` (tracked under ADR-0305 T2).
