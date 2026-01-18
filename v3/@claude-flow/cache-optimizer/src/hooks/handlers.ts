/**
 * @claude-flow/cache-optimizer - Hook Handlers
 * Integration with Claude Code hooks for real-time cache optimization
 */

import type {
  CacheOptimizerConfig,
  HookResult,
  HookAction,
  CacheEntryType,
  ScoringContext,
} from '../types.js';
import { CacheOptimizer } from '../core/orchestrator.js';

/**
 * Hook handler for UserPromptSubmit
 * Called when user submits a prompt - proactively optimize cache
 */
export async function handleUserPromptSubmit(
  optimizer: CacheOptimizer,
  prompt: string,
  sessionId: string = 'default'
): Promise<HookResult> {
  return optimizer.onUserPromptSubmit(prompt, sessionId);
}

/**
 * Hook handler for PreToolUse
 * Called before a tool is executed - track context
 */
export async function handlePreToolUse(
  optimizer: CacheOptimizer,
  toolName: string,
  toolInput: unknown,
  sessionId: string = 'default'
): Promise<HookResult> {
  const startTime = Date.now();
  const actions: HookAction[] = [];

  // Determine entry type based on tool
  const typeMap: Record<string, CacheEntryType> = {
    'Read': 'file_read',
    'Write': 'file_write',
    'Edit': 'file_write',
    'Bash': 'bash_output',
    'Task': 'tool_result',
    'Glob': 'tool_result',
    'Grep': 'tool_result',
  };

  // Entry type determined for context (used in scoring)
  void (typeMap[toolName] || 'tool_result');

  // Extract file path if applicable
  let filePath: string | undefined;
  if (typeof toolInput === 'object' && toolInput !== null) {
    const input = toolInput as Record<string, unknown>;
    filePath = (input.file_path as string) || (input.path as string);
  }

  // Pre-score relevant entries to prepare for output
  const context: ScoringContext = {
    currentQuery: '',
    activeFiles: filePath ? [filePath] : [],
    activeTools: [toolName.toLowerCase()],
    sessionId,
    timestamp: startTime,
  };

  await optimizer.scoreAll(context);

  actions.push({
    type: 'score_update',
    details: `Pre-scored entries for ${toolName} tool use`,
  });

  return {
    success: true,
    actions,
    durationMs: Date.now() - startTime,
    compactionPrevented: false,
    tokensFreed: 0,
    newUtilization: optimizer.getUtilization(),
  };
}

/**
 * Hook handler for PostToolUse
 * Called after a tool is executed - add result to cache
 */
export async function handlePostToolUse(
  optimizer: CacheOptimizer,
  toolName: string,
  toolInput: unknown,
  toolOutput: string,
  success: boolean,
  sessionId: string = 'default'
): Promise<HookResult> {
  const startTime = Date.now();
  const actions: HookAction[] = [];

  if (!success || !toolOutput) {
    return {
      success: true,
      actions: [],
      durationMs: Date.now() - startTime,
      compactionPrevented: false,
      tokensFreed: 0,
      newUtilization: optimizer.getUtilization(),
    };
  }

  // Determine entry type
  const typeMap: Record<string, CacheEntryType> = {
    'Read': 'file_read',
    'Write': 'file_write',
    'Edit': 'file_write',
    'Bash': 'bash_output',
    'Task': 'tool_result',
    'Glob': 'tool_result',
    'Grep': 'tool_result',
  };

  const entryType = typeMap[toolName] || 'tool_result';

  // Extract metadata
  let filePath: string | undefined;
  if (typeof toolInput === 'object' && toolInput !== null) {
    const input = toolInput as Record<string, unknown>;
    filePath = (input.file_path as string) || (input.path as string);
  }

  // Add tool output to cache
  const entryId = await optimizer.add(toolOutput, entryType, {
    source: `tool:${toolName}`,
    toolName,
    filePath,
    sessionId,
    tags: ['tool_output', toolName.toLowerCase()],
  });

  actions.push({
    type: 'score_update',
    entryId,
    details: `Added ${toolName} output to cache (${toolOutput.length} chars)`,
  });

  // Check for proactive pruning
  const utilization = optimizer.getUtilization();
  let tokensFreed = 0;
  let compactionPrevented = false;

  if (utilization > 0.6) { // Soft threshold
    const hookResult = await optimizer.onUserPromptSubmit('', sessionId);
    tokensFreed = hookResult.tokensFreed;
    compactionPrevented = hookResult.compactionPrevented;

    if (tokensFreed > 0) {
      actions.push(...hookResult.actions);
    }
  }

  return {
    success: true,
    actions,
    durationMs: Date.now() - startTime,
    compactionPrevented,
    tokensFreed,
    newUtilization: optimizer.getUtilization(),
  };
}

/**
 * Hook handler for PreCompact
 * Called before compaction - last chance to prevent it
 */
