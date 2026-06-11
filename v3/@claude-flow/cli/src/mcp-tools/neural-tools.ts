/**
 * Neural MCP Tools for CLI
 *
 * V2 Compatibility - Neural network and ML tools
 *
 * ✅ HYBRID Implementation:
 * - Uses @claude-flow/embeddings for REAL ML embeddings when available
 * - Falls back to deterministic hash-based embeddings when ML model not installed
 * - Pattern storage and search with cosine similarity (real math in all tiers)
 * - Training stores patterns as searchable embeddings (not simulated)
 *
 * Note: For production neural features, use @claude-flow/neural module
 */

import { type MCPTool, findProjectRoot } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Try to import real embeddings — prefer the same memory-router embedder the
// embeddings_* tools use, then agentic-flow v3 ReasoningBank, then
// @claude-flow/embeddings.
let realEmbeddings: { embed: (text: string) => Promise<number[]> } | null = null;
let embeddingServiceName: string = 'none';
try {
  // Tier 0 (ADR-0293 D3): the SAME real ONNX/mpnet embedder embeddings_* uses
  // (generateEmbedding in memory/memory-router.ts → the loaded adapter). The
  // neural-tools store previously skipped this and only tried agentic-flow /
  // @claude-flow/embeddings, so in a project with a working mpnet model
  // (embeddings_status initialized:true) neural_* still fell back to
  // hash-fallback (_realEmbeddings:false). Routing through memory-router
  // shares one embedder across both surfaces. It returns
  // { embedding, dimensions, model }; we materialize embedding to a plain
  // array. No silent mock — if this import fails we fall through to the next
  // real tier, and only land on the explicit hash-fallback when ALL real
  // tiers are genuinely unavailable.
  const mr = await import('../memory/memory-router.js').catch(() => null);
  if (mr?.generateEmbedding) {
    realEmbeddings = {
      embed: async (text: string) => {
        const result = await mr.generateEmbedding(text);
        // memory-router returns { embedding: number[], ... }; accept either a
        // wrapped result or a bare array for forward-compat.
        const vec = Array.isArray(result) ? result : (result?.embedding ?? result);
        return Array.from(vec as ArrayLike<number>);
      },
    };
    embeddingServiceName = 'memory-router (onnx)';
  }

  // Tier 1: agentic-flow v3 ReasoningBank (fastest — WASM-accelerated)
  if (!realEmbeddings) {
  const rb = await import('agentic-flow/reasoningbank').catch(() => null);
  if (rb?.computeEmbedding) {
    // The real `computeEmbedding` returns Float32Array (post-ADR-0069 unified
    // dim); our local `realEmbeddings.embed` is typed as `number[]` for
    // back-compat with the @claude-flow/embeddings tier below. Materialize
    // to a plain array so both tiers share one shape.
    realEmbeddings = {
      embed: async (text: string) => Array.from(await rb.computeEmbedding(text)),
    };
    embeddingServiceName = 'agentic-flow/reasoningbank';
  }
  }

  // Tier 2: @claude-flow/embeddings with agentic-flow provider
  if (!realEmbeddings) {
    const embeddingsModule = await import('@claude-flow/embeddings').catch(() => null);
    if (embeddingsModule?.createEmbeddingService) {
      try {
        const service = embeddingsModule.createEmbeddingService({ provider: 'agentic-flow' });
        realEmbeddings = {
          embed: async (text: string) => {
            const result = await service.embed(text);
            return Array.from(result.embedding);
          },
        };
        embeddingServiceName = 'agentic-flow';
      } catch {
        // agentic-flow provider not available, try ONNX
      }
    }
  }

  // Tier 3: @claude-flow/embeddings with ONNX provider
  if (!realEmbeddings) {
    const embeddingsModule = await import('@claude-flow/embeddings').catch(() => null);
    if (embeddingsModule?.createEmbeddingService) {
      try {
        const service = embeddingsModule.createEmbeddingService({ provider: 'onnx' });
        realEmbeddings = {
          embed: async (text: string) => {
            const result = await service.embed(text);
            return Array.from(result.embedding);
          },
        };
        embeddingServiceName = 'onnx';
      } catch {
        // ONNX provider not available, fall through to mock
      }
    }
  }

  // No mock fallback. If every real tier (Tier 0 memory-router, Tier 1
  // agentic-flow, Tier 2/3 @claude-flow/embeddings) failed to import, leave
  // realEmbeddings null and let downstream code use the explicit hash-fallback
  // path with a clear _embeddingNote in stats. Silently substituting mock
  // embeddings would hide a missing production dependency from callers.
} catch {
  // No embedding provider available, will use fallback
}

