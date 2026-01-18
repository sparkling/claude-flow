/**
 * @claude-flow/cache-optimizer - Intelligence Module
 *
 * Complete intelligence layer with:
 * - Flash Attention: 2.49x-7.47x speedup for relevance scoring
 * - GNN: Graph Neural Networks for relationship learning
 * - GRNN: Fast Gated RNN for temporal patterns
 * - Learning: Measurement, refinement, and reporting
 * - Hyperbolic Cache: Poincaré ball embeddings
 */

// Attention-based relevance scoring
export * from './attention/flash-attention.js';

// Graph Neural Networks for relationship learning
export * from './gnn/index.js';

// Fast GRNN for temporal pattern learning
export * from './grnn/index.js';

// Self-learning: measurement, refinement, reporting
export * from './learning/index.js';

// Hyperbolic embeddings for hierarchical cache data
export * from './hyperbolic-cache.js';
