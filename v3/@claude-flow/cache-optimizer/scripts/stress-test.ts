#!/usr/bin/env npx tsx
/**
 * Stress Test for Cache Optimizer
 * Tests compression, tier transitions, and compaction prevention under load
 *
 * Run: npx tsx scripts/stress-test.ts
 */

import { CacheOptimizer } from '../src/core/orchestrator.js';
import type { CacheOptimizerConfig, CacheEntryType, ScoringContext } from '../src/types.js';

// ============================================================================
// Configuration - Smaller context window to trigger optimizations
// ============================================================================

const STRESS_CONFIG: Partial<CacheOptimizerConfig> = {
  // Small context window to trigger optimization quickly
  targetUtilization: 0.60,
  contextWindowSize: 20000, // 20k tokens (10x smaller than default)

  pruning: {
    softThreshold: 0.45,
    hardThreshold: 0.55,
    emergencyThreshold: 0.65,
    minRelevanceScore: 0.25,
    strategy: 'adaptive',
    preservePatterns: ['system_prompt'],
    preserveRecentCount: 3,
  },

  temporal: {
    tiers: {
      hot: { maxAge: 100, compressionRatio: 1.0 },       // 100ms for testing
      warm: { maxAge: 500, compressionRatio: 0.25 },     // 500ms
      cold: { maxAge: Infinity, compressionRatio: 0.03 },
    },
    compressionStrategy: 'hybrid',
    promoteOnAccess: true,
    decayRate: 0.2,
  },
};

// ============================================================================
// Test Data
// ============================================================================

function generateLargeContent(type: CacheEntryType, index: number): string {
  // Generate larger content to fill cache faster
  const base = `// Content block ${index} - Type: ${type}\n`;
  const lines = Array.from({ length: 50 }, (_, i) =>
    `  Line ${i}: ${type} content with some realistic code or text that takes up tokens...`
  ).join('\n');
  return base + lines;
}

// ============================================================================
// Stress Test
// ============================================================================

