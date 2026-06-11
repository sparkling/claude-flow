/**
 * ADR-0327 (Batch-U follow-up of upstream c983c0d80 #14 + #6):
 *   #14 scrubReasoningBlocks — strips extended-thinking blocks from trajectory
 *       text before the DISTILL step embeds it into mpnet pattern vectors
 *       (ADR-0068), boundary-gated so prose mentioning the tags survives.
 *   #6  tool-loop circuit breaker — advisory warn@3 / block@5 for the same
 *       command failing consecutively. Orthogonal to the security guardrail.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { scrubReasoningBlocks } from '../src/mcp-tools/hooks-tools.js';
import {
  checkCommandLoop,
  recordCommandOutcome,
  _resetLoopHistory,
} from '../src/mcp-tools/tool-loop-guardrail.js';

describe('ADR-0327 #14 — scrubReasoningBlocks', () => {
  it('strips all extended-thinking tag variants', () => {
    expect(scrubReasoningBlocks('a<think>hidden</think>b')).toBe('ab');
    expect(scrubReasoningBlocks('a<thinking>hidden</thinking>b')).toBe('ab');
    expect(scrubReasoningBlocks('a<reasoning>hidden</reasoning>b')).toBe('ab');
    expect(scrubReasoningBlocks('a<thought>hidden</thought>b')).toBe('ab');
    expect(scrubReasoningBlocks('a<REASONING_SCRATCHPAD>hidden</REASONING_SCRATCHPAD>b')).toBe('ab');
  });

  it('is case-insensitive and strips multi-line blocks', () => {
    const input = 'before<Thinking>\nline1\nline2\n</Thinking>after';
    expect(scrubReasoningBlocks(input)).toBe('beforeafter');
  });

  it('strips multiple blocks in one string', () => {
    const input = '<think>one</think>keep<think>two</think>';
    expect(scrubReasoningBlocks(input)).toBe('keep');
  });

  it('boundary-gated: leaves prose that merely mentions the tag names untouched', () => {
    const prose = 'Use the <think> tag to enable extended thinking.';
    expect(scrubReasoningBlocks(prose)).toBe(prose);
  });

  it('returns input unchanged when there is no angle bracket (fast path)', () => {
    expect(scrubReasoningBlocks('plain action text')).toBe('plain action text');
  });

  it('tolerates non-string input', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(scrubReasoningBlocks(undefined)).toBeUndefined();
    // @ts-expect-error — exercising the runtime guard
    expect(scrubReasoningBlocks(42)).toBe(42);
  });
});

describe('ADR-0327 #6 — tool-loop circuit breaker thresholds', () => {
  beforeEach(() => {
    _resetLoopHistory();
  });

  it('allows a command with no prior failures', () => {
    expect(checkCommandLoop('npm test').verdict).toBe('allow');
    expect(checkCommandLoop('npm test').consecutiveFailures).toBe(0);
  });

  it('warns at 3 consecutive failures of the same command', () => {
    recordCommandOutcome('npm test', false);
    recordCommandOutcome('npm test', false);
    recordCommandOutcome('npm test', false);
    const v = checkCommandLoop('npm test');
    expect(v.verdict).toBe('warn');
    expect(v.consecutiveFailures).toBe(3);
    expect(v.hint).toMatch(/failed 3/);
  });

  it('blocks at 5 consecutive failures of the same command', () => {
    for (let i = 0; i < 5; i++) recordCommandOutcome('rm -rf nope', false);
    const v = checkCommandLoop('rm -rf nope');
    expect(v.verdict).toBe('block');
    expect(v.consecutiveFailures).toBe(5);
    expect(v.hint).toMatch(/failed 5/);
  });

  it('a success breaks the failure streak', () => {
    recordCommandOutcome('flaky', false);
    recordCommandOutcome('flaky', false);
    recordCommandOutcome('flaky', false);
    recordCommandOutcome('flaky', true); // recovery
    expect(checkCommandLoop('flaky').verdict).toBe('allow');
    expect(checkCommandLoop('flaky').consecutiveFailures).toBe(0);
  });

  it('interleaved other commands do not reset the streak (exact-match counting)', () => {
    recordCommandOutcome('target', false);
    recordCommandOutcome('something-else', true);
    recordCommandOutcome('target', false);
    recordCommandOutcome('another', false);
    recordCommandOutcome('target', false);
    const v = checkCommandLoop('target');
    expect(v.consecutiveFailures).toBe(3);
    expect(v.verdict).toBe('warn');
  });

  it('normalizes whitespace so re-runs of the same command count together', () => {
    recordCommandOutcome('npm   run    build', false);
    recordCommandOutcome('npm run build', false);
    recordCommandOutcome(' npm run build ', false);
    expect(checkCommandLoop('npm run build').consecutiveFailures).toBe(3);
  });
});
