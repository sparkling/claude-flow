/**
 * RaBitQ Index — 1-bit quantized vector pre-filter (32× compression)
 *
 * Wraps @ruvector/rabitq-wasm to provide Hamming-scan pre-filtering
 * over quantized embeddings. Candidates are reranked with exact cosine
 * similarity from the full-precision source (HNSW or SQLite).
 *
 * Lifecycle:
 *  1. build() — bulk-load all embeddings from SQLite into the WASM index
 *  2. search() — fast Hamming scan → candidate ids → caller reranks
 *  3. rebuild() — called when entry count drifts >20% from last build
 */

import * as fs from 'fs';
import * as path from 'path';
import { findProjectRoot } from '@claude-flow/shared/fs';

interface RabitqEntry {
  id: string;
  key: string;
  namespace: string;
}

interface RabitqState {
  index: any; // RabitqIndex from WASM
  entries: RabitqEntry[]; // positional: entries[i] ↔ row i in build()
  dimensions: number;
  builtAt: number;
  vectorCount: number;
}

const RABITQ_SEED = 42n;
const RABITQ_RERANK_FACTOR = 20;
const REBUILD_DRIFT_THRESHOLD = 0.2; // rebuild when count drifts >20%

let rabitqState: RabitqState | null = null;
let rabitqInitializing = false;

/**
 * Distinguishes "the package is not installed" (a benign capability-absent
 * state → null) from "the package is installed but its WASM export shape skewed"
 * (a real defect → throw, fail-loud per feedback-no-fallbacks). The earlier
 * blanket `catch { return null }` masked the second class — exactly the
 * ADR-0293 D1 failure mode (ruvllm-wasm switched to an auto-instantiate build
 * exporting only `init()`; `mod.initSync` became undefined and every call died
 * with a swallowed `TypeError`).
 */
let _rabitqLoad: Promise<{ RabitqIndex: any; version: () => string } | null> | null = null;

async function loadRabitqModule(): Promise<{
  RabitqIndex: any;
  version: () => string;
} | null> {
  // Memoize: the WASM is instantiated once per process (initSync mutates a
  // module-global instance; re-running it is wasteful and the wrapper already
  // holds the built index in rabitqState).
  if (_rabitqLoad) return _rabitqLoad;
  _rabitqLoad = (async () => {
    let mod: any;
    try {
      mod = await import('@ruvector/rabitq-wasm');
    } catch {
      // Package genuinely absent (not declared / not installed). Capability is
      // honestly unavailable — the caller surfaces a clear envelope. NOT a defect.
      return null;
    }

    // ADR-0294 R3 pre-flight (ADR-0293 D1 shape-detection pattern): rabitq-wasm
    // 0.1.0 is a LEGACY wasm-bindgen build — `initSync(module)` synchronously
    // instantiates, `init()` is only a panic-hook installer (NOT instantiation).
    // If a future build flips to the auto-instantiate shape (default __wbg_init
    // that already instantiated; no `initSync`), detect it and fail loud instead
    // of letting `mod.initSync(...)` throw an opaque "is not a function".
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('@ruvector/rabitq-wasm/ruvector_rabitq_wasm_bg.wasm');
    const wasmBytes = fs.readFileSync(wasmPath);

    if (typeof mod.initSync === 'function') {
      // Legacy shape (current 0.1.0): explicit synchronous instantiation.
      mod.initSync({ module: wasmBytes });
    } else if (typeof mod.default === 'function' && typeof mod.RabitqIndex === 'function') {
      // Auto-instantiate shape: the default export already instantiated on
      // import; await it defensively so a Response/bytes form is honoured.
      await mod.default();
    } else {
      throw new Error(
        '@ruvector/rabitq-wasm loaded but exposes neither initSync (legacy) nor a ' +
        'default-init + RabitqIndex (auto-instantiate) shape — WASM export skew ' +
        '(cf. ADR-0293 D1). Pin a compatible @ruvector/rabitq-wasm build.',
      );
    }

    if (typeof mod.RabitqIndex !== 'function' || typeof mod.version !== 'function') {
      throw new Error(
        '@ruvector/rabitq-wasm initialized but RabitqIndex/version symbols are missing — ' +
        'WASM build incompatible with the rabitq-index wrapper (ADR-0294 R3).',
      );
    }

    return { RabitqIndex: mod.RabitqIndex, version: mod.version };
  })();
  return _rabitqLoad;
}

/**
 * Build or rebuild the RaBitQ index from SQLite embeddings.
 * Returns entry count or 0 if RaBitQ is unavailable.
 */
