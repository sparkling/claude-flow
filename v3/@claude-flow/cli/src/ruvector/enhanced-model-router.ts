/**
 * Enhanced Model Router with deterministic-edit fast path
 *
 * Implements ADR-026: 3-tier intelligent model routing:
 * - Tier 1: deterministic structural edits (var-to-const, remove-console,
 *   add-logging) — no LLM needed; the human applies them via the Edit tool
 *   at no model cost.
 * - Tier 2: Haiku - ~500ms for low complexity
 * - Tier 3: Sonnet/Opus - 2-5s for high complexity
 *
 * ADR-0319 (Batch-U follow-up of upstream 0988d92ce/ADR-143): the fork ships
 * NO code-transform executor, so Tier-1 is an honest "apply this small edit
 * yourself" recommendation — not a WASM/$0/352x "Agent Booster" that runs the
 * edit. Only the three genuinely-deterministic structural intents short-circuit
 * to Tier-1; the inference intents (add-types, add-error-handling, async-await)
 * fall through to normal model routing because they need an LLM.
 *
 * @module enhanced-model-router
 */

import { existsSync, readFileSync } from 'fs';
import { extname } from 'path';
import { ClaudeModel, getModelRouter, ModelRouter, ModelRoutingResult } from './model-router.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Code editing intent types that Agent Booster can handle
 */
export type EditIntentType =
  | 'var-to-const'
  | 'add-types'
  | 'add-error-handling'
  | 'async-await'
  | 'add-logging'
  | 'remove-console';

/**
 * The genuinely-deterministic structural edits — pure syntactic rewrites that
 * need no inference and so can be applied by the human via the Edit tool at no
 * model cost. The remaining intents (add-types, add-error-handling, async-await)
 * require inference and MUST route to a model.
 *
 * ADR-0319 (Batch-U follow-up of upstream 0988d92ce/ADR-143): only these three
 * may short-circuit to Tier-1; advertising Tier-1/$0 for the inference intents
 * was a false honesty claim (ADR-0172 class).
 */
const DETERMINISTIC_INTENTS: ReadonlySet<EditIntentType> = new Set([
  'var-to-const',
  'remove-console',
  'add-logging',
]);

/**
 * Whether an edit intent is a deterministic structural rewrite (no LLM needed).
 */
export function isDeterministicIntent(type: EditIntentType): boolean {
  return DETERMINISTIC_INTENTS.has(type);
}

/**
 * Detected edit intent from task analysis
 */
export interface EditIntent {
  type: EditIntentType;
  confidence: number;
  filePath?: string;
  language?: string;
  description: string;
}

/**
 * Enhanced routing result with Agent Booster support
 */
export interface EnhancedRouteResult {
  tier: 1 | 2 | 3;
  handler: 'agent-booster' | 'haiku' | 'sonnet' | 'opus';
  model?: ClaudeModel;
  confidence: number;
  complexity?: number;
  reasoning: string;
  agentBoosterIntent?: EditIntent;
  canSkipLLM?: boolean;
  estimatedLatencyMs: number;
  estimatedCost: number;
}

/**
 * Enhanced model router configuration
 */
export interface EnhancedModelRouterConfig {
  agentBoosterEnabled: boolean;
  agentBoosterConfidenceThreshold: number;
  enabledIntents: EditIntentType[];
  complexityThresholds: {
    haiku: number;
    sonnet: number;
    opus: number;
  };
  preferCost: boolean;
  preferQuality: boolean;
}

// ============================================================================
// Intent Detection Patterns
// ============================================================================

/**
 * Pattern definitions for Agent Booster intent detection
 */
