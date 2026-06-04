/**
 * Agentic-flow federation transport loader (ADR-0297 R1, fork-native).
 *
 * Fork-native equivalent of upstream alpha.16's `midstream-aware-loader`
 * (ADR-120). The load-bearing change vs the fork's prior alpha.5 shape:
 * the `agentic-flow/transport/loader` VALUE bindings (`loadQuicTransport`,
 * `getTransportCapabilities`) are now **dynamic-imported inside try/catch**
 * instead of statically imported at module top-level. A static top-level
 * `import … from 'agentic-flow/transport/loader'` crashes the entire
 * package at module-load (`ERR_MODULE_NOT_FOUND`) on any install that
 * does not have `agentic-flow` present — killing every federation
 * subcommand. With the dynamic loader, the package loads cleanly and
 * gracefully degrades to in-process routing, self-disclosing the
 * downgrade (mirroring upstream's posture; `agentic-flow` is declared an
 * OPTIONAL peer dependency in package.json).
 *
 * The TYPE surface (`AgentMessage`, `TransportCapabilities`,
 * `QuicTransportConfig`, `AgentTransport`) is re-exported via `import type`
 * — type-only imports are erased at compile time and never cause a runtime
 * module resolution, so they are safe to keep even when `agentic-flow` is
 * absent. Consumers import everything they need from this one module.
 *
 * The fork does NOT carry upstream's `midstreamer`-first probe branch
 * (ADR-119/120 Step 1) — the fork has no `midstreamer` dependency, so that
 * speculative branch is omitted. Re-adding it later is additive.
 */
import type {
  AgentMessage,
  TransportCapabilities,
  QuicTransportConfig,
  AgentTransport,
} from 'agentic-flow/transport/loader';

export type { AgentMessage, TransportCapabilities, QuicTransportConfig, AgentTransport };

/** Result envelope describing which backend the loader picked. */
export interface LoadedFederationTransport {
  /** The live transport. Send/receive against this. */
  transport: AgentTransport;
  /** Which loader branch resolved. Useful for logs/metrics. */
  source: 'agentic-flow-loader';
}

/**
 * Lazy loader for agentic-flow's `loadQuicTransport`. Direct dynamic
 * `import()` (not the `new Function` trick) so test frameworks like vitest
 * can intercept via `vi.mock`. Returns `null` when `agentic-flow` is not
 * installed or its surface doesn't match — the caller then falls back
 * gracefully (`agentic-flow` is now an optional peer dependency).
 */
async function loadAgenticFlowQuicTransport(
  config?: QuicTransportConfig,
): Promise<AgentTransport | null> {
  let mod: { loadQuicTransport?: unknown; default?: { loadQuicTransport?: unknown } };
  try {
    mod = await import('agentic-flow/transport/loader');
  } catch {
    return null;
  }
  const fn =
    typeof mod.loadQuicTransport === 'function'
      ? (mod.loadQuicTransport as (c?: QuicTransportConfig) => Promise<AgentTransport>)
      : typeof mod.default?.loadQuicTransport === 'function'
        ? (mod.default.loadQuicTransport as (c?: QuicTransportConfig) => Promise<AgentTransport>)
        : null;
  if (!fn) {
    return null;
  }
  return fn(config);
}

/**
 * Top-level federation transport loader. Dynamic-imports the agentic-flow
 * loader and returns the resolved transport. Throws a clear, actionable
 * error when no transport is available — the caller's existing try/catch
 * downgrades to in-process routing (self-disclosing via logger.warn).
 */
export async function loadFederationTransport(
  config?: QuicTransportConfig,
): Promise<LoadedFederationTransport> {
  const transport = await loadAgenticFlowQuicTransport(config);
  if (!transport) {
    throw new Error(
      'No federation transport available. Install the optional peer ' +
        'dependency `agentic-flow` to enable wire transport (ADR-0297 R1). ' +
        'Without it, federation runs in-process only (local self-disclosing mode).',
    );
  }
  return { transport, source: 'agentic-flow-loader' };
}

/**
 * Probe the agentic-flow loader's transport capabilities (a pure env-var
 * read — no socket touch). Returns `null` when `agentic-flow` is absent or
 * its surface doesn't match, so the doctor surface can render
 * "capabilities-unavailable" without crashing.
 */
export async function getFederationTransportCapabilities(): Promise<TransportCapabilities | null> {
  let mod: {
    getTransportCapabilities?: unknown;
    default?: { getTransportCapabilities?: unknown };
  };
  try {
    mod = await import('agentic-flow/transport/loader');
  } catch {
    return null;
  }
  const fn =
    typeof mod.getTransportCapabilities === 'function'
      ? (mod.getTransportCapabilities as () => Promise<TransportCapabilities>)
      : typeof mod.default?.getTransportCapabilities === 'function'
        ? (mod.default.getTransportCapabilities as () => Promise<TransportCapabilities>)
        : null;
  if (!fn) {
    return null;
  }
  return fn();
}
