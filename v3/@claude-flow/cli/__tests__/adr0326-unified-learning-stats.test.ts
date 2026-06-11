/**
 * ADR-0326 (upstream ca77f8307, #2245): unified learning-stats read-through view.
 *
 * getUnifiedLearningStats() aggregates the fork's four learning stat sources
 * (globalStats / in-memory SONA / memory-bridge AgentDB entries / neural store)
 * into ONE view where every sub-view names its source path and a `consistency`
 * block FLAGS cross-store drift instead of silently disagreeing. Benign
 * observability view — no mechanism change, does not touch the ADR-0290 seam.
 *
 * These tests run in a bare process (no live AgentDB/SONA), so the memory-bridge
 * leg is unreachable and the consistency block must SAY so — that is the point:
 * the view surfaces "this store couldn't be read", it doesn't pretend zero.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpRoot: string;
let prevCwd: string | undefined;

beforeAll(async () => {
  // Steer findProjectRoot() at a controlled temp project so the neural-store
  // read is deterministic (findProjectRoot honors CLAUDE_FLOW_CWD + .ruflo-project).
  tmpRoot = mkdtempSync(join(tmpdir(), 'adr0326-unified-'));
  writeFileSync(join(tmpRoot, '.ruflo-project'), '');
  const neuralDir = join(tmpRoot, '.claude-flow', 'neural');
  mkdirSync(neuralDir, { recursive: true });
  // Seed the neural store with two patterns (distinct types) and one model.
  writeFileSync(
    join(neuralDir, 'models.json'),
    JSON.stringify({
      version: '3.0.0',
      models: { 'm-1': { id: 'm-1', name: 'coder', type: 'classifier', status: 'ready', accuracy: 1, epochs: 1, config: {} } },
      patterns: {
        'p-1': { id: 'p-1', name: 'a', type: 'bug-fix', embedding: [], metadata: {}, createdAt: '', usageCount: 0 },
        'p-2': { id: 'p-2', name: 'b', type: 'bug-fix', embedding: [], metadata: {}, createdAt: '', usageCount: 0 },
        'p-3': { id: 'p-3', name: 'c', type: 'refactor', embedding: [], metadata: {}, createdAt: '', usageCount: 0 },
      },
    }),
  );
  prevCwd = process.env.CLAUDE_FLOW_CWD;
  process.env.CLAUDE_FLOW_CWD = tmpRoot;
  const { resetProjectRootCache } = await import('@claude-flow/shared/fs');
  resetProjectRootCache();
});

afterAll(async () => {
  if (prevCwd === undefined) delete process.env.CLAUDE_FLOW_CWD;
  else process.env.CLAUDE_FLOW_CWD = prevCwd;
  const { resetProjectRootCache } = await import('@claude-flow/shared/fs');
  resetProjectRootCache();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ADR-0326 — getNeuralStoreStats primitive', () => {
  it('reads the on-disk neural store and reports counts + per-type breakdown', async () => {
    const { getNeuralStoreStats } = await import('../src/mcp-tools/neural-tools.js');
    const s = getNeuralStoreStats();
    expect(s.patternCount).toBe(3);
    expect(s.modelCount).toBe(1);
    expect(s.byType).toEqual({ 'bug-fix': 2, refactor: 1 });
    expect(s.source).toContain('neural');
  });
});

describe('ADR-0326 — getUnifiedLearningStats view', () => {
  it('returns all four sub-views, each naming its source, plus consistency + timestamp', async () => {
    const { getUnifiedLearningStats } = await import('../src/memory/intelligence.js');
    const u = await getUnifiedLearningStats();

    // Four sub-views present.
    expect(u.global).toBeDefined();
    expect(u.sona).toBeDefined();
    expect(u.memoryBridge).toBeDefined();
    expect(u.neuralPatterns).toBeDefined();

    // Each sub-view names its source path (the whole point of the view).
    expect(typeof u.global.source).toBe('string');
    expect(typeof u.sona.source).toBe('string');
    expect(typeof u.memoryBridge.source).toBe('string');
    expect(typeof u.neuralPatterns.source).toBe('string');

    // Consistency block + generation timestamp.
    expect(u.consistency).toBeDefined();
    expect(Array.isArray(u.consistency.notes)).toBe(true);
    expect(typeof u.consistency.sonaTracksGlobal).toBe('boolean');
    expect(typeof u.consistency.sonaTracksGlobalDelta).toBe('number');
    expect(typeof u.generatedAt).toBe('string');
  });

  it('the neural sub-view reflects the seeded store (view reads the real source)', async () => {
    const { getUnifiedLearningStats } = await import('../src/memory/intelligence.js');
    const u = await getUnifiedLearningStats();
    expect(u.neuralPatterns.patternCount).toBe(3);
    expect(u.neuralPatterns.byType).toEqual({ 'bug-fix': 2, refactor: 1 });
  });

  it('FLAGS cross-store state instead of silently disagreeing: the consistency block reflects bridge reachability', async () => {
    const { getUnifiedLearningStats } = await import('../src/memory/intelligence.js');
    const u = await getUnifiedLearningStats();
    // Drift-flagging contract: the notes must REFLECT the bridge state — when the
    // bridge can't be read, the view says so (it does not pretend zero). This
    // holds whether or not a live AgentDB happens to be wired in the test process.
    const hasUnreachableNote = u.consistency.notes.some((n) => /memory-bridge unreachable/i.test(n));
    expect(hasUnreachableNote).toBe(!u.memoryBridge.reachable);
  });

  it('computes sonaTracksGlobal honestly: when SONA is unavailable it is not falsely flagged as drifting', async () => {
    const { getUnifiedLearningStats } = await import('../src/memory/intelligence.js');
    const u = await getUnifiedLearningStats();
    if (!u.sona.available) {
      // No SONA in-process → treat as tracking (no false drift alarm).
      expect(u.consistency.sonaTracksGlobal).toBe(true);
      expect(u.consistency.notes.some((n) => /sona\.trajectoriesTotal/i.test(n))).toBe(false);
    } else {
      // If SONA is live, the flag must agree with the computed delta.
      expect(u.consistency.sonaTracksGlobal).toBe(Math.abs(u.consistency.sonaTracksGlobalDelta) <= 1);
    }
  });
});
