/**
 * V3 CLI Attention Command
 * WASM-accelerated attention mechanisms with 39 types
 *
 * Features:
 * - 39 attention mechanism types (MHA, Flash, Linear, Sparse, MoE)
 * - WASM acceleration via ruvector (250x speedup)
 * - Automatic backend selection (WASM/TypeScript)
 * - Benchmarking and comparison tools
 * - Hyperbolic distance computation
 *
 * Created with ❤️ by ruv.io
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';

// Dynamic import for attention package
async function getAttention() {
  try {
    return await import('@claude-flow/attention');
  } catch {
    return null;
  }
}

// List subcommand - show all mechanisms
const listCommand: Command = {
  name: 'list',
  description: 'List all attention mechanisms',
  options: [
    { name: 'category', short: 'c', type: 'string', description: 'Filter by category (multi-head, sparse, linear, flash, moe)' },
    { name: 'wasm', short: 'w', type: 'boolean', description: 'Show only WASM-enabled mechanisms' },
    { name: 'long-sequence', short: 'l', type: 'boolean', description: 'Show only long-sequence mechanisms' },
    { name: 'format', short: 'f', type: 'string', description: 'Output format: table, json', default: 'table' },
  ],
  examples: [
    { command: 'claude-flow attention list', description: 'List all mechanisms' },
    { command: 'claude-flow attention list -c flash', description: 'Show only flash attention' },
    { command: 'claude-flow attention list --wasm', description: 'Show WASM-enabled' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const category = ctx.flags.category as string | undefined;
    const wasmOnly = ctx.flags.wasm as boolean;
    const longSeqOnly = ctx.flags['long-sequence'] as boolean;
    const format = ctx.flags.format as string || 'table';

    output.writeln();
    output.writeln(output.bold('Attention Mechanisms'));
    output.writeln(output.dim('─'.repeat(60)));

    const attention = await getAttention();
    if (!attention) {
      output.printError('@claude-flow/attention package not available');
      return { success: false, exitCode: 1 };
    }

    let mechanisms = attention.registry.list();

    // Filter by category
    if (category) {
      mechanisms = mechanisms.filter(m => m.category === category);
    }

    // Filter by WASM support
    if (wasmOnly) {
      mechanisms = mechanisms.filter(m => m.wasmAvailable);
    }

    // Filter by long sequence support
    if (longSeqOnly) {
      mechanisms = mechanisms.filter(m => m.longSequenceSupport);
    }

    if (format === 'json') {
      output.printJson(mechanisms);
      return { success: true, data: mechanisms };
    }

    // Table format
    const categories = new Map<string, typeof mechanisms>();
    for (const m of mechanisms) {
      const cat = categories.get(m.category) || [];
      cat.push(m);
      categories.set(m.category, cat);
    }

    for (const [cat, mechs] of categories) {
      output.writeln();
      output.writeln(output.bold(output.cyan(`${cat.toUpperCase()} (${mechs.length})`)));

      for (const m of mechs) {
        const wasmBadge = m.wasmAvailable ? output.green('⚡ WASM') : output.dim('TS');
        const longSeqBadge = m.longSequenceSupport ? output.yellow('📊 Long') : '';
        output.writeln(`  ${m.type.padEnd(30)} ${wasmBadge.padEnd(15)} ${m.complexity.padEnd(12)} ${longSeqBadge}`);
      }
    }

    output.writeln();
    output.writeln(output.dim(`Total: ${mechanisms.length} mechanisms`));

    return { success: true, data: mechanisms };
  },
};

// Info subcommand - get details about a mechanism
const infoCommand: Command = {
  name: 'info',
  description: 'Get detailed info about an attention mechanism',
  options: [
    { name: 'mechanism', short: 'm', type: 'string', description: 'Mechanism type', required: true },
    { name: 'format', short: 'f', type: 'string', description: 'Output format: table, json', default: 'table' },
  ],
  examples: [
    { command: 'claude-flow attention info -m flash-attention-v2', description: 'Get flash attention info' },
    { command: 'claude-flow attention info -m linear-attention --format json', description: 'JSON output' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const mechanism = ctx.flags.mechanism as string;
    const format = ctx.flags.format as string || 'table';

    if (!mechanism) {
      output.printError('Mechanism type is required');
      return { success: false, exitCode: 1 };
    }

    const attention = await getAttention();
    if (!attention) {
      output.printError('@claude-flow/attention package not available');
      return { success: false, exitCode: 1 };
    }

    const info = attention.registry.get(mechanism as any);
    if (!info) {
      output.printError(`Unknown mechanism: ${mechanism}`);
      return { success: false, exitCode: 1 };
    }

    if (format === 'json') {
      output.printJson(info);
      return { success: true, data: info };
    }

    output.writeln();
    output.printBox([
      `Type: ${output.bold(info.type)}`,
      `Name: ${info.name}`,
      `Category: ${info.category}`,
      `Complexity: ${info.complexity}`,
      ``,
      `Description:`,
      `  ${info.description}`,
      ``,
      `Features:`,
      `  WASM Acceleration: ${info.wasmAvailable ? output.green('Yes') : output.dim('No')}`,
      `  Memory Efficient: ${info.memoryEfficient ? output.green('Yes') : output.dim('No')}`,
      `  Long Sequence: ${info.longSequenceSupport ? output.green('Yes') : output.dim('No')}`,
      ``,
      `Supported Backends: ${info.supportedBackends.join(', ')}`,
    ].join('\n'), `Mechanism: ${info.type}`);

    return { success: true, data: info };
  },
};

// Benchmark subcommand - benchmark mechanisms
const benchmarkCommand: Command = {
  name: 'benchmark',
  description: 'Benchmark attention mechanisms',
  options: [
    { name: 'mechanism', short: 'm', type: 'string', description: 'Mechanism to benchmark (or "all")' },
    { name: 'seq-len', short: 's', type: 'number', description: 'Sequence length', default: '512' },
    { name: 'dim', short: 'd', type: 'number', description: 'Embedding dimension', default: '384' },
    { name: 'iterations', short: 'i', type: 'number', description: 'Number of iterations', default: '100' },
    { name: 'format', short: 'f', type: 'string', description: 'Output format: table, json', default: 'table' },
  ],
  examples: [
    { command: 'claude-flow attention benchmark -m flash-attention-v2', description: 'Benchmark flash attention' },
    { command: 'claude-flow attention benchmark -m all -s 1024', description: 'Benchmark all with seq_len=1024' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const mechanism = ctx.flags.mechanism as string || 'flash-attention-v2';
    const seqLen = parseInt(ctx.flags['seq-len'] as string) || 512;
    const dim = parseInt(ctx.flags.dim as string) || 384;
    const iterations = parseInt(ctx.flags.iterations as string) || 100;
    const format = ctx.flags.format as string || 'table';

    output.writeln();
    output.writeln(output.bold('Attention Benchmark'));
    output.writeln(output.dim('─'.repeat(50)));

    const attention = await getAttention();
    if (!attention) {
      output.printError('@claude-flow/attention package not available');
      return { success: false, exitCode: 1 };
    }

    const service = await attention.createAttentionService();

    output.writeln(`Sequence Length: ${seqLen}`);
    output.writeln(`Embedding Dim: ${dim}`);
    output.writeln(`Iterations: ${iterations}`);
    output.writeln(`Backend: ${service.getBackend()}`);
    output.writeln();

    const spinner = output.createSpinner({ text: 'Running benchmark...', spinner: 'dots' });
    spinner.start();

    try {
      if (mechanism === 'all') {
        // Benchmark core mechanisms
        const mechanisms = ['standard-mha', 'flash-attention-v2', 'linear-attention', 'moe-attention'] as const;
        const comparison = await service.compareMechanisms([...mechanisms], {
          sequenceLength: seqLen,
          iterations,
        });

        spinner.succeed('Benchmark complete');

        if (format === 'json') {
          output.printJson({
            results: comparison.results,
            recommendations: comparison.recommendations,
          });
          return { success: true, data: comparison };
        }

        output.writeln();
        output.writeln(output.bold('Results:'));
        for (const result of comparison.results) {
          const speedup = comparison.speedupFactors.get(result.mechanism) || 1;
          output.writeln(
            `  ${result.mechanism.padEnd(25)} ${result.latencyMs.toFixed(2).padStart(8)}ms  ` +
            `${(speedup).toFixed(2)}x  ${result.throughputOpsPerSec.toFixed(0).padStart(6)} ops/s`
          );
        }

        output.writeln();
        output.writeln(output.bold('Recommendations:'));
        for (const rec of comparison.recommendations) {
          output.writeln(`  • ${rec}`);
        }

        return { success: true, data: comparison };
      }

      // Single mechanism benchmark
      const result = await service.benchmark(mechanism as any, {
        sequenceLength: seqLen,
        dim,
        iterations,
      });

      spinner.succeed('Benchmark complete');

      if (format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox([
        `Mechanism: ${result.mechanism}`,
        `Backend: ${result.backend}`,
        ``,
        `Latency:`,
        `  Mean: ${result.latencyMs.toFixed(2)}ms`,
        `  P50:  ${result.latencyP50Ms.toFixed(2)}ms`,
        `  P95:  ${result.latencyP95Ms.toFixed(2)}ms`,
        `  P99:  ${result.latencyP99Ms.toFixed(2)}ms`,
        ``,
        `Throughput: ${result.throughputOpsPerSec.toFixed(0)} ops/sec`,
        `Memory: ${(result.memoryBytes / 1024).toFixed(1)} KB`,
      ].join('\n'), 'Benchmark Results');

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Benchmark failed');
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// Compute subcommand - run attention computation
const computeCommand: Command = {
  name: 'compute',
  description: 'Compute attention on input data',
  options: [
    { name: 'mechanism', short: 'm', type: 'string', description: 'Mechanism to use', default: 'auto' },
    { name: 'query', short: 'q', type: 'string', description: 'Query vector (JSON array)', required: true },
    { name: 'keys', short: 'k', type: 'string', description: 'Key vectors (JSON array of arrays)', required: true },
    { name: 'values', short: 'v', type: 'string', description: 'Value vectors (JSON array of arrays)', required: true },
    { name: 'format', short: 'f', type: 'string', description: 'Output format: array, json', default: 'json' },
  ],
  examples: [
    { command: 'claude-flow attention compute -q "[1,2,3,4]" -k "[[1,0,0,0],[0,1,0,0]]" -v "[[1,0,0,0],[0,1,0,0]]"', description: 'Basic computation' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const mechanism = ctx.flags.mechanism as string || 'auto';
    const queryStr = ctx.flags.query as string;
    const keysStr = ctx.flags.keys as string;
    const valuesStr = ctx.flags.values as string;
    const format = ctx.flags.format as string || 'json';

    try {
      const query = JSON.parse(queryStr);
      const keys = JSON.parse(keysStr);
      const values = JSON.parse(valuesStr);

      const attention = await getAttention();
      if (!attention) {
        output.printError('@claude-flow/attention package not available');
        return { success: false, exitCode: 1 };
      }

      const service = await attention.createAttentionService();

      const spinner = output.createSpinner({ text: 'Computing attention...', spinner: 'dots' });
      spinner.start();

      const result = mechanism === 'auto'
        ? await service.forward({ query, key: keys, value: values })
        : await service.compute({ query, key: keys, value: values }, mechanism as any);

      spinner.succeed(`Computed in ${result.metadata.latencyMs.toFixed(2)}ms`);

      if (format === 'array') {
        output.writeln(JSON.stringify(Array.from(result.output)));
        return { success: true, data: result };
      }

      output.printJson({
        output: Array.from(result.output),
        metadata: result.metadata,
      });

      return { success: true, data: result };
    } catch (error) {
      output.printError(`Invalid input: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Status subcommand - check WASM status
const statusCommand: Command = {
  name: 'status',
  description: 'Check attention system status',
  options: [
    { name: 'format', short: 'f', type: 'string', description: 'Output format: table, json', default: 'table' },
  ],
  examples: [
    { command: 'claude-flow attention status', description: 'Show system status' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const format = ctx.flags.format as string || 'table';

    output.writeln();
    output.writeln(output.bold('Attention System Status'));
    output.writeln(output.dim('─'.repeat(50)));

    const attention = await getAttention();
    if (!attention) {
      output.printError('@claude-flow/attention package not available');
      return { success: false, exitCode: 1 };
    }

    const service = await attention.createAttentionService();
    const wasmAvailable = await attention.isWASMAvailable();
    const simdAvailable = await attention.isSIMDAvailable();
    const mechanisms = attention.registry.list();
    const wasmMechanisms = attention.registry.wasmEnabled();
    const longSeqMechanisms = attention.registry.longSequence();

    const status = {
      version: attention.VERSION,
      backend: service.getBackend(),
      wasmAvailable,
      simdAvailable,
      accelerated: service.isAccelerated(),
      totalMechanisms: mechanisms.length,
      wasmMechanisms: wasmMechanisms.length,
      longSeqMechanisms: longSeqMechanisms.length,
      features: attention.FEATURES,
    };

    if (format === 'json') {
      output.printJson(status);
      return { success: true, data: status };
    }

    output.printBox([
      `Version: ${status.version}`,
      ``,
      `Runtime:`,
      `  Backend: ${status.backend}`,
      `  WASM Available: ${status.wasmAvailable ? output.green('Yes') : output.red('No')}`,
      `  SIMD Available: ${status.simdAvailable ? output.green('Yes') : output.red('No')}`,
      `  Accelerated: ${status.accelerated ? output.green('Yes') : output.dim('No')}`,
      ``,
      `Mechanisms:`,
      `  Total: ${status.totalMechanisms}`,
      `  WASM-enabled: ${status.wasmMechanisms}`,
      `  Long-sequence: ${status.longSeqMechanisms}`,
      ``,
      `Features:`,
      `  Flash Attention: ${status.features.flashAttention ? output.green('✓') : output.dim('✗')}`,
      `  Linear Attention: ${status.features.linearAttention ? output.green('✓') : output.dim('✗')}`,
      `  MoE Attention: ${status.features.moeAttention ? output.green('✓') : output.dim('✗')}`,
      `  HNSW Search: ${status.features.hnswSearch ? output.green('✓') : output.dim('✗')}`,
      `  Hyperbolic Distance: ${status.features.hyperbolicDistance ? output.green('✓') : output.dim('✗')}`,
    ].join('\n'), 'Attention System');

    return { success: true, data: status };
  },
};

// Recommend subcommand - get mechanism recommendation
const recommendCommand: Command = {
  name: 'recommend',
  description: 'Get mechanism recommendation for sequence length',
  options: [
    { name: 'seq-len', short: 's', type: 'number', description: 'Sequence length', required: true },
    { name: 'memory', short: 'm', type: 'boolean', description: 'Prefer memory-efficient mechanisms' },
    { name: 'format', short: 'f', type: 'string', description: 'Output format: text, json', default: 'text' },
  ],
  examples: [
    { command: 'claude-flow attention recommend -s 512', description: 'Recommend for seq_len=512' },
    { command: 'claude-flow attention recommend -s 16384 --memory', description: 'Memory-efficient for long sequence' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const seqLen = parseInt(ctx.flags['seq-len'] as string);
    const preferMemory = ctx.flags.memory as boolean;
    const format = ctx.flags.format as string || 'text';

    if (isNaN(seqLen) || seqLen <= 0) {
      output.printError('Valid sequence length is required');
      return { success: false, exitCode: 1 };
    }

    const attention = await getAttention();
    if (!attention) {
      output.printError('@claude-flow/attention package not available');
      return { success: false, exitCode: 1 };
    }

    const recommended = attention.recommendMechanism(seqLen);
    const info = attention.registry.get(recommended as any);

    const result = {
      sequenceLength: seqLen,
      recommended,
      reason: getRecommendationReason(seqLen),
      alternatives: getAlternatives(seqLen, preferMemory),
      info,
    };

    if (format === 'json') {
      output.printJson(result);
      return { success: true, data: result };
    }

    output.writeln();
    output.writeln(`For sequence length ${output.bold(String(seqLen))}:`);
    output.writeln();
    output.writeln(`  ${output.green('→')} Recommended: ${output.bold(recommended)}`);
    output.writeln(`    ${result.reason}`);
    output.writeln();
    output.writeln(`  Alternatives:`);
    for (const alt of result.alternatives) {
      output.writeln(`    • ${alt}`);
    }

    return { success: true, data: result };
  },
};

function getRecommendationReason(seqLen: number): string {
  if (seqLen > 8192) {
    return 'Very long sequence - linear complexity required';
  }
  if (seqLen > 2048) {
    return 'Long sequence - memory-efficient tiling beneficial';
  }
  if (seqLen > 512) {
    return 'Medium sequence - Flash Attention optimal';
  }
  return 'Short sequence - standard attention works well';
}

function getAlternatives(seqLen: number, preferMemory: boolean): string[] {
  if (seqLen > 8192) {
    return ['performer-attention', 'linformer-attention', 'nystrom-attention'];
  }
  if (seqLen > 2048) {
    return preferMemory
      ? ['linear-attention', 'longformer-attention']
      : ['flash-attention-v3', 'linear-attention'];
  }
  return ['standard-mha', 'causal-self-attention'];
}

// Main attention command
export const attentionCommand: Command = {
  name: 'attention',
  description: 'Attention mechanism management (39 types, WASM-accelerated)',
  subcommands: [
    listCommand,
    infoCommand,
    benchmarkCommand,
    computeCommand,
    statusCommand,
    recommendCommand,
  ],
  options: [],
  examples: [
    { command: 'claude-flow attention list', description: 'List all mechanisms' },
    { command: 'claude-flow attention status', description: 'Check system status' },
    { command: 'claude-flow attention benchmark -m flash-attention-v2', description: 'Benchmark flash attention' },
    { command: 'claude-flow attention recommend -s 4096', description: 'Get recommendation' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Show help if no subcommand
    output.writeln();
    output.writeln(output.bold('@claude-flow/attention'));
    output.writeln('WASM-accelerated attention mechanisms (39 types)');
    output.writeln();
    output.writeln(output.bold('Subcommands:'));
    output.writeln('  list       List all attention mechanisms');
    output.writeln('  info       Get details about a mechanism');
    output.writeln('  benchmark  Run performance benchmarks');
    output.writeln('  compute    Compute attention on input');
    output.writeln('  status     Check system status');
    output.writeln('  recommend  Get mechanism recommendation');
    output.writeln();
    output.writeln(output.dim('Run "claude-flow attention <subcommand> --help" for more info'));

    return { success: true };
  },
};

export default attentionCommand;