const INTENT_PATTERNS: Record<EditIntentType, {
  patterns: RegExp[];
  weight: number;
  description: string;
}> = {
  'var-to-const': {
    patterns: [
      /convert\s+var\s+to\s+const/i,
      /change\s+var\s+to\s+const/i,
      /change\s+var\s+declarations?\s+to\s+const/i,
      /replace\s+var\s+with\s+const/i,
      /var\s*(?:→|->|to)\s*const/i,
      /use\s+const\s+instead\s+of\s+var/i,
    ],
    weight: 1.0,
    description: 'Convert var declarations to const/let',
  },
  'add-types': {
    patterns: [
      /add\s+type\s+annotations?/i,
      /add\s+typescript\s+types?/i,
      /type\s+this\s+function/i,
      /add\s+types?\s+to/i,
      /annotate\s+with\s+types?/i,
    ],
    weight: 0.9,
    description: 'Add TypeScript type annotations',
  },
  'add-error-handling': {
    patterns: [
      /add\s+error\s+handling/i,
      /wrap\s+in\s+try\s*[/-]?\s*catch/i,
      /add\s+try\s*[/-]?\s*catch/i,
      /handle\s+errors?/i,
      /add\s+exception\s+handling/i,
    ],
    weight: 0.7, // Lower weight - often needs more context
    description: 'Wrap code in try/catch blocks',
  },
  'async-await': {
    patterns: [
      /convert\s+to\s+async\s*[/-]?\s*await/i,
      /convert\s+\w+\s+to\s+async/i,
      /use\s+async\s*[/-]?\s*await/i,
      /change\s+promises?\s+to\s+async/i,
      /refactor\s+to\s+async/i,
      /\.then\s*(?:→|->|to)\s*await/i,
      /callback\s+to\s+async/i,
      /callbacks?\s+to\s+async/i,
    ],
    weight: 0.8,
    description: 'Convert callbacks/promises to async/await',
  },
  'add-logging': {
    patterns: [
      /add\s+logging/i,
      /add\s+console\.log/i,
      /add\s+debug\s+logs?/i,
      /log\s+this\s+function/i,
      /add\s+trace\s+logging/i,
    ],
    weight: 0.85,
    description: 'Add console.log or logging statements',
  },
  'remove-console': {
    patterns: [
      /remove\s+(?:all\s+)?console\.log/i,
      /remove\s+(?:all\s+)?console\s+statements?/i,
      /delete\s+(?:all\s+)?console\s+statements?/i,
      /strip\s+console/i,
      /clean\s+up\s+console/i,
      /clean\s+up\s+debug\s+logs?/i,
      /remove\s+(?:all\s+)?debug\s+logs?/i,
      /delete\s+(?:all\s+)?console\.log/i,
    ],
    weight: 0.95,
    description: 'Remove console.* calls',
  },
};

/**
 * File path extraction patterns
 */
const FILE_PATH_PATTERNS: RegExp[] = [
  /(?:in|from|to|file|path)\s+[`"']?([a-zA-Z0-9_./\\-]+\.[a-zA-Z]+)[`"']?/i,
  /[`"']([a-zA-Z0-9_./\\-]+\.[a-zA-Z]+)[`"']/,
  /(\S+\.[tj]sx?)\b/i,
  /(\S+\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|kt|swift|c|cpp|h))\b/i,
];

/**
 * Language detection by extension
 */
/**
 * High-complexity keywords that indicate Tier 3 (Opus) routing
 * These tasks require deep reasoning and architectural understanding
 */
const TIER3_KEYWORDS: RegExp[] = [
  // Architecture & Design
  /\b(microservices?|architecture|system\s+design|distributed)\b/i,
  /\b(design|architect|plan)\s+(a|an|the|complex)\b/i,
  /\b(design)\s+\w+\s+(schema|system|architecture)\b/i,

  // Security
  /\b(oauth2?|pkce|jwt|rbac|authentication\s+system|security\s+audit)\b/i,
  /\b(refresh\s+token|token\s+rotation|role-based|permission|authorization)\b/i,
  /\b(encryption|cryptograph|certificate|ssl|tls)\b/i,
  /\b(end-to-end\s+encryption|key\s+rotation|secure\s+channel)\b/i,

  // Distributed Systems
  /\b(consensus|distributed|byzantine|raft|paxos)\b/i,
  /\b(replication|sharding|partitioning|eventual\s+consistency)\b/i,
  /\b(load\s+balanc|fault[- ]toleran|high\s+availability)\b/i,
  /\b(message\s+queue|event\s+sourc|cqrs|saga)\b/i,

  // Complex Algorithms
  /\b(algorithm|machine\s+learning|neural|optimization)\b/i,
  /\b(graph\s+algorithm|tree\s+traversal|dynamic\s+programming)\b/i,

  // Database Design
  /\b(schema\s+design|database\s+architect|data\s+model)\b/i,
  /\b(database\s+schema|multi[- ]tenant)\b/i,
  /\b(normalization|denormalization|index\s+strateg)\b/i,

  // Performance Critical
  /\b(performance\s+critical|low\s+latency|high\s+throughput)\b/i,
  /\b(memory\s+optimi|cache\s+strateg|concurrent)\b/i,
];

const LANGUAGE_MAP: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
};

