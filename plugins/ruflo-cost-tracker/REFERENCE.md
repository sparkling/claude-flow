# ruflo-cost-tracker — Reference

Companion reference for `cost-analyst`. The agent prompt deliberately stays lean per [ADR-098 Part 2](../../v3/docs/adr/ADR-098-plugin-capability-sync-and-optimization.md); this file collects the pricing table, formulas, alert ladder, optimization catalog, and report shape the agent reads on-demand.

## Model pricing (USD per 1M tokens)

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| Haiku | $1.00 | $5.00 | $1.25 | $0.10 |
| Sonnet | $3.00 | $15.00 | $3.75 | $0.30 |
| Opus | $5.00 | $25.00 | $6.25 | $0.50 |

Prices are public-list (verified against the Anthropic pricing page, 2026-06-10) — re-verify when running quarterly cost reports. The **Haiku** row is Haiku-4.5; the **Opus** row is the current Opus 4.x family (4.5/4.6/4.7/4.8). `track.mjs`'s `modelTier()` maps every model containing "haiku"/"opus" to its row. (Legacy Opus 4.1 was $15/$75; Haiku-3 was $0.25/$1.25 — both off-default.)

## Cost attribution formula

```
task_cost = (input_tokens       / 1_000_000 * input_price)
          + (output_tokens      / 1_000_000 * output_price)
          + (cache_write_tokens / 1_000_000 * cache_write_price)
          + (cache_read_tokens  / 1_000_000 * cache_read_price)
```

Cache-read tokens are 90% cheaper than fresh input — that's where prompt caching pays off.

## Budget alert thresholds

| Level | Threshold | Action |
|---|---|---|
| Info | 50% consumed | Log notification, no UX disruption |
| Warning | 75% consumed | Display warning, suggest optimizations |
| Critical | 90% consumed | Urgent alert, recommend model downgrades |
| HARD_STOP | 100% consumed | Alert + opt-in fail-closed gate (`budget.mjs check` exits 1 — wrap spawns in `check && spawn`); does NOT auto-halt the daemon. Hard cut-off = ADR-097 federation circuit breaker. |

Budgets are configured per project + per session via the cost-tracker plugin commands.

> **Enforcement model (ADR-0307 T2):** this plugin does **attribution + alerting** only. `HARD_STOP` raises an alert and `budget.mjs check` exits 1 so you can gate a spawn opt-in (`check && spawn`), but no daemon or dispatch path consumes it automatically. The hard cut-off is upstream ADR-097's federation budget circuit breaker, which caps `maxTokens`/`maxUsd`/`maxHops` at the `federation_send` boundary.

## Optimization strategies

| Strategy | Savings | Quality / latency impact |
|---|---|---|
| Downgrade simple tasks to Haiku | 80–92% | Minimal for low-complexity work |
| Enable prompt caching | 90% on cache reads | None (same quality) |
| Batch similar operations | 15–25% | Slight latency increase |
| Reduce agent count | Linear | May slow parallel work |
| Use Agent Booster (Tier 1) | 100% (no LLM) | Only for simple transforms (var-to-const, add-types, etc.) |
| Shorten system prompts | 10–20% | Requires careful pruning |

Strategy ordering: Agent Booster first when the task fits, prompt caching always (it's free wins), then model downgrade and batching for stable workloads.

## Cost report shape

```
=== Cost Report (YYYY-MM-DD) ===

Total: $12.45 / $50.00 budget (24.9%)

By tier:
  Tier 1 (booster):     $0.00 (0.0%)   — 18 bypasses, $0 cost (no LLM call)
  Tier 2 (haiku):       $0.45 (3.6%)   — 1,200K input, 400K output
  Tier 3 (sonnet+opus): $12.00 (96.4%) — 1,980K input, 348K output

By model:
  Haiku:  $0.45 (3.6%)  — 1,200K input, 400K output
  Sonnet: $8.20 (65.9%) — 1,800K input, 320K output
  Opus:   $3.80 (30.5%) — 180K input, 28K output

By agent:
  coder:      $5.20 (41.8%) — sonnet
  architect:  $3.80 (30.5%) — opus
  researcher: $2.00 (16.1%) — sonnet
  tester:     $1.00 (8.0%)  — sonnet
  reviewer:   $0.45 (3.6%)  — haiku

Optimization opportunities:
  - reviewer already on haiku — no change needed
  - researcher tasks avg complexity 22% — consider haiku (-$1.60 savings)
  - architect cache hit rate 40% — enable caching (-$1.14 savings)
  - Tier 3 spend is 96.4% of total — see cost-booster-route skill to audit Tier 1 eligibility
```

### Tier classification rules

Tier classification at report-time uses two signals, in priority order:

1. **`[AGENT_BOOSTER_AVAILABLE]` flag** stored by the `cost-booster-route` skill in the `cost-tracking` namespace — authoritative when present.
2. **Model name fallback** — `haiku` → Tier 2; `sonnet`/`opus` → Tier 3; missing/unknown → Tier 3 (conservative).

The tier breakdown is the report's most actionable line: it tells the user *what fraction of Sonnet/Opus spend was Tier 1-eligible*. Without it, the report can't surface "you spent $X on Sonnet for tasks that should have routed to Tier 1" — see [ADR-0002 §"Decision 5"](docs/adrs/0002-agentic-flow-and-agent-booster-integration.md) for the rationale.

## Federation cost integration (ADR-097 pairing)

When `ruflo-federation` is loaded, `federation_send` calls carry optional `maxTokens` / `maxUsd` budget envelopes. Phase 1 enforces at the send side; Phase 3 (deferred) wires `federation_spend` events into this plugin's per-peer rolling aggregate so the cost report includes federated spend grouped by peer. Until Phase 3 ships, treat `cost-report` numbers as a **lower bound** when federation is in use.