export async function handlePreCompact(
  optimizer: CacheOptimizer,
  trigger: 'auto' | 'manual' = 'auto'
): Promise<HookResult> {
  return optimizer.onPreCompact(trigger);
}

/**
 * Hook handler for message completion
 * Called when assistant message is complete
 */
export async function handleMessageComplete(
  optimizer: CacheOptimizer,
  role: 'user' | 'assistant',
  content: string,
  sessionId: string = 'default'
): Promise<HookResult> {
  const startTime = Date.now();
  const actions: HookAction[] = [];

  const entryType: CacheEntryType = role === 'user' ? 'user_message' : 'assistant_message';

  // Add message to cache
  const entryId = await optimizer.add(content, entryType, {
    source: `message:${role}`,
    sessionId,
    tags: ['conversation', role],
  });

  actions.push({
    type: 'score_update',
    entryId,
    details: `Added ${role} message to cache`,
  });

  return {
    success: true,
    actions,
    durationMs: Date.now() - startTime,
    compactionPrevented: false,
    tokensFreed: 0,
    newUtilization: optimizer.getUtilization(),
  };
}

/**
 * Create hook configuration for .claude/settings.json
 */
export function createHookConfig(config?: Partial<CacheOptimizerConfig>): Record<string, unknown> {
  const timeouts = config?.hooks?.timeouts ?? {
    userPromptSubmit: 3000,
    preToolUse: 2000,
    postToolUse: 3000,
    preCompact: 5000,
  };

  return {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: '.*',
          hooks: [
            {
              type: 'command',
              command: `npx @claude-flow/cache-optimizer hook user-prompt-submit --timeout ${timeouts.userPromptSubmit}`,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: '(Read|Write|Edit|Bash|Task|Glob|Grep)',
          hooks: [
            {
              type: 'command',
              command: `npx @claude-flow/cache-optimizer hook pre-tool-use --tool "$TOOL_NAME" --timeout ${timeouts.preToolUse}`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: '(Read|Write|Edit|Bash|Task|Glob|Grep)',
          hooks: [
            {
              type: 'command',
              command: `npx @claude-flow/cache-optimizer hook post-tool-use --tool "$TOOL_NAME" --timeout ${timeouts.postToolUse}`,
            },
          ],
        },
      ],
      PreCompact: [
        {
          matcher: '.*',
          hooks: [
            {
              type: 'command',
              command: `npx @claude-flow/cache-optimizer hook pre-compact --timeout ${timeouts.preCompact}`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Singleton optimizer instance for hook handlers
 */
let globalOptimizer: CacheOptimizer | null = null;

export function getGlobalOptimizer(config?: Partial<CacheOptimizerConfig>): CacheOptimizer {
  if (!globalOptimizer) {
    globalOptimizer = new CacheOptimizer(config);
  }
  return globalOptimizer;
}

export function resetGlobalOptimizer(): void {
  globalOptimizer = null;
}

// =============================================================================
// HANDOFF HOOK HANDLERS
// =============================================================================

import { HandoffManager, type HandoffResponse } from '../handoff/index.js';
import type { HandoffConfig } from '../types.js';

/**
 * Singleton handoff manager instance
 */
let globalHandoffManager: HandoffManager | null = null;

export function getGlobalHandoffManager(config?: Partial<HandoffConfig>): HandoffManager {
  if (!globalHandoffManager) {
    globalHandoffManager = new HandoffManager(config);
  }
  return globalHandoffManager;
}

export function resetGlobalHandoffManager(): void {
  if (globalHandoffManager) {
    globalHandoffManager.shutdown();
    globalHandoffManager = null;
  }
}

/**
 * Hook handler for initiating a model handoff
 *
 * Requests another model (local Ollama or remote API) and returns the response.
 * Supports background processing for non-blocking operations.
 */
export async function handleHandoffRequest(
  prompt: string,
  options: {
    systemPrompt?: string;
    provider?: string;
    sessionId?: string;
    callbackInstructions?: string;
    background?: boolean;
    temperature?: number;
    maxTokens?: number;
  } = {}
): Promise<HookResult & { handoffResponse?: HandoffResponse; handoffId?: string }> {
  const startTime = Date.now();
  const actions: HookAction[] = [];

  const manager = getGlobalHandoffManager();

  const request = manager.createRequest({
    prompt,
    systemPrompt: options.systemPrompt,
    provider: options.provider,
    sessionId: options.sessionId,
    callbackInstructions: options.callbackInstructions,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    background: options.background,
  });

  if (options.background) {
    // Background mode: start and return immediately
    const handoffId = await manager.sendBackground(request);

    actions.push({
      type: 'score_update',
      details: `Started background handoff to ${options.provider || 'auto'} (ID: ${handoffId})`,
    });

    return {
      success: true,
      actions,
      durationMs: Date.now() - startTime,
      compactionPrevented: false,
      tokensFreed: 0,
      newUtilization: 0,
      handoffId,
    };
  }

  // Synchronous mode: wait for response
  const response = await manager.send(request);

  actions.push({
    type: 'score_update',
    details: `Completed handoff to ${response.provider} (${response.durationMs}ms, ${response.tokens.total} tokens)`,
  });

  return {
    success: response.status === 'completed',
    actions,
    durationMs: Date.now() - startTime,
    compactionPrevented: false,
    tokensFreed: 0,
    newUtilization: 0,
    handoffResponse: response,
    error: response.error,
  };
}

/**
 * Hook handler for polling a background handoff
 */
export async function handleHandoffPoll(
  handoffId: string,
  timeout: number = 30000
): Promise<HookResult & { handoffResponse?: HandoffResponse }> {
  const startTime = Date.now();

  const manager = getGlobalHandoffManager();
  const response = await manager.getResponse(handoffId, timeout);

  if (!response) {
    return {
      success: false,
      actions: [{
        type: 'score_update',
        details: `Handoff ${handoffId} not found or timed out`,
      }],
      durationMs: Date.now() - startTime,
      compactionPrevented: false,
      tokensFreed: 0,
      newUtilization: 0,
      error: 'Handoff not found or timed out',
    };
  }

  return {
    success: response.status === 'completed',
    actions: [{
      type: 'score_update',
      details: `Retrieved handoff response (${response.status})`,
    }],
    durationMs: Date.now() - startTime,
    compactionPrevented: false,
    tokensFreed: 0,
    newUtilization: 0,
    handoffResponse: response,
    error: response.error,
  };
}

/**
 * Hook handler for cancelling a background handoff
 */
export async function handleHandoffCancel(
  handoffId: string
): Promise<HookResult> {
  const startTime = Date.now();

  const manager = getGlobalHandoffManager();
  const cancelled = manager.cancel(handoffId);

  return {
    success: cancelled,
    actions: [{
      type: 'score_update',
      details: cancelled
        ? `Cancelled handoff ${handoffId}`
        : `Failed to cancel handoff ${handoffId}`,
    }],
    durationMs: Date.now() - startTime,
    compactionPrevented: false,
    tokensFreed: 0,
    newUtilization: 0,
    error: cancelled ? undefined : 'Handoff not found or already completed',
  };
}

/**
 * Hook handler for getting handoff metrics
 */
export function getHandoffMetrics(): {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  totalTokens: number;
  byProvider: Record<string, number>;
  queueLength: number;
  activeRequests: number;
} {
  const manager = getGlobalHandoffManager();
  return manager.getMetrics();
}

/**
 * Hook handler for health checking all providers
 */
export async function handleHandoffHealthCheck(): Promise<Record<string, boolean>> {
  const manager = getGlobalHandoffManager();
  return manager.healthCheckAll();
}

/**
 * Chain handoffs together for multi-step workflows
 *
 * Example:
 * ```typescript
 * const chain = createHandoffWorkflow();
 * const result = await chain
 *   .step('Analyze this code', { systemPrompt: 'You are a code analyst' })
 *   .step('Suggest improvements', { context: 'previous' })
 *   .step('Generate tests', { context: 'previous' })
 *   .execute();
 * ```
 */
export function createHandoffWorkflow() {
  const steps: Array<{
    prompt: string;
    options: {
      systemPrompt?: string;
      provider?: string;
      context?: 'previous' | 'all' | undefined;
    };
  }> = [];

  return {
    step(prompt: string, options: {
      systemPrompt?: string;
      provider?: string;
      context?: 'previous' | 'all';
    } = {}) {
      steps.push({ prompt, options });
      return this;
    },

    async execute(): Promise<{
      responses: HandoffResponse[];
      totalDuration: number;
      totalTokens: number;
    }> {
      const startTime = Date.now();
      const responses: HandoffResponse[] = [];
      const manager = getGlobalHandoffManager();

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        let contextMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

        // Build context from previous responses
        if (step.options.context === 'previous' && responses.length > 0) {
          const prev = responses[responses.length - 1];
          contextMessages = [
            { role: 'user', content: steps[i - 1].prompt },
            { role: 'assistant', content: prev.content },
          ];
        } else if (step.options.context === 'all') {
          for (let j = 0; j < responses.length; j++) {
            contextMessages.push(
              { role: 'user', content: steps[j].prompt },
              { role: 'assistant', content: responses[j].content }
            );
          }
        }

        const request = manager.createRequest({
          prompt: step.prompt,
          systemPrompt: step.options.systemPrompt,
          provider: step.options.provider,
          context: contextMessages,
        });

        const response = await manager.send(request);
        responses.push(response);

        // Stop chain on failure
        if (response.status !== 'completed') {
          break;
        }
      }

      const totalTokens = responses.reduce((sum, r) => sum + r.tokens.total, 0);

      return {
        responses,
        totalDuration: Date.now() - startTime,
        totalTokens,
      };
    },
  };
}