// ============================================================================
// Enhanced Model Router Implementation
// ============================================================================

/**
 * Enhanced Model Router with a deterministic-edit fast path
 *
 * Provides intelligent 3-tier routing:
 * - Tier 1: deterministic structural edits (var-to-const, remove-console,
 *   add-logging) the human applies via the Edit tool at no model cost
 * - Tier 2: Haiku for low complexity tasks
 * - Tier 3: Sonnet/Opus for complex reasoning tasks
 *
 * ADR-0319 (Batch-U follow-up of upstream 0988d92ce/ADR-143): the
 * `handler: 'agent-booster'` literal on a Tier-1 result is retained for
 * downstream type-union/telemetry stability; it denotes the deterministic-edit
 * path, NOT a WASM executor (the fork ships none).
 */
export class EnhancedModelRouter {
  private config: EnhancedModelRouterConfig;
  // The base text-routing path delegated to here is the local heuristic +
  // Thompson-bandit ModelRouter — NOT the @ruvector/tiny-dancer neural router an
  // earlier design (ADR-026) described (#2329, upstream 189e14b47). The public
  // getStats() return still exposes the field as `tinyDancerStats` for
  // telemetry-schema stability.
  private baseRouter: ModelRouter;

  constructor(config?: Partial<EnhancedModelRouterConfig>) {
    this.config = {
      agentBoosterEnabled: true,
      agentBoosterConfidenceThreshold: 0.7,
      enabledIntents: [
        'var-to-const',
        'add-types',
        'add-error-handling',
        'async-await',
        'add-logging',
        'remove-console',
      ],
      complexityThresholds: {
        haiku: 0.3,
        sonnet: 0.6,
        opus: 1.0,
      },
      preferCost: false,
      preferQuality: false,
      ...config,
    };

    this.baseRouter = getModelRouter();
  }

  /**
   * Detect code editing intent from task description
   */
  detectIntent(task: string): EditIntent | null {
    const taskLower = task.toLowerCase();
    let bestIntent: EditIntent | null = null;
    let bestScore = 0;

    for (const [intentType, config] of Object.entries(INTENT_PATTERNS)) {
      if (!this.config.enabledIntents.includes(intentType as EditIntentType)) {
        continue;
      }

      for (const pattern of config.patterns) {
        if (pattern.test(taskLower)) {
          const score = config.weight;
          if (score > bestScore) {
            bestScore = score;
            bestIntent = {
              type: intentType as EditIntentType,
              confidence: score,
              description: config.description,
            };
          }
        }
      }
    }

    // Extract file path if intent found
    if (bestIntent) {
      const filePath = this.extractFilePath(task);
      if (filePath) {
        bestIntent.filePath = filePath;
        bestIntent.language = this.detectLanguage(filePath);
        // Boost confidence if file exists
        if (existsSync(filePath)) {
          bestIntent.confidence = Math.min(1.0, bestIntent.confidence + 0.1);
        }
      }
    }

    return bestIntent;
  }

