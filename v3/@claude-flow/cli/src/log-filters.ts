/**
 * Console filter installed at the top of every entry point. Two jobs:
 *
 * 1. Suppress the cosmetic "[AgentDB Patch] Controller index not found"
 *    warning emitted by agentic-flow's runtime patch (it expects agentdb v1.x
 *    layout but we use v3). This file MUST be imported as the first side-effect
 *    import in any entry point so the patch is in place before agentic-flow
 *    (and anything that transitively imports it) loads.
 *
 *    The previous attempt put the suppression as a top-level code block inside
 *    src/index.ts, but ES module imports are evaluated before the file's own
 *    top-level code, so transitive imports of agentic-flow were still
 *    triggering the warning before the suppression took effect. A dedicated
 *    side-effect module imported FIRST avoids that.
 *
 *    Tight match: requires BOTH "[AgentDB Patch]" AND "Controller index not
 *    found". Other [AgentDB Patch] messages (real issues) flow through.
 *    Audit log audit_1776483149979 flagged the previous broad filter as too
 *    aggressive — this one is tight enough to be safe.
 *
 * 2. Suppress agentdb's mock-embedder-fallback warning cluster emitted by
 *    `agentdb/dist/controllers/EmbeddingService.js` lines 48–56 when
 *    transformers.js initialisation fails (commonly: macOS arm64 without
 *    `brew install vips` — sharp can't load `libvips-cpp.42.dylib`). The
 *    warnings advertise that agentdb is "falling back to mock embeddings" —
 *    but the fork's agentdb-backend.ts computes vectors with its own ONNX
 *    pipeline (embeddingGenerator injection) and passes pre-computed
 *    embeddings to agentdb, so agentdb's mock-embedder path is NOT the write
 *    path. Letting the warning through is misleading and gets reported as a
 *    bug. Suppression is safe because the fork never relies on agentdb's
 *    internal embedder for writes. (upstream 844f68dbe, #2253 cluster)
 */

// Force this file into module scope so top-level `const` declarations don't
// collide with the emitted `dist/src/log-filters.d.ts` (which composite project
// references pull in). Without an export, TS treats this as a global script and
// the source const + emitted `declare const` cause "Cannot redeclare" errors.
export {};

const isCosmeticAgentdbPatchNoise = (msg: unknown): boolean => {
  const s = String(msg ?? '');
  return s.includes('[AgentDB Patch]') && s.includes('Controller index not found');
};

// (2) Suppress the agentdb mock-embedder-fallback cluster. Each entry below
// matches the EXACT prefix `console.warn` argument from
// agentdb/dist/controllers/EmbeddingService.js:48–56. Keep this list pinned to
// the upstream lines, NOT broadened heuristically — broader filters risk hiding
// real signals (audit_1776483149979 lesson). (upstream 844f68dbe, #2253)
const AGENTDB_MOCK_FALLBACK_DROP_PREFIXES = [
  'Transformers.js initialization failed:',        // line 48 — multi-line because the error has a multi-line .message
  '   Falling back to mock embeddings for testing', // line 49
  '   This is normal if:',                          // line 50
  '     - Running offline/without internet access', // line 51
  '     - Model not yet downloaded',                // line 52
  '     - Network connectivity issues',             // line 53
  '   To use real embeddings:',                     // line 54
  '     - Ensure internet connectivity for first',  // line 55
  '     - Or pre-download: npx agentdb',            // line 56
];

const isAgentdbMockFallbackNoise = (msg: unknown): boolean => {
  const s = String(msg ?? '');
  for (const prefix of AGENTDB_MOCK_FALLBACK_DROP_PREFIXES) {
    if (s.startsWith(prefix)) return true;
  }
  return false;
};

const origWarn = console.warn.bind(console);
const origLog = console.log.bind(console);

console.warn = (...args: unknown[]) => {
  if (isCosmeticAgentdbPatchNoise(args[0])) return;
  if (isAgentdbMockFallbackNoise(args[0])) return;
  origWarn(...args);
};
console.log = (...args: unknown[]) => {
  if (isCosmeticAgentdbPatchNoise(args[0])) return;
  origLog(...args);
};