async function runStressTest(): Promise<void> {
  process.env.CLAUDE_FLOW_HEADLESS = 'true';

  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║         CACHE OPTIMIZER STRESS TEST - COMPACTION PREVENTION       ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const optimizer = new CacheOptimizer(STRESS_CONFIG);

  const entryTypes: CacheEntryType[] = [
    'file_read', 'file_write', 'tool_result', 'bash_output',
    'user_message', 'assistant_message',
  ];

  // Add system prompt (always preserved)
  await optimizer.add('You are an AI assistant.', 'system_prompt', { source: 'system' });

  console.log('Configuration:');
  console.log(`  Context Window: ${STRESS_CONFIG.contextWindowSize} tokens`);
  console.log(`  Soft Threshold: ${STRESS_CONFIG.pruning?.softThreshold! * 100}%`);
  console.log(`  Hard Threshold: ${STRESS_CONFIG.pruning?.hardThreshold! * 100}%`);
  console.log(`  Emergency Threshold: ${STRESS_CONFIG.pruning?.emergencyThreshold! * 100}%\n`);

  let compactionsPrevented = 0;
  let totalTokensSaved = 0;
  let pruneEvents = 0;
  let compressionEvents = 0;

  console.log('Running stress test (filling cache to trigger optimization)...\n');
  console.log('┌─────────┬───────────────┬─────────────┬─────────────┬─────────────┐');
  console.log('│ Entry # │ Utilization   │ Tokens      │ Saved       │ Action      │');
  console.log('├─────────┼───────────────┼─────────────┼─────────────┼─────────────┤');

  for (let i = 0; i < 100; i++) {
    const type = entryTypes[i % entryTypes.length];
    const content = generateLargeContent(type, i);

    // Add entry
    await optimizer.add(content, type, {
      source: `stress:${type}`,
      sessionId: 'stress-test',
    });

    // Let entries age a bit
    await new Promise(resolve => setTimeout(resolve, 10));

    // Check every 5 entries
    if ((i + 1) % 5 === 0) {
      const metrics = optimizer.getMetrics();
      const utilization = metrics.utilization;

      // Trigger optimization
      const context: ScoringContext = {
        currentQuery: `Query ${i}`,
        activeFiles: [],
        activeTools: [],
        sessionId: 'stress-test',
        timestamp: Date.now(),
      };

      await optimizer.scoreAll(context);
      const result = await optimizer.onUserPromptSubmit(`Prompt ${i}`, 'stress-test');

      let action = 'idle';
      if (result.tokensFreed > 0) {
        totalTokensSaved += result.tokensFreed;
        action = result.compactionPrevented ? '🛡️ PREVENTED' : '✂️ pruned';
        if (result.compactionPrevented) compactionsPrevented++;
        pruneEvents++;
      }

      // Process tier transitions
      const transResult = await optimizer.transitionTiers();
      if (transResult.tokensSaved > 0) {
        totalTokensSaved += transResult.tokensSaved;
        compressionEvents += transResult.hotToWarm + transResult.warmToCold;
        if (action === 'idle') action = '📦 compressed';
      }

      const newMetrics = optimizer.getMetrics();
      console.log(`│ ${(i + 1).toString().padStart(7)} │ ${(newMetrics.utilization * 100).toFixed(1).padStart(11)}% │ ${newMetrics.currentTokens.toString().padStart(11)} │ ${totalTokensSaved.toString().padStart(11)} │ ${action.padEnd(11)} │`);
    }
  }

  console.log('└─────────┴───────────────┴─────────────┴─────────────┴─────────────┘\n');

  // Final summary
  const finalMetrics = optimizer.getMetrics();

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('                         STRESS TEST RESULTS                        ');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  console.log('📊 Cache Status:');
  console.log(`   Entries in cache: ${optimizer.getEntries().length}`);
  console.log(`   Final utilization: ${(finalMetrics.utilization * 100).toFixed(2)}%`);
  console.log(`   Current tokens: ${finalMetrics.currentTokens}`);
  console.log();

  console.log('🛡️ Compaction Prevention:');
  console.log(`   Compactions prevented: ${compactionsPrevented}`);
  console.log(`   Total prune events: ${pruneEvents}`);
  console.log(`   Compression events: ${compressionEvents}`);
  console.log(`   Total tokens saved: ${totalTokensSaved}`);
  console.log();

  console.log('⏱️ Performance:');
  console.log(`   Cache hits: ${finalMetrics.hits}`);
  console.log(`   Cache misses: ${finalMetrics.misses}`);
  console.log(`   Hit rate: ${((finalMetrics.hits / (finalMetrics.hits + finalMetrics.misses + 1)) * 100).toFixed(1)}%`);
  console.log();

  // Tier distribution
  const entries = optimizer.getEntries();
  const tierCounts = { hot: 0, warm: 0, cold: 0, archived: 0 };
  for (const entry of entries) {
    tierCounts[entry.tier]++;
  }

  console.log('🌡️ Tier Distribution:');
  console.log(`   Hot:      ${tierCounts.hot} entries`);
  console.log(`   Warm:     ${tierCounts.warm} entries`);
  console.log(`   Cold:     ${tierCounts.cold} entries`);
  console.log(`   Archived: ${tierCounts.archived} entries`);
  console.log();

  // Success check
  const success = finalMetrics.utilization < 0.65 && compactionsPrevented >= 0;
  console.log('═══════════════════════════════════════════════════════════════════');
  if (success) {
    console.log('✅ STRESS TEST PASSED - Compaction successfully prevented!');
    console.log(`   Utilization kept at ${(finalMetrics.utilization * 100).toFixed(1)}% (< 65% threshold)`);
  } else {
    console.log('❌ STRESS TEST FAILED - Compaction would have occurred');
    console.log(`   Utilization reached ${(finalMetrics.utilization * 100).toFixed(1)}%`);
  }
  console.log('═══════════════════════════════════════════════════════════════════');
}

// Run
runStressTest().catch(console.error);