  /**
   * Extract file path from task description
   */
  private extractFilePath(task: string): string | null {
    for (const pattern of FILE_PATH_PATTERNS) {
      const match = task.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    return LANGUAGE_MAP[ext] || 'javascript';
  }

  /**
   * Check if task contains Tier 3 (Opus) keywords
   */
  private containsTier3Keywords(task: string): { matches: boolean; count: number } {
    let count = 0;
    for (const pattern of TIER3_KEYWORDS) {
      if (pattern.test(task)) {
        count++;
      }
    }
    return { matches: count > 0, count };
  }

  /**
   * Route a task to the optimal tier and handler
   */
  async route(task: string, context?: { filePath?: string }): Promise<EnhancedRouteResult> {
    // Step 1: Deterministic-edit fast path.
    // ADR-0319 (Batch-U follow-up of upstream 0988d92ce/ADR-143): only the three
    // genuinely-deterministic structural intents may short-circuit to Tier-1 (a
    // human-applied Edit at no model cost). The inference intents (add-types,
    // add-error-handling, async-await) are still detected — to keep the routing
    // signal — but fall through to normal model routing below, since they need
    // an LLM. Advertising Tier-1/$0 for them was a false honesty claim.
    if (this.config.agentBoosterEnabled) {
      const intent = this.detectIntent(task);

      if (
        intent &&
        intent.confidence >= this.config.agentBoosterConfidenceThreshold &&
        isDeterministicIntent(intent.type)
      ) {
        return {
          tier: 1,
          handler: 'agent-booster',
          confidence: intent.confidence,
          reasoning: `Deterministic structural edit "${intent.type}" (${(intent.confidence * 100).toFixed(0)}% confidence) — apply via Edit; no model needed`,
          agentBoosterIntent: intent,
          canSkipLLM: true,
          estimatedLatencyMs: 1,
          estimatedCost: 0,
        };
      }
    }

    // Step 2: Check for Tier 3 keywords (architecture, security, distributed)
    const tier3Check = this.containsTier3Keywords(task);
    if (tier3Check.matches && tier3Check.count >= 2) {
      // Strong signal for Opus - multiple complex keywords
      return {
        tier: 3,
        handler: 'opus',
        model: 'opus',
        confidence: Math.min(0.95, 0.7 + tier3Check.count * 0.1),
        complexity: 0.8 + tier3Check.count * 0.05,
        reasoning: `High complexity task (${tier3Check.count} architectural keywords) - using opus`,
        canSkipLLM: false,
        estimatedLatencyMs: 5000,
        estimatedCost: 0.015,
      };
    }

    // Step 3: AST complexity analysis (if file path provided)
    let astComplexity: number | undefined;
    const targetFile = context?.filePath || this.extractFilePath(task);

    if (targetFile && existsSync(targetFile)) {
      try {
        astComplexity = await this.analyzeASTComplexity(targetFile);
      } catch {
        // AST analysis not available, continue with text-based routing
      }
    }

    // Step 4: Text-based complexity via the local heuristic + bandit router
    const baseResult = await this.baseRouter.route(task);

    // Step 5: Combine AST complexity with the text-routing result
    // Also boost if single tier3 keyword found
    let finalComplexity = astComplexity !== undefined
      ? (astComplexity + baseResult.complexity) / 2
      : baseResult.complexity;

    // Boost complexity if tier3 keywords found (even just one)
    if (tier3Check.matches) {
      finalComplexity = Math.min(1.0, finalComplexity + 0.25);
    }

    // Step 6: Determine tier based on complexity
    const { haiku, sonnet } = this.config.complexityThresholds;

    if (finalComplexity < haiku) {
      return {
        tier: 2,
        handler: 'haiku',
        model: 'haiku',
        confidence: baseResult.confidence,
        complexity: finalComplexity,
        reasoning: `Low complexity (${(finalComplexity * 100).toFixed(0)}%) - using haiku`,
        canSkipLLM: false,
        estimatedLatencyMs: 500,
        estimatedCost: 0.0002,
      };
    }

    if (finalComplexity < sonnet) {
      return {
        tier: 2,
        handler: 'sonnet',
        model: 'sonnet',
        confidence: baseResult.confidence,
        complexity: finalComplexity,
        reasoning: `Medium complexity (${(finalComplexity * 100).toFixed(0)}%) - using sonnet`,
        canSkipLLM: false,
        estimatedLatencyMs: 2000,
        estimatedCost: 0.003,
      };
    }

    return {
      tier: 3,
      handler: 'opus',
      model: 'opus',
      confidence: baseResult.confidence,
      complexity: finalComplexity,
      reasoning: `High complexity (${(finalComplexity * 100).toFixed(0)}%) - using opus`,
      canSkipLLM: false,
      estimatedLatencyMs: 5000,
      estimatedCost: 0.015,
    };
  }

  /**
   * Analyze AST complexity of a file
   * Returns normalized complexity score (0-1)
   */
  private async analyzeASTComplexity(filePath: string): Promise<number> {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Simple heuristics for complexity
      let complexity = 0;

      // Line count contribution
      complexity += Math.min(0.3, lines.length / 1000);

      // Nesting depth estimation (count indentation)
      const avgIndent = lines
        .filter((l) => l.trim().length > 0)
        .map((l) => l.match(/^(\s*)/)?.[1].length || 0)
        .reduce((sum, indent) => sum + indent, 0) / Math.max(1, lines.length);
      complexity += Math.min(0.2, avgIndent / 20);

      // Control flow complexity (count keywords)
      const controlFlowCount = (content.match(/\b(if|else|for|while|switch|case|try|catch|async|await)\b/g) || []).length;
      complexity += Math.min(0.3, controlFlowCount / 100);

      // Function/class count
      const functionCount = (content.match(/\b(function|class|=>)\b/g) || []).length;
      complexity += Math.min(0.2, functionCount / 50);

      return Math.min(1, complexity);
    } catch {
      return 0.5; // Default to medium complexity on error
    }
  }