export async function buildRabitqIndex(options?: {
  dbPath?: string;
  dimensions?: number;
  force?: boolean;
}): Promise<{
  success: boolean;
  vectorCount: number;
  dimensions: number;
  compressionRatio: number;
  buildTimeMs: number;
  wasmVersion?: string;
  error?: string;
}> {
  if (rabitqInitializing) {
    return { success: false, vectorCount: 0, dimensions: 0, compressionRatio: 0, buildTimeMs: 0, error: 'Build already in progress' };
  }

  rabitqInitializing = true;
  const startTime = Date.now();

  try {
    const mod = await loadRabitqModule();
    if (!mod) {
      rabitqInitializing = false;
      return { success: false, vectorCount: 0, dimensions: 0, compressionRatio: 0, buildTimeMs: 0, error: '@ruvector/rabitq-wasm not available' };
    }

    const dimensions = options?.dimensions ?? 384;
    const swarmDir = path.resolve(findProjectRoot(), '.swarm'); // ADR-0137: anchor .swarm at project root, not cwd
    const dbPath = options?.dbPath ? path.resolve(options.dbPath) : path.join(swarmDir, 'memory.db');

    const entries: RabitqEntry[] = [];
    const vectors: number[] = [];

    // ADR-0086 RVF-first: read embeddings via memory-router (the consolidated
    // successor to deleted memory-bridge). No raw SQLite shadow read path per
    // ADR-0084 + feedback-no-fallbacks (fail loud, never mask via silent catch).
    const { routerGetAllEmbeddings } = await import('./memory-router.js');
    const routerRows = await routerGetAllEmbeddings({ dimensions, dbPath: options?.dbPath });
    if (routerRows === null) {
      throw new Error('[rabitq-index] routerGetAllEmbeddings returned null — storage unavailable post-ensureRouter (ADR-0111 W1.5 Model 1 violation)');
    }
    for (const row of routerRows) {
      entries.push({ id: row.id, key: row.key, namespace: row.namespace });
      vectors.push(...row.embedding);
    }

    if (entries.length < 2) {
      rabitqInitializing = false;
      return { success: false, vectorCount: entries.length, dimensions, compressionRatio: 0, buildTimeMs: Date.now() - startTime, error: 'Need at least 2 vectors to build RaBitQ index' };
    }

    // Build the RaBitQ index
    const flatVectors = new Float32Array(vectors);
    const index = mod.RabitqIndex.build(flatVectors, dimensions, RABITQ_SEED, RABITQ_RERANK_FACTOR);

    // Free old index if exists
    if (rabitqState?.index) {
      try { rabitqState.index.free(); } catch { /* already freed */ }
    }

    rabitqState = {
      index,
      entries,
      dimensions,
      builtAt: Date.now(),
      vectorCount: entries.length,
    };

    // Persist metadata for fast reload hint
    try {
      const metaPath = path.join(swarmDir, 'rabitq.meta.json');
      fs.writeFileSync(metaPath, JSON.stringify({
        vectorCount: entries.length,
        dimensions,
        builtAt: rabitqState.builtAt,
        wasmVersion: mod.version(),
      }));
    } catch { /* best-effort */ }

    const rawBytes = entries.length * dimensions * 4; // f32 = 4 bytes
    const quantizedBytes = entries.length * Math.ceil(dimensions / 8); // 1 bit per dim
    const compressionRatio = rawBytes / Math.max(quantizedBytes, 1);

    rabitqInitializing = false;
    return {
      success: true,
      vectorCount: entries.length,
      dimensions,
      compressionRatio: Math.round(compressionRatio * 10) / 10,
      buildTimeMs: Date.now() - startTime,
      wasmVersion: mod.version(),
    };
  } catch (error) {
    rabitqInitializing = false;
    return {
      success: false,
      vectorCount: 0,
      dimensions: 0,
      compressionRatio: 0,
      buildTimeMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Search the RaBitQ index for candidate IDs.
 * Returns null if index not built or unavailable.
 * Caller is responsible for reranking with exact similarity.
 */
export async function searchRabitq(
  queryEmbedding: number[],
  options?: { k?: number; namespace?: string }
): Promise<Array<{
  id: string;
  key: string;
  namespace: string;
  distance: number;
  position: number;
}> | null> {
  if (!rabitqState?.index) return null;

  try {
    const query = new Float32Array(queryEmbedding);
    if (query.length !== rabitqState.dimensions) return null;

    const k = options?.k ?? 10;
    // Get more candidates than needed for namespace filtering + rerank
    const expandedK = Math.min(k * 3, rabitqState.vectorCount);

    const rawResults = rabitqState.index.search(query, expandedK);

    const results: Array<{
      id: string;
      key: string;
      namespace: string;
      distance: number;
      position: number;
    }> = [];

    for (const hit of rawResults) {
      const pos = hit.id; // row index from build()
      const entry = rabitqState.entries[pos];
      if (!entry) continue;

      // Namespace filter
      if (options?.namespace && options.namespace !== 'all' && entry.namespace !== options.namespace) {
        continue;
      }

      results.push({
        id: entry.id,
        key: entry.key,
        namespace: entry.namespace,
        distance: hit.distance,
        position: pos,
      });

      // Free WASM SearchResult to prevent leak
      try { hit.free(); } catch { /* already freed */ }

      if (results.length >= k) break;
    }

    // Free remaining SearchResults
    for (const hit of rawResults) {
      try { hit.free(); } catch { /* already freed or used */ }
    }

    return results;
  } catch {
    return null;
  }
}

/**
 * Check if the RaBitQ index needs rebuilding.
 */
export async function shouldRebuildRabitq(currentEntryCount: number): Promise<boolean> {
  if (!rabitqState) return currentEntryCount >= 10; // Build if we have enough vectors

  const drift = Math.abs(currentEntryCount - rabitqState.vectorCount) / Math.max(rabitqState.vectorCount, 1);
  return drift > REBUILD_DRIFT_THRESHOLD;
}

/**
 * Get RaBitQ index status.
 */
export function getRabitqStatus(): {
  available: boolean;
  initialized: boolean;
  vectorCount: number;
  dimensions: number;
  builtAt: number | null;
  compressionRatio: number;
} {
  return {
    available: rabitqState !== null,
    initialized: rabitqState !== null,
    vectorCount: rabitqState?.vectorCount ?? 0,
    dimensions: rabitqState?.dimensions ?? 384,
    builtAt: rabitqState?.builtAt ?? null,
    compressionRatio: rabitqState ? Math.round((rabitqState.dimensions * 4) / Math.ceil(rabitqState.dimensions / 8) * 10) / 10 : 0,
  };
}
