/**
 * Tier-1 honesty guardrail for EnhancedModelRouter.
 *
 * ADR-0319 (Batch-U follow-up of upstream 0988d92ce/ADR-143): the fork ships no
 * code-transform executor, so a Tier-1 result is an honest "apply this small
 * structural edit yourself via the Edit tool, no model cost" recommendation —
 * NOT a WASM/$0/352x executor. Only the three genuinely-deterministic structural
 * intents may short-circuit to Tier-1; the three inference intents (add-types,
 * add-error-handling, async-await) need an LLM and MUST route to a model.
 *
 * This test pins that contract: route() returns tier:1 ONLY for the deterministic
 * intents and tier>=2 for the inference intents. It guards against a regression
 * that re-advertises a free WASM bypass for tasks that actually need a model.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEnhancedModelRouter,
  isDeterministicIntent,
  type EditIntentType,
} from '../src/ruvector/enhanced-model-router.js';

// Tasks chosen to match each intent's detection patterns with confidence at or
// above the 0.7 Agent-Booster threshold, and WITHOUT Tier-3 architectural
// keywords or file paths (so routing is decided purely by intent + complexity).
const DETERMINISTIC_TASKS: Record<string, EditIntentType> = {
  'convert var to const': 'var-to-const',
  'remove all console.log': 'remove-console',
  'add logging': 'add-logging',
};

const INFERENCE_TASKS: Record<string, EditIntentType> = {
  'add type annotations': 'add-types',
  'add error handling': 'add-error-handling',
  'convert to async/await': 'async-await',
};

let cwdRestore: string;
let tmpDir: string;

beforeEach(() => {
  // Hermetic cwd — the base ModelRouter persists Thompson-bandit state under
  // process.cwd(); keep it out of the repo tree.
  cwdRestore = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'enh-router-tier1-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(cwdRestore);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('EnhancedModelRouter Tier-1 honesty (ADR-0319)', () => {
  it('classifies exactly the three deterministic intents as deterministic', () => {
    expect(isDeterministicIntent('var-to-const')).toBe(true);
    expect(isDeterministicIntent('remove-console')).toBe(true);
    expect(isDeterministicIntent('add-logging')).toBe(true);
    expect(isDeterministicIntent('add-types')).toBe(false);
    expect(isDeterministicIntent('add-error-handling')).toBe(false);
    expect(isDeterministicIntent('async-await')).toBe(false);
  });

  it('routes deterministic structural edits to Tier-1 ($0, no LLM)', async () => {
    const router = createEnhancedModelRouter();
    for (const [task, expectedIntent] of Object.entries(DETERMINISTIC_TASKS)) {
      const result = await router.route(task);
      expect(result.tier, `task: "${task}"`).toBe(1);
      expect(result.canSkipLLM).toBe(true);
      expect(result.estimatedCost).toBe(0);
      expect(result.agentBoosterIntent?.type).toBe(expectedIntent);
    }
  });

  it('routes inference intents to a model (tier >= 2), never the free Tier-1 bypass', async () => {
    const router = createEnhancedModelRouter();
    for (const [task] of Object.entries(INFERENCE_TASKS)) {
      const result = await router.route(task);
      expect(result.tier, `task: "${task}"`).toBeGreaterThanOrEqual(2);
      expect(result.canSkipLLM).toBe(false);
      // A model-routed tier must name a real model and carry a real cost.
      expect(result.model).toBeDefined();
      expect(result.estimatedCost).toBeGreaterThan(0);
    }
  });
});