  // ADR-0319 (Batch-U follow-up of upstream 0988d92ce/ADR-143): the former
  // execute() + tryAgentBooster() pair was dead code — zero production callers
  // (route() is the live path) — and imported a non-resolving
  // `agentic-flow/agent-booster` executor the fork does not ship. Deleted to
  // remove the false "WASM runs the edit" capability; Tier-1 results are
  // recommendations the caller applies via the Edit tool. Do NOT port upstream's
  // TS-compiler codemod engine here (tracked separately).

  /**
   * Get router statistics
   */
  getStats(): {
    config: EnhancedModelRouterConfig;
    tinyDancerStats: ReturnType<ModelRouter['getStats']>;
  } {
    return {
      config: { ...this.config },
      // Field name kept as `tinyDancerStats` for telemetry-schema stability;
      // the underlying router is the local heuristic + bandit ModelRouter, not
      // @ruvector/tiny-dancer. See #2329 (upstream 189e14b47).
      tinyDancerStats: this.baseRouter.getStats(),
    };
  }
}

// ============================================================================
// Singleton & Factory Functions
// ============================================================================

let enhancedRouterInstance: EnhancedModelRouter | null = null;

/**
 * Get or create the singleton EnhancedModelRouter instance
 */
export function getEnhancedModelRouter(
  config?: Partial<EnhancedModelRouterConfig>
): EnhancedModelRouter {
  if (!enhancedRouterInstance) {
    enhancedRouterInstance = new EnhancedModelRouter(config);
  }
  return enhancedRouterInstance;
}

/**
 * Reset the singleton instance
 */
export function resetEnhancedModelRouter(): void {
  enhancedRouterInstance = null;
}

/**
 * Create a new EnhancedModelRouter instance (non-singleton)
 */
export function createEnhancedModelRouter(
  config?: Partial<EnhancedModelRouterConfig>
): EnhancedModelRouter {
  return new EnhancedModelRouter(config);
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Quick route function with enhanced routing
 */
export async function enhancedRouteToModel(
  task: string,
  context?: { filePath?: string }
): Promise<EnhancedRouteResult> {
  const router = getEnhancedModelRouter();
  return router.route(task, context);
}

/**
 * Detect if a task can be handled by Agent Booster
 */
export function canUseAgentBooster(task: string): {
  canUse: boolean;
  intent?: EditIntent;
} {
  const router = getEnhancedModelRouter();
  const intent = router.detectIntent(task);

  if (intent && intent.confidence >= 0.7) {
    return { canUse: true, intent };
  }

  return { canUse: false };
}
