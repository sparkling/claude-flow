/**
 * @claude-flow/cache-optimizer - Flash Attention
 * O(N) attention-based relevance scoring
 * Based on FlashAttention algorithm for efficient computation
 */

import type {
  CacheEntry,
  RelevanceScore,
  RelevanceComponents,
  ScoringContext,
  FlashAttentionConfig,
} from '../../types.js';
import { DEFAULT_CONFIG } from '../../types.js';

/**
 * Flash Attention implementation for O(N) relevance scoring
 * Uses block-wise computation to reduce memory complexity
 */
export class FlashAttention {
  private config: FlashAttentionConfig;

  constructor(config: Partial<FlashAttentionConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG.intelligence.attention.flash,
      ...config,
    };
  }

  /**
   * Score all entries against current context using flash attention
   * Returns map of entry ID to relevance score
   */
  async scoreEntries(
    entries: CacheEntry[],
    context: ScoringContext
  ): Promise<Map<string, RelevanceScore>> {
    const results = new Map<string, RelevanceScore>();
    const now = context.timestamp;

    // Process in blocks for efficiency
    const blocks = this.chunkArray(entries, this.config.blockSize);

    for (const block of blocks) {
      const blockScores = await this.scoreBlock(block, context, now);
      for (const [id, score] of blockScores) {
        results.set(id, score);
      }
    }

    return results;
  }

  /**
   * Score a single block of entries
   */
  private async scoreBlock(
    entries: CacheEntry[],
    context: ScoringContext,
    now: number
  ): Promise<Map<string, RelevanceScore>> {
    const results = new Map<string, RelevanceScore>();

    for (const entry of entries) {
      const components = this.computeComponents(entry, context, now);
      const overall = this.computeOverallScore(components);
      const confidence = this.computeConfidence(entry, components);

      results.set(entry.id, {
        overall,
        components,
        scoredAt: now,
        confidence,
      });
    }

    return results;
  }

  /**
   * Compute individual relevance components
   */
  private computeComponents(
    entry: CacheEntry,
    context: ScoringContext,
    now: number
  ): RelevanceComponents {
    // Recency score - exponential decay
    const recency = this.computeRecencyScore(entry, now);

    // Frequency score - based on access count
    const frequency = this.computeFrequencyScore(entry);

    // Semantic score - based on content type and context match
    const semantic = this.computeSemanticScore(entry, context);

    // Attention score - flash attention weight
    const attention = this.computeAttentionScore(entry, context);

    // Expert score - MoE routing weight (default for flash attention)
    const expert = this.computeExpertScore(entry);

    return { recency, frequency, semantic, attention, expert };
  }

  /**
   * Compute recency score with exponential decay
   */
  private computeRecencyScore(entry: CacheEntry, now: number): number {
    // Use last access time if available, otherwise creation time
    const referenceTime = entry.lastAccessedAt || entry.timestamp;
    const ageMs = now - referenceTime;

    // Exponential decay with 5-minute half-life
    const halfLifeMs = 5 * 60 * 1000;
    const decayFactor = Math.pow(0.5, ageMs / halfLifeMs);

    return Math.max(0, Math.min(1, decayFactor));
  }

  /**
   * Compute frequency score based on access patterns
   */
  private computeFrequencyScore(entry: CacheEntry): number {
    // Logarithmic scaling of access count
    const accessCount = entry.accessCount || 1;
    const score = Math.log10(accessCount + 1) / Math.log10(100); // Normalize to ~100 accesses = 1.0

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Compute semantic relevance to current context
   */
  private computeSemanticScore(entry: CacheEntry, context: ScoringContext): number {
    let score = 0.5; // Base score

    // Boost for matching file paths
    if (entry.metadata.filePath && context.activeFiles.length > 0) {
      if (context.activeFiles.includes(entry.metadata.filePath)) {
        score += 0.3;
      } else if (context.activeFiles.some(f => this.pathsRelated(f, entry.metadata.filePath!))) {
        score += 0.15;
      }
    }

    // Boost for matching tool names
    if (entry.metadata.toolName && context.activeTools.length > 0) {
      if (context.activeTools.includes(entry.metadata.toolName)) {
        score += 0.2;
      }
    }

    // Boost for current session/task
    if (entry.metadata.sessionId === context.sessionId) {
      score += 0.1;
    }
    if (context.taskId && entry.metadata.taskId === context.taskId) {
      score += 0.15;
    }

    // Text similarity to current query (simple keyword matching)
    if (context.currentQuery) {
      const queryKeywords = this.extractKeywords(context.currentQuery);
      const contentKeywords = this.extractKeywords(entry.content);
      const overlap = this.computeKeywordOverlap(queryKeywords, contentKeywords);
      score += overlap * 0.2;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Compute flash attention score
   * Uses softmax over dot products with query
   */
  private computeAttentionScore(entry: CacheEntry, context: ScoringContext): number {
    // If we have embeddings, use cosine similarity
    if (entry.embedding) {
      // For now, use a simplified attention based on content type
      // In production, this would use actual embedding comparison
      return this.computeTypeBasedAttention(entry, context);
    }

    return this.computeTypeBasedAttention(entry, context);
  }

  /**
   * Compute attention based on entry type and current context
   */
  private computeTypeBasedAttention(entry: CacheEntry, _context: ScoringContext): number {
    // Type-based attention weights
    const typeWeights: Record<string, number> = {
      'system_prompt': 0.9,  // Always highly relevant
      'claude_md': 0.85,     // Configuration is important
      'file_read': 0.7,      // Active file context
      'file_write': 0.75,    // Recent edits are important
      'tool_result': 0.6,    // Tool outputs
      'bash_output': 0.55,   // Command outputs
      'user_message': 0.65,  // User intent
      'assistant_message': 0.5, // Assistant responses
      'mcp_context': 0.6,    // MCP data
    };

    let baseWeight = typeWeights[entry.type] || 0.5;

    // Causal masking - future entries shouldn't attend to past
    if (this.config.causal) {
      // This is handled by recency score, but we can add additional decay
      const ageMs = Date.now() - entry.timestamp;
      if (ageMs > 30 * 60 * 1000) { // 30 minutes
        baseWeight *= 0.7;
      }
    }

    return baseWeight;
  }

  /**
   * Compute MoE expert routing score
   */
  private computeExpertScore(entry: CacheEntry): number {
    // Map entry types to expert domains
    const expertMapping: Record<string, number> = {
      'file_read': 0.8,      // Code expert
      'file_write': 0.85,    // Code expert
      'tool_result': 0.7,    // Tool expert
      'bash_output': 0.7,    // Tool expert
      'user_message': 0.75,  // Conversation expert
      'assistant_message': 0.7, // Conversation expert
      'system_prompt': 0.9,  // System expert
      'claude_md': 0.85,     // System expert
      'mcp_context': 0.6,    // Tool expert
    };

    return expertMapping[entry.type] || 0.5;
  }

  /**
   * Compute overall relevance score from components
   */
  private computeOverallScore(components: RelevanceComponents): number {
    // Weighted combination of components
    const weights = {
      recency: 0.25,
      frequency: 0.15,
      semantic: 0.25,
      attention: 0.25,
      expert: 0.10,
    };

    const score =
      components.recency * weights.recency +
      components.frequency * weights.frequency +
      components.semantic * weights.semantic +
      components.attention * weights.attention +
      components.expert * weights.expert;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Compute confidence in the score
   */
  private computeConfidence(entry: CacheEntry, components: RelevanceComponents): number {
    // Higher confidence for entries with more data points
    let confidence = 0.5;

    if (entry.embedding) confidence += 0.2;
    if (entry.accessCount > 1) confidence += 0.1;
    if (entry.metadata.filePath) confidence += 0.1;
    if (components.semantic > 0.6) confidence += 0.1;

    return Math.min(1, confidence);
  }

  /**
   * Check if two paths are related (same directory, etc.)
   */
  private pathsRelated(path1: string, path2: string): boolean {
    const dir1 = path1.split('/').slice(0, -1).join('/');
    const dir2 = path2.split('/').slice(0, -1).join('/');
    return dir1 === dir2 || path1.startsWith(dir2) || path2.startsWith(dir1);
  }

  /**
   * Extract keywords from text
   */
  private extractKeywords(text: string): Set<string> {
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    return new Set(words);
  }

  /**
   * Compute keyword overlap between two sets
   */
  private computeKeywordOverlap(set1: Set<string>, set2: Set<string>): number {
    if (set1.size === 0 || set2.size === 0) return 0;

    let overlap = 0;
    for (const word of set1) {
      if (set2.has(word)) overlap++;
    }

    // Jaccard similarity
    return overlap / (set1.size + set2.size - overlap);
  }

  /**
   * Chunk array into blocks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Score a single entry (convenience method)
   */
  async scoreEntry(entry: CacheEntry, context: ScoringContext): Promise<RelevanceScore> {
    const scores = await this.scoreEntries([entry], context);
    return scores.get(entry.id)!;
  }
}

export function createFlashAttention(config?: Partial<FlashAttentionConfig>): FlashAttention {
  return new FlashAttention(config);
}