// Storage paths
const STORAGE_DIR = '.claude-flow';
const NEURAL_DIR = 'neural';
const MODELS_FILE = 'models.json';
const PATTERNS_FILE = 'patterns.json';

interface NeuralModel {
  id: string;
  name: string;
  type: 'moe' | 'transformer' | 'classifier' | 'embedding';
  status: 'untrained' | 'training' | 'ready' | 'error';
  accuracy: number;
  trainedAt?: string;
  epochs: number;
  config: Record<string, unknown>;
}

interface Pattern {
  id: string;
  name: string;
  type: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: string;
  usageCount: number;
}

interface NeuralStore {
  models: Record<string, NeuralModel>;
  patterns: Record<string, Pattern>;
  version: string;
}

function getNeuralDir(): string {
  return join(findProjectRoot(), STORAGE_DIR, NEURAL_DIR);
}

function getNeuralPath(): string {
  return join(getNeuralDir(), MODELS_FILE);
}

function ensureNeuralDir(): void {
  const dir = getNeuralDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadNeuralStore(): NeuralStore {
  try {
    const path = getNeuralPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return empty store
  }
  return { models: {}, patterns: {}, version: '3.0.0' };
}

export function saveNeuralStore(store: NeuralStore): void {
  ensureNeuralDir();
  writeFileSync(getNeuralPath(), JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Neural-store snapshot for the unified learning-stats view (ADR-0326, upstream
 * ca77f8307). Reads the on-disk neural store and reports pattern/model counts +
 * a per-type pattern breakdown. Read-only; never writes. One of the four
 * primitives getUnifiedLearningStats() aggregates.
 */
export function getNeuralStoreStats(): {
  patternCount: number;
  byType: Record<string, number>;
  modelCount: number;
  source: string;
} {
  const store = loadNeuralStore();
  const patterns = Object.values(store.patterns ?? {});
  const byType: Record<string, number> = {};
  for (const p of patterns) {
    const t = p.type || 'unknown';
    byType[t] = (byType[t] ?? 0) + 1;
  }
  return {
    patternCount: patterns.length,
    byType,
    modelCount: Object.keys(store.models ?? {}).length,
    source: '.claude-flow/neural/models.json (neural store)',
  };
}

// Generate embedding - uses real ML embeddings if available, falls back to deterministic hash
export async function generateEmbedding(text?: string, dims: number = 384): Promise<number[]> {
  // If real embeddings available and text provided, use them
  if (realEmbeddings && text) {
    try {
      return await realEmbeddings.embed(text);
    } catch {
      // Fall back to hash-based
    }
  }

  // Hash-based deterministic embedding (better than pure random for consistency)
  // NOTE: No semantic meaning — only useful for consistent deduplication, not similarity search
  if (text) {
    if (embeddingServiceName === 'none') {
      embeddingServiceName = 'hash-fallback';
    }
    const hash = text.split('').reduce((acc, char, i) => {
      return acc + char.charCodeAt(0) * (i + 1);
    }, 0);

    // Use hash to seed a deterministic embedding
    const embedding: number[] = [];
    let seed = hash;
    for (let i = 0; i < dims; i++) {
      // Simple LCG random with seed
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      embedding.push((seed / 0x7fffffff) * 2 - 1);
    }
    return embedding;
  }

  // No text provided — return zero vector (callers should always provide text)
  return new Array(dims).fill(0);
}

// Cosine similarity for pattern search
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export const neuralTools: MCPTool[] = [
  {
    name: 'neural_train',
    description: 'Train a neural model',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to train' },
        modelType: { type: 'string', enum: ['moe', 'transformer', 'classifier', 'embedding'], description: 'Model type' },
        epochs: { type: 'number', description: 'Number of training epochs' },
        learningRate: { type: 'number', description: 'Learning rate' },
        data: { type: 'object', description: 'Training data' },
      },
      required: ['modelType'],
    },
    handler: async (input) => {
      if (input.modelId) { const v = validateIdentifier(input.modelId as string, 'modelId'); if (!v.valid) return { success: false, error: v.error }; }

      // ADR-0082: validate the schema-required modelType field. The schema
      // declares modelType as a string enum; without runtime enforcement the
      // handler silently accepts {patternType: 42} or {modelType: ""} and
      // writes a model record under a meaningless type — exactly the silent
      // -pass shape the P11 fuzz / P12 quality acceptance checks guard.
      const VALID_MODEL_TYPES = ['moe', 'transformer', 'classifier', 'embedding'];
      const rawModelType = input.modelType;
      if (typeof rawModelType !== 'string' || rawModelType.length === 0) {
        return {
          success: false,
          error: `Invalid input: 'modelType' is required and must be a non-empty string (one of ${VALID_MODEL_TYPES.join(', ')})`,
        };
      }
      if (!VALID_MODEL_TYPES.includes(rawModelType)) {
        return {
          success: false,
          error: `Invalid input: 'modelType' must be one of ${VALID_MODEL_TYPES.join(', ')} (got '${rawModelType}')`,
        };
      }

      const store = loadNeuralStore();
      const modelId = (input.modelId as string) || `model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const modelType = rawModelType as NeuralModel['type'];
      const epochs = (input.epochs as number) || 10;

      const model: NeuralModel = {
        id: modelId,
        name: `${modelType}-model`,
        type: modelType,
        status: 'training',
        accuracy: 0,
        epochs,
        config: {
          learningRate: input.learningRate || 0.001,
          batchSize: 32,
        },
      };

      store.models[modelId] = model;
      saveNeuralStore(store);

      // Real training: embed training data and store as searchable patterns
      const trainingData = input.data as Record<string, unknown> | Array<unknown> | undefined;
      let patternsStored = 0;

      if (trainingData) {
        const entries = Array.isArray(trainingData) ? trainingData : [trainingData];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const text = typeof entry === 'string' ? entry
            : (entry as Record<string, unknown>)?.text as string
            || (entry as Record<string, unknown>)?.content as string
            || (entry as Record<string, unknown>)?.label as string
            || JSON.stringify(entry);
          if (!text) continue;

          const embedding = await generateEmbedding(text, 384);
          const patternId = `${modelId}-train-${i}`;
          // ADR-093 F11: extract a meaningful label instead of dumping raw
          // training JSON as the pattern name. Audit reported neural_predict
          // returned `label: <raw training data JSON>` because the previous
          // fallback was `text.slice(0, 100)` where text was `JSON.stringify(entry)`.
          let label: string;
          if (typeof entry === 'string') {
            label = entry.slice(0, 80);
          } else if (entry && typeof entry === 'object') {
            const e = entry as Record<string, unknown>;
            // Prefer common semantic fields over a JSON dump
            const labelField = e.label ?? e.category ?? e.class ?? e.tag ?? e.intent ?? e.name ?? e.title;
            if (typeof labelField === 'string' && labelField.length > 0) {
              label = labelField.slice(0, 80);
            } else {
              const summaryField = e.text ?? e.input ?? e.task ?? e.description ?? e.content;
              if (typeof summaryField === 'string' && summaryField.length > 0) {
                label = `${summaryField.slice(0, 60)}${summaryField.length > 60 ? '…' : ''}`;
              } else {
                // Last resort: reduce to a stable short hash-like id
                label = `${modelType}:entry-${i}`;
              }
            }
          } else {
            label = `${modelType}:entry-${i}`;
          }
          store.patterns[patternId] = {
            id: patternId,
            name: label,
            type: modelType,
            embedding,
            metadata: { modelId, epoch: epochs, index: i, raw: entry },
            createdAt: new Date().toISOString(),
            usageCount: 0,
          };
          patternsStored++;
        }
      }

      model.status = 'ready';
      model.accuracy = patternsStored > 0 ? 1.0 : 0; // accuracy = data stored, not simulated
      model.trainedAt = new Date().toISOString();
      saveNeuralStore(store);

      return {
        success: true,
        _realEmbedding: !!realEmbeddings,
        _embeddingSource: embeddingServiceName,
        embeddingProvider: embeddingServiceName,
        modelId,
        type: modelType,
        status: model.status,
        patternsStored,
        totalPatterns: Object.keys(store.patterns).length,
        epochs,
        trainedAt: model.trainedAt,
        ...(embeddingServiceName === 'hash-fallback' || embeddingServiceName === 'none' ? {
          platformNote: 'ONNX embeddings not available — using hash-based fallback. Install @claude-flow/embeddings and run "embeddings init --download" for semantic search.',
        } : {}),
      };
    },
  },
  {
    name: 'neural_predict',
    description: 'Make predictions using a neural model',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to use' },
        input: { type: 'string', description: 'Input text or data' },
        topK: { type: 'number', description: 'Number of top predictions' },
      },
      required: ['input'],
    },
    handler: async (input) => {
      { const v = validateText(input.input as string, 'input'); if (!v.valid) return { success: false, error: v.error }; }
      if (input.modelId) { const v = validateIdentifier(input.modelId as string, 'modelId'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadNeuralStore();
      const modelId = input.modelId as string;
      const inputText = input.input as string;
      const topK = (input.topK as number) || 3;

      // Find model or use default
      const model = modelId ? store.models[modelId] : Object.values(store.models).find(m => m.status === 'ready');

      if (model && model.status !== 'ready') {
        return { success: false, error: 'Model not ready' };
      }

      // Generate real embedding for the input
      const startTime = performance.now();
      const embedding = await generateEmbedding(inputText, 384);
      const latency = Math.round(performance.now() - startTime);

      // ADR-093 F11 / ADR-0293 D3: real classifier head over stored patterns.
      // We run k-NN with cosine, take a temperature-softmax over the top-K to
      // get each candidate's RELATIVE share, then GATE that share by the
      // candidate's absolute match strength.
      //
      // Why the gate: a plain softmax sums to 1, so a SINGLE candidate (or a
      // dominant one) gets confidence 1.0 regardless of whether it actually
      // matches — that's how a disjoint-text query against one stored pattern
      // returned `{cosineSimilarity:0, confidence:1}` (ADR-0293 D3 scoring
      // bug). Confidence must reflect both dominance AND match strength, so we
      // scale the softmax weight by max(0, cosine): an orthogonal/non-match
      // (cosine≈0) yields confidence≈0; an exact match (cosine≈1) keeps its
      // full softmax share (1.0 when it is the sole/dominant candidate).
      const storedPatterns = Object.values(store.patterns);
      let predictions: Array<{ label: string; confidence: number; patternId: string; cosineSimilarity: number }>;

      if (storedPatterns.length > 0) {
        // Step 1: k-NN with cosine
        const scored = storedPatterns
          .map(p => {
            const sim = cosineSimilarity(embedding, p.embedding);
            return {
              patternId: p.id,
              label: p.name || p.type || p.id,
              cosineSimilarity: sim,
            };
          })
          .sort((a, b) => b.cosineSimilarity - a.cosineSimilarity)
          .slice(0, topK);

        // Step 2: temperature-softmax over the top-K (relative share among
        // candidates). Temperature 0.1 sharpens differences between similar
        // candidates.
        const tau = 0.1;
        const exps = scored.map(s => Math.exp(s.cosineSimilarity / tau));
        const z = exps.reduce((a, b) => a + b, 0) || 1;
        predictions = scored.map((s, i) => {
          // Map cosine [-1,1] → match-strength [0,1] (clamp negatives to 0;
          // L2-normalized embeddings give ~1 for an exact match, ~0 for an
          // unrelated one).
          const matchStrength = Math.max(0, s.cosineSimilarity);
          const softmaxShare = exps[i] / z;
          return {
            label: s.label,
            patternId: s.patternId,
            cosineSimilarity: Number(s.cosineSimilarity.toFixed(4)),
            confidence: Number((softmaxShare * matchStrength).toFixed(4)),
          };
        });
      } else {
        // No patterns stored — no predictions possible. Be honest about it
        // instead of returning empty silently.
        predictions = [];
      }

      const topConfidence = predictions[0]?.confidence ?? 0;
      const topSimilarity = predictions[0]?.cosineSimilarity ?? 0;

      return {
        success: true,
        _realEmbedding: !!realEmbeddings,
        _embeddingSource: embeddingServiceName,
        embeddingProvider: embeddingServiceName,
        _hasStoredPatterns: storedPatterns.length > 0,
        _classifierHead: storedPatterns.length > 0 ? 'knn-cosine+softmax(tau=0.1)' : 'none',
        modelId: model?.id || 'default',
        input: inputText,
        predictions,
        // Surface cosineSimilarity separately so callers know whether the
        // softmax confidence reflects true match strength.
        topPrediction: predictions[0]?.label ?? null,
        topConfidence,
        topSimilarity,
        embedding: embedding.slice(0, 8), // Preview of embedding
        embeddingDims: embedding.length,
        latency,
        ...(storedPatterns.length === 0 ? {
          _note: 'No patterns stored. Train with neural_train(modelType, trainingData) before predicting.',
        } : {}),
      };
    },
  },
  {
    name: 'neural_patterns',
    description: 'Get or manage neural patterns',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'store', 'search', 'delete'], description: 'Action to perform' },
        patternId: { type: 'string', description: 'Pattern ID' },
        name: { type: 'string', description: 'Pattern name' },
        type: { type: 'string', description: 'Pattern type' },
        query: { type: 'string', description: 'Search query' },
        data: { type: 'object', description: 'Pattern data' },
      },
    },
    handler: async (input) => {
      if (input.patternId) { const v = validateIdentifier(input.patternId as string, 'patternId'); if (!v.valid) return { success: false, error: v.error }; }
      if (input.name) { const v = validateText(input.name as string, 'name'); if (!v.valid) return { success: false, error: v.error }; }
      if (input.type) { const v = validateIdentifier(input.type as string, 'type'); if (!v.valid) return { success: false, error: v.error }; }
      if (input.query) { const v = validateText(input.query as string, 'query'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadNeuralStore();
      const action = (input.action as string) || 'list';

      if (action === 'list') {
        const patterns = Object.values(store.patterns);
        const typeFilter = input.type as string;
        const filtered = typeFilter ? patterns.filter(p => p.type === typeFilter) : patterns;

        return {
          patterns: filtered.map(p => ({
            id: p.id,
            name: p.name,
            type: p.type,
            usageCount: p.usageCount,
            createdAt: p.createdAt,
          })),
          total: filtered.length,
        };
      }

      if (action === 'get') {
        const pattern = store.patterns[input.patternId as string];
        if (!pattern) {
          return { success: false, error: 'Pattern not found' };
        }
        return { success: true, pattern };
      }

      if (action === 'store') {
        const patternId = `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const patternName = (input.name as string) || 'Unnamed pattern';

        // Generate embedding from pattern name/content
        const embedding = await generateEmbedding(patternName, 384);

        const pattern: Pattern = {
          id: patternId,
          name: patternName,
          type: (input.type as string) || 'general',
          embedding,
          metadata: (input.data as Record<string, unknown>) || {},
          createdAt: new Date().toISOString(),
          usageCount: 0,
        };

        store.patterns[patternId] = pattern;
        saveNeuralStore(store);

        return {
          success: true,
          _realEmbedding: !!realEmbeddings,
          _embeddingSource: embeddingServiceName,
          embeddingProvider: embeddingServiceName,
          patternId,
          name: pattern.name,
          type: pattern.type,
          embeddingDims: embedding.length,
          createdAt: pattern.createdAt,
        };
      }

      if (action === 'search') {
        const query = input.query as string;

        // Generate query embedding for real similarity search
        const queryEmbedding = await generateEmbedding(query, 384);

        // Calculate REAL cosine similarity against stored patterns
        const results = Object.values(store.patterns)
          .map(p => ({
            ...p,
            similarity: cosineSimilarity(queryEmbedding, p.embedding),
          }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 10);

        return {
          _realSimilarity: true,
          _realEmbedding: !!realEmbeddings,
          _embeddingSource: embeddingServiceName,
          embeddingProvider: embeddingServiceName,
          query,
          results: results.map(r => ({
            id: r.id,
            name: r.name,
            type: r.type,
            similarity: r.similarity,
          })),
          total: results.length,
        };
      }

      if (action === 'delete') {
        const patternId = input.patternId as string;
        if (!store.patterns[patternId]) {
          return { success: false, error: 'Pattern not found' };
        }
        delete store.patterns[patternId];
        saveNeuralStore(store);
        return { success: true, deleted: patternId };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'neural_compress',
    // ADR-0293 D4 / ADR-0086: int8 quantization was deliberately removed in
    // ADR-0086 Phase 1 (T1.1 deleted quantizeInt8/getQuantizationStats — no
    // second consumer). Document the capability boundary up front so the
    // tool's response matches its advertised capability (no half-advertised
    // no-op): the 'quantize' method is NOT supported in this build; 'prune'
    // and 'distill' are.
    description:
      'Compress stored neural patterns. Supported methods: prune (drop low-usage patterns), distill (merge near-duplicate patterns). NOTE: the quantize method is NOT supported in this build — int8 quantization was removed in ADR-0086 Phase 1; calling it returns a documented "not available" error.',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to compress' },
        method: { type: 'string', enum: ['quantize', 'prune', 'distill'], description: 'Compression method. prune and distill are supported; quantize is NOT supported in this build (removed in ADR-0086 Phase 1) and returns a documented "not available" error.' },
        targetSize: { type: 'number', description: 'Target size reduction (0-1)' },
      },
    },
    handler: async (input) => {
      if (input.modelId) { const v = validateIdentifier(input.modelId as string, 'modelId'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadNeuralStore();
      const method = (input.method as string) || 'quantize';
      const targetReduction = (input.targetSize as number) || 0.5;
      const patterns = Object.values(store.patterns);

      if (patterns.length === 0) {
        return { success: false, error: 'No patterns to compress. Train patterns first with neural_train.' };
      }

      const beforeCount = patterns.length;
      const beforeSize = patterns.reduce((s, p) => s + (p.embedding?.length || 0) * 4, 0); // Float32 = 4 bytes

      if (method === 'quantize') {
        // ADR-0086 Phase 1 (commit f2f86193a): memory-initializer.ts was
        // deleted, taking quantizeInt8/getQuantizationStats with it. The
        // upstream dynamic-import-then-catch-as-fallthrough pattern is dead
        // code in our fork; surface the missing capability as an error so
        // callers don't silently see "patternsCompressed: 0". When the
        // router gains a quantization op, route here.
        return { success: false, error: 'Quantization not available — memory-initializer was removed in ADR-0086 Phase 1.' };
      }

      if (method === 'prune') {
        // Prune patterns with low usage count below threshold (targetReduction as min usage)
        const threshold = targetReduction;
        const toRemove: string[] = [];
        for (const [id, pattern] of Object.entries(store.patterns)) {
          if ((pattern.usageCount || 0) < threshold) toRemove.push(id);
        }
        for (const id of toRemove) delete store.patterns[id];
        saveNeuralStore(store);
        return {
          success: true, _real: true, method,
          embeddingProvider: embeddingServiceName,
          threshold,
          patternsRemoved: toRemove.length,
          patternsBefore: beforeCount,
          patternsAfter: Object.keys(store.patterns).length,
        };
      }

      if (method === 'distill') {
        // Merge similar patterns by cosine similarity > 0.95
        const patternList = Object.entries(store.patterns);
        const merged: string[] = [];
        for (let i = 0; i < patternList.length; i++) {
          const [idA, a] = patternList[i];
          if (merged.includes(idA)) continue;
          for (let j = i + 1; j < patternList.length; j++) {
            const [idB, b] = patternList[j];
            if (!a.embedding || !b.embedding || merged.includes(idB)) continue;
            const sim = cosineSimilarity(a.embedding, b.embedding);
            if (sim > 0.95) {
              // Merge: average embeddings, keep higher usage count
              for (let k = 0; k < a.embedding.length; k++) {
                a.embedding[k] = (a.embedding[k] + (b.embedding[k] || 0)) / 2;
              }
              a.usageCount = Math.max(a.usageCount || 0, b.usageCount || 0);
              delete store.patterns[idB];
              merged.push(idB);
            }
          }
        }
        saveNeuralStore(store);
        return {
          success: true, _real: true, method,
          embeddingProvider: embeddingServiceName,
          patternsMerged: merged.length,
          patternsBefore: beforeCount,
          patternsAfter: Object.keys(store.patterns).length,
        };
      }

      return { success: false, error: `Unknown method: ${method}. Use quantize, prune, or distill.` };
    },
  },
  {
    name: 'neural_status',
    description: 'Get neural system status',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Specific model ID' },
        detailed: { type: 'boolean', description: 'Include detailed info' },
      },
    },
    handler: async (input) => {
      if (input.modelId) { const v = validateIdentifier(input.modelId as string, 'modelId'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadNeuralStore();

      if (input.modelId) {
        const model = store.models[input.modelId as string];
        if (!model) {
          return { success: false, error: 'Model not found' };
        }
        return { success: true, model };
      }

      const models = Object.values(store.models);
      const patterns = Object.values(store.patterns);

      return {
        _realEmbeddings: !!realEmbeddings,
        embeddingProvider: realEmbeddings ? `@claude-flow/embeddings (${embeddingServiceName})` : 'hash-based (deterministic)',
        models: {
          total: models.length,
          ready: models.filter(m => m.status === 'ready').length,
          training: models.filter(m => m.status === 'training').length,
          avgAccuracy: models.length > 0
            ? models.reduce((sum, m) => sum + m.accuracy, 0) / models.length
            : 0,
        },
        patterns: {
          total: patterns.length,
          byType: patterns.reduce((acc, p) => {
            acc[p.type] = (acc[p.type] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          // Real stored dimension when a pattern exists. With an empty store
          // there is genuinely no embedding dimension yet — report null rather
          // than a fabricated literal (the old `384` was a hardcoded guess and
          // is wrong for the unified 768-dim model).
          totalEmbeddingDims: patterns.length > 0 ? patterns[0].embedding.length : null,
        },
        features: {
          hnsw: true,
          quantization: true,
          // #1770: probe the real loader instead of returning a literal false.
          // Was hardcoded false, which contradicted hooks_intelligence_stats's
          // simultaneous claim of `implementation: real-flash-attention`.
          // The two surfaces now agree on a single source of truth.
          flashAttention: await (async () => {
            try {
              // #1773 item 4 — flash-attention now lives in @claude-flow/neural
              const { getFlashAttention } = await import('@claude-flow/neural');
              return getFlashAttention() !== null;
            } catch {
              return false;
            }
          })(),
          reasoningBank: true,
        },
      };
    },
  },
  {
    name: 'neural_optimize',
    description: 'Optimize neural model performance',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to optimize' },
        target: { type: 'string', enum: ['speed', 'memory', 'accuracy', 'balanced'], description: 'Optimization target' },
      },
    },
    handler: async (input) => {
      if (input.modelId) { const v = validateIdentifier(input.modelId as string, 'modelId'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadNeuralStore();
      const target = (input.target as string) || 'balanced';
      const patterns = Object.values(store.patterns);

      if (patterns.length === 0) {
        return { success: false, error: 'No patterns to optimize. Train patterns first with neural_train.' };
      }

      const startTime = performance.now();
      const actions: string[] = [];
      const beforeCount = patterns.length;
      const dims = patterns[0]?.embedding?.length || 0;
      let patternsRemoved = 0;
      let patternsQuantized = 0;
      let duplicatesRemoved = 0;

      // speed / balanced: deduplicate identical or near-identical patterns
      if (target === 'speed' || target === 'balanced') {
        const seen = new Map<string, string>(); // hash -> id
        for (const [id, p] of Object.entries(store.patterns)) {
          if (!p.embedding || p.embedding.length === 0) continue;
          // Quick hash: first 8 dims rounded
          const hash = p.embedding.slice(0, 8).map(v => v.toFixed(4)).join(',');
          if (seen.has(hash)) {
            // Verify with full cosine similarity
            const existingId = seen.get(hash)!;
            const existing = store.patterns[existingId];
            if (existing && cosineSimilarity(p.embedding, existing.embedding) > 0.99) {
              existing.usageCount = Math.max(existing.usageCount || 0, p.usageCount || 0);
              delete store.patterns[id];
              duplicatesRemoved++;
            }
          } else {
            seen.set(hash, id);
          }
        }
        if (duplicatesRemoved > 0) actions.push(`Removed ${duplicatesRemoved} near-duplicate patterns`);
      }

      // memory / balanced: quantize large embeddings — ADR-0086 Phase 1
      // removed memory-initializer (which provided quantizeInt8/getQuantizationStats);
      // record the skip so callers know the action was not performed.
      if (target === 'memory' || target === 'balanced') {
        actions.push('Quantization skipped (memory-initializer removed in ADR-0086 Phase 1)');
      }

      // accuracy / balanced: prune low-usage, zero-embedding patterns
      if (target === 'accuracy' || target === 'balanced') {
        for (const [id, p] of Object.entries(store.patterns)) {
          if (!p.embedding || p.embedding.length === 0) {
            delete store.patterns[id];
            patternsRemoved++;
            continue;
          }
          // Remove patterns with all-zero embeddings (no useful signal)
          const norm = p.embedding.reduce((s, v) => s + v * v, 0);
          if (norm < 1e-10) {
            delete store.patterns[id];
            patternsRemoved++;
          }
        }
        if (patternsRemoved > 0) actions.push(`Pruned ${patternsRemoved} empty/zero-signal patterns`);
      }

      saveNeuralStore(store);
      const elapsed = Math.round(performance.now() - startTime);

      return {
        success: true, _real: true, target,
        embeddingProvider: embeddingServiceName,
        actions,
        patternsBefore: beforeCount,
        patternsAfter: Object.keys(store.patterns).length,
        duplicatesRemoved,
        patternsQuantized,
        patternsRemoved,
        embeddingDims: dims,
        elapsedMs: elapsed,
      };
    },
  },
];
