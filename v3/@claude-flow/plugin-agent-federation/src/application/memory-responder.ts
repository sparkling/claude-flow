/**
 * Local-memory responder (ADR-0309 T2′).
 *
 * The inbound dispatcher (ADR-109 / ADR-0309 T1′) verifies an inbound
 * envelope and EMITS `federation:inbound:memory-query` "for the
 * integrator" — but neither upstream nor the fork ships a built-in
 * subscriber that actually answers it from the local memory store. This
 * module is that missing subscriber: it closes the `federation_query`
 * round-trip so a peer's `memory-query` is served from THIS node's
 * memory by default.
 *
 * Design (mirrors the dispatcher's anti-coupling posture):
 *
 *   - The memory store is INJECTED as a narrow `readLocalMemory`
 *     function. The plugin wires it from `services.get('memory')` when a
 *     backend is registered; absent one, a no-op reader is injected and
 *     the responder honestly answers `{ hit: false }`. The responder
 *     never reaches into a concrete store type.
 *   - Trust gate: the querying peer must hold the `query-redacted`
 *     capability (ATTESTED+). UNTRUSTED/VERIFIED peers are refused —
 *     and the refusal is AUDITED (`message_rejected`,
 *     reason `MEMORY_QUERY_DENIED`).
 *   - PII gate: the served text is run through the injected PII pipeline
 *     at the peer's trust level before it leaves the node. At UNTRUSTED
 *     the matrix BLOCKS everything; higher tiers redact/hash/pass per
 *     the existing policy matrix.
 *   - Reply path: a signed `memory-response` AgentMessage is sent back
 *     over the SAME transport, keyed by the peer's resolved address.
 *     This is transport-level (peer-keyed), matching the dispatcher —
 *     it does NOT require a reverse session handshake.
 *
 * The responder is wired in plugin.ts only when both a transport and the
 * inbound dispatcher are active. It is opt-in by the same federation +
 * AGENTIC_FLOW_QUIC_NATIVE enablement that gates the dispatcher.
 */

import type { AgentMessage } from '../transport/agentic-flow-loader.js';
import type { FederationNode } from '../domain/entities/federation-node.js';
import type { AuditService } from '../domain/services/audit-service.js';
import type { PIIPipelineService } from '../domain/services/pii-pipeline-service.js';
import { TrustLevel } from '../domain/entities/trust-level.js';
import { isOperationAllowed } from '../domain/entities/trust-level.js';

/** The capability a peer must hold to read this node's memory. */
export const MEMORY_QUERY_CAPABILITY = 'query-redacted';

/** Shape of a single served memory hit (post-PII). */
export interface MemoryResponseEntry {
  readonly key: string;
  readonly value: string;
  readonly namespace?: string;
}

/**
 * Narrow read port over the local memory store. Returns matching entries
 * for a `query`/`namespace`. The plugin adapts whatever backend is
 * registered to this signature; tests inject a fake. Returning `[]` is a
 * legitimate "no hit" (NOT an error).
 */
export type LocalMemoryReader = (
  query: string,
  namespace: string,
) => Promise<readonly MemoryResponseEntry[]> | readonly MemoryResponseEntry[];

/** Event payload emitted by the dispatcher for `memory-query`. */
export interface InboundMemoryQueryEvent {
  readonly address: string;
  readonly sourceNodeId: string;
  readonly message: AgentMessage;
  readonly peer: FederationNode;
}

/** Dependencies for the responder (kept narrow for testability). */
export interface MemoryResponderDeps {
  /** Reads this node's local memory. Injected; never a concrete store. */
  readonly readLocalMemory: LocalMemoryReader;
  /** PII pipeline — gates served text at the peer's trust level. */
  readonly pii: Pick<PIIPipelineService, 'transform'>;
  /** Audit sink — every served read AND every refusal is logged. */
  readonly audit: Pick<AuditService, 'log'>;
  /** Resolves a nodeId to a wire address for the reply. */
  readonly resolveAddress: (nodeId: string) => string | null;
  /** Sends the signed reply back over the transport. */
  readonly sendResponse: (address: string, message: AgentMessage) => Promise<void>;
  /** Signs the canonical bytes of the reply envelope. */
  readonly signEnvelope: (message: AgentMessage) => AgentMessage;
  /** This node's own id (becomes the response's sourceNodeId). */
  readonly localNodeId: () => string;
  readonly logger: {
    debug: (m: string) => void;
    warn: (m: string) => void;
  };
}

/** Outcome of handling one inbound memory-query (for tests + metrics). */
export type MemoryResponseOutcome =
  | { readonly served: true; readonly entryCount: number; readonly address: string }
  | { readonly served: false; readonly reason: 'DENIED' | 'BAD_PAYLOAD' | 'NO_ADDRESS' };

interface MemoryQueryPayload {
  readonly query: string;
  readonly namespace?: string;
}

function extractQueryPayload(message: AgentMessage): MemoryQueryPayload | null {
  // On the wire, payload is the FederationEnvelope; its `.payload` is the
  // caller-supplied { query, namespace } (see mcp-tools federation_query
  // → coordinator.sendMessage('memory-query', { query, namespace })).
  const env = message.payload as { payload?: unknown } | undefined;
  const inner = (env && typeof env === 'object' && 'payload' in env ? env.payload : message.payload) as
    | Record<string, unknown>
    | undefined;
  if (!inner || typeof inner !== 'object') return null;
  const query = typeof inner.query === 'string' ? inner.query : null;
  if (query === null) return null;
  const namespace = typeof inner.namespace === 'string' ? inner.namespace : 'default';
  return { query, namespace };
}

/**
 * Handle one inbound `memory-query` event. Trust-gate → read local
 * memory → PII-gate each hit at the peer's trust level → sign + send a
 * `memory-response` back. Refusals are audited.
 *
 * Throws nothing the caller must catch: a refusal/abort returns a
 * `served:false` outcome and is fully audited/logged internally.
 */
export async function handleInboundMemoryQuery(
  event: InboundMemoryQueryEvent,
  deps: MemoryResponderDeps,
): Promise<MemoryResponseOutcome> {
  const { peer, sourceNodeId, message, address } = event;

  // Trust gate — the peer must hold `query-redacted` (ATTESTED+).
  // UNTRUSTED (the default for an unattested peer) holds only
  // ['discovery'] and is refused here.
  if (!isOperationAllowed(peer.trustLevel, MEMORY_QUERY_CAPABILITY)) {
    await deps.audit.log('message_rejected', {
      sourceNodeId,
      trustLevel: peer.trustLevel,
      claimsChecked: [MEMORY_QUERY_CAPABILITY],
      claimsResult: 'denied',
      metadata: { address, reason: 'MEMORY_QUERY_DENIED' },
    });
    deps.logger.warn(
      `Memory query refused: ${sourceNodeId} lacks '${MEMORY_QUERY_CAPABILITY}' ` +
        `(trustLevel=${peer.trustLevel})`,
    );
    return { served: false, reason: 'DENIED' };
  }

  const payload = extractQueryPayload(message);
  if (!payload) {
    await deps.audit.log('message_rejected', {
      sourceNodeId,
      metadata: { address, reason: 'INVALID_PAYLOAD' },
    });
    deps.logger.warn(`Memory query refused: malformed payload from ${sourceNodeId}`);
    return { served: false, reason: 'BAD_PAYLOAD' };
  }

  // Read local memory (injected reader — no concrete store coupling).
  let raw: readonly MemoryResponseEntry[];
  try {
    raw = await deps.readLocalMemory(payload.query, payload.namespace ?? 'default');
  } catch (err) {
    deps.logger.warn(
      `Local memory read failed for query from ${sourceNodeId}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
    raw = [];
  }

  // PII-gate each served value at the PEER's trust level. At UNTRUSTED
  // the matrix blocks everything; we already refused UNTRUSTED above, so
  // here the peer is ATTESTED+ and the matrix redacts/hashes/passes.
  const gated: MemoryResponseEntry[] = [];
  for (const entry of raw) {
    const t = deps.pii.transform(entry.value, peer.trustLevel as TrustLevel);
    // A fully-blocked value transforms to an empty/redacted string; keep
    // the key so the caller sees the hit existed but the content was
    // gated, matching the PII pipeline's redact/block semantics.
    gated.push({ key: entry.key, value: t.transformedText, namespace: entry.namespace });
  }

  // Resolve the reply address. Prefer the discovery endpoint; fall back
  // to the wire address the dispatcher saw (handles peers we received
  // from but whose endpoint isn't yet resolvable).
  const replyAddress = deps.resolveAddress(sourceNodeId) ?? address;
  if (!replyAddress) {
    deps.logger.warn(`Memory query: no reply address for ${sourceNodeId}; result computed but undeliverable`);
    return { served: false, reason: 'NO_ADDRESS' };
  }

  // Build + sign the memory-response envelope and send it back over the
  // same transport. Transport-level (peer-keyed) — no reverse session.
  const responseId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const baseResponse: AgentMessage = {
    id: responseId,
    type: 'memory-response',
    payload: {
      inReplyTo: message.id,
      query: payload.query,
      namespace: payload.namespace ?? 'default',
      hit: gated.length > 0,
      entries: gated,
    },
    metadata: {
      sourceNodeId: deps.localNodeId(),
      targetNodeId: sourceNodeId,
    },
  };
  const signed = deps.signEnvelope(baseResponse);

  try {
    await deps.sendResponse(replyAddress, signed);
  } catch (err) {
    deps.logger.warn(
      `Memory response send failed to ${replyAddress}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
    // The read succeeded + was audited below regardless of delivery.
  }

  // Audit the served read (separate from the dispatcher's
  // message_received, which only logs delivery — this logs the answer).
  await deps.audit.log('message_sent', {
    sourceNodeId: deps.localNodeId(),
    targetNodeId: sourceNodeId,
    trustLevel: peer.trustLevel,
    claimsChecked: [MEMORY_QUERY_CAPABILITY],
    claimsResult: 'granted',
    metadata: {
      address: replyAddress,
      messageType: 'memory-response',
      inReplyTo: message.id,
      entryCount: gated.length,
    },
  });

  deps.logger.debug(
    `Memory query served for ${sourceNodeId}: ${gated.length} entr${gated.length === 1 ? 'y' : 'ies'} ` +
      `(PII-gated at trustLevel=${peer.trustLevel})`,
  );
  return { served: true, entryCount: gated.length, address: replyAddress };
}
