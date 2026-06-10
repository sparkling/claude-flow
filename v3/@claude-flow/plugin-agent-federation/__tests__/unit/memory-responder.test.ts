/**
 * Tests for ADR-0309 T2′ — the local-memory responder.
 *
 * Definition of Done coverage:
 *   1. Two-node round-trip: a TRUSTED peer's memory-query is served from
 *      the local store and a signed `memory-response` is sent back with
 *      the (PII-gated) entries.
 *   2. Untrusted peer REFUSED + the refusal AUDITED (message_rejected,
 *      reason MEMORY_QUERY_DENIED) — and NO response leaves the node.
 *   3. PII gating: served values are transformed at the peer's trust
 *      level before they leave the node.
 *   4. No-hit and malformed-payload paths.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleInboundMemoryQuery,
  MEMORY_QUERY_CAPABILITY,
  type MemoryResponderDeps,
  type MemoryResponseEntry,
  type InboundMemoryQueryEvent,
} from '../../src/application/memory-responder.js';
import { FederationNode } from '../../src/domain/entities/federation-node.js';
import { TrustLevel } from '../../src/domain/entities/trust-level.js';
import type { AgentMessage } from '../../src/transport/agentic-flow-loader.js';

function mkPeer(nodeId: string, trustLevel: TrustLevel) {
  return FederationNode.create({
    nodeId,
    publicKey: `pk-${nodeId}`,
    endpoint: `ws://${nodeId}:9100`,
    capabilities: {
      agentTypes: [],
      maxConcurrentSessions: 1,
      supportedProtocols: [],
      complianceModes: [],
    },
    metadata: {},
    trustLevel,
  });
}

function mkQueryMessage(query: string, namespace = 'default'): AgentMessage {
  return {
    id: 'q-msg-1',
    type: 'memory-query',
    // On the wire the dispatcher delivers the FederationEnvelope; its
    // .payload is the caller's { query, namespace }.
    payload: {
      envelopeId: 'q-msg-1',
      messageType: 'memory-query',
      payload: { query, namespace },
    },
    metadata: { sourceNodeId: 'node-A' },
  };
}

function mkDeps(
  peerTrust: TrustLevel,
  storeEntries: MemoryResponseEntry[],
  overrides: Partial<MemoryResponderDeps> = {},
): {
  deps: MemoryResponderDeps;
  audits: { eventType: string; data: any }[];
  sent: { address: string; message: AgentMessage }[];
} {
  const audits: { eventType: string; data: any }[] = [];
  const sent: { address: string; message: AgentMessage }[] = [];
  const deps: MemoryResponderDeps = {
    readLocalMemory: () => storeEntries,
    // Identity PII pipeline by default; specific tests override to assert gating.
    pii: { transform: (text: string) => ({ transformedText: text, detections: [], actionsApplied: [] }) } as any,
    audit: {
      log: (async (eventType: string, data: unknown) => {
        audits.push({ eventType, data });
      }) as MemoryResponderDeps['audit']['log'],
    },
    resolveAddress: (nodeId: string) => `${nodeId}:9100`,
    sendResponse: async (address: string, message: AgentMessage) => {
      sent.push({ address, message });
    },
    signEnvelope: (m: AgentMessage) => ({
      ...m,
      metadata: { ...(m.metadata as Record<string, unknown>), signature: 'signed-by-B' },
    }),
    localNodeId: () => 'node-B',
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, audits, sent };
}

function mkEvent(peer: FederationNode, message: AgentMessage): InboundMemoryQueryEvent {
  return { address: '10.0.0.1:55555', sourceNodeId: 'node-A', message, peer };
}

describe('handleInboundMemoryQuery — two-node round-trip (ADR-0309 T2′ DoD #1)', () => {
  it('TRUSTED peer: serves local memory + sends a signed memory-response back', async () => {
    const peer = mkPeer('node-A', TrustLevel.TRUSTED);
    const entries: MemoryResponseEntry[] = [
      { key: 'k1', value: 'team decision: use git-as-memory-bus', namespace: 'default' },
    ];
    const { deps, audits, sent } = mkDeps(TrustLevel.TRUSTED, entries);

    const outcome = await handleInboundMemoryQuery(mkEvent(peer, mkQueryMessage('decision')), deps);

    // B served the read
    expect(outcome).toEqual({ served: true, entryCount: 1, address: 'node-A:9100' });
    // A receives a signed memory-response addressed back to it
    expect(sent).toHaveLength(1);
    expect(sent[0].address).toBe('node-A:9100');
    expect(sent[0].message.type).toBe('memory-response');
    expect((sent[0].message.metadata as any).sourceNodeId).toBe('node-B');
    expect((sent[0].message.metadata as any).targetNodeId).toBe('node-A');
    expect((sent[0].message.metadata as any).signature).toBe('signed-by-B');
    const body = sent[0].message.payload as any;
    expect(body.hit).toBe(true);
    expect(body.inReplyTo).toBe('q-msg-1');
    expect(body.entries[0].value).toContain('git-as-memory-bus');
    // The served read is audited as message_sent / granted
    const grant = audits.find((a) => a.eventType === 'message_sent');
    expect(grant).toBeTruthy();
    expect(grant!.data.claimsResult).toBe('granted');
  });

  it('no-hit: serves an empty result with hit:false (still a valid round-trip)', async () => {
    const peer = mkPeer('node-A', TrustLevel.ATTESTED);
    const { deps, sent } = mkDeps(TrustLevel.ATTESTED, []);
    const outcome = await handleInboundMemoryQuery(mkEvent(peer, mkQueryMessage('nothing')), deps);
    expect(outcome.served).toBe(true);
    expect(sent[0].message.type).toBe('memory-response');
    expect((sent[0].message.payload as any).hit).toBe(false);
    expect((sent[0].message.payload as any).entries).toEqual([]);
  });
});

describe('handleInboundMemoryQuery — untrusted refused + audited (ADR-0309 T2′ DoD #2)', () => {
  it('UNTRUSTED peer is REFUSED, refusal is AUDITED, and NO response is sent', async () => {
    const peer = mkPeer('node-A', TrustLevel.UNTRUSTED);
    const { deps, audits, sent } = mkDeps(TrustLevel.UNTRUSTED, [
      { key: 'k1', value: 'secret', namespace: 'default' },
    ]);

    const outcome = await handleInboundMemoryQuery(mkEvent(peer, mkQueryMessage('secret')), deps);

    expect(outcome).toEqual({ served: false, reason: 'DENIED' });
    // AUDITED as a rejection with the constant reason — no oracle leak
    const reject = audits.find((a) => a.eventType === 'message_rejected');
    expect(reject).toBeTruthy();
    expect(reject!.data.metadata.reason).toBe('MEMORY_QUERY_DENIED');
    expect(reject!.data.claimsResult).toBe('denied');
    // CRITICAL: nothing left the node
    expect(sent).toHaveLength(0);
  });

  it('VERIFIED peer (tier 1, below query-redacted) is also refused', async () => {
    const peer = mkPeer('node-A', TrustLevel.VERIFIED);
    const { deps, sent } = mkDeps(TrustLevel.VERIFIED, [{ key: 'k', value: 'v' }]);
    const outcome = await handleInboundMemoryQuery(mkEvent(peer, mkQueryMessage('q')), deps);
    expect(outcome.served).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('capability constant matches the trust model gate', () => {
    expect(MEMORY_QUERY_CAPABILITY).toBe('query-redacted');
  });
});

describe('handleInboundMemoryQuery — PII gating (ADR-0309 T2′ DoD #3)', () => {
  it('served values are PII-transformed at the peer trust level before leaving', async () => {
    const peer = mkPeer('node-A', TrustLevel.ATTESTED);
    const transform = vi.fn((_text: string) => ({
      transformedText: '[REDACTED]',
      detections: [{ type: 'email' }],
      actionsApplied: [{ type: 'email', action: 'redact' }],
    }));
    const { deps, sent } = mkDeps(TrustLevel.ATTESTED, [{ key: 'k', value: 'alice@example.com' }], {
      pii: { transform } as any,
    });
    await handleInboundMemoryQuery(mkEvent(peer, mkQueryMessage('contact')), deps);
    // PII pipeline invoked with the peer's trust level
    expect(transform).toHaveBeenCalledWith('alice@example.com', TrustLevel.ATTESTED);
    // The gated (not raw) value is what gets sent
    expect((sent[0].message.payload as any).entries[0].value).toBe('[REDACTED]');
  });
});

describe('handleInboundMemoryQuery — robustness', () => {
  it('malformed payload (no query) is refused as BAD_PAYLOAD and audited', async () => {
    const peer = mkPeer('node-A', TrustLevel.TRUSTED);
    const { deps, audits, sent } = mkDeps(TrustLevel.TRUSTED, []);
    const badMsg: AgentMessage = {
      id: 'q-msg-2',
      type: 'memory-query',
      payload: { envelopeId: 'q-msg-2', payload: { notAQuery: true } },
      metadata: { sourceNodeId: 'node-A' },
    };
    const outcome = await handleInboundMemoryQuery(mkEvent(peer, badMsg), deps);
    expect(outcome).toEqual({ served: false, reason: 'BAD_PAYLOAD' });
    expect(audits.some((a) => a.eventType === 'message_rejected')).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('a throwing memory reader degrades to a no-hit response (does not crash)', async () => {
    const peer = mkPeer('node-A', TrustLevel.TRUSTED);
    const { deps, sent } = mkDeps(TrustLevel.TRUSTED, [], {
      readLocalMemory: () => {
        throw new Error('store offline');
      },
    });
    const outcome = await handleInboundMemoryQuery(mkEvent(peer, mkQueryMessage('q')), deps);
    expect(outcome.served).toBe(true);
    expect((sent[0].message.payload as any).hit).toBe(false);
  });

  it('a failing transport send does not throw; the read is still audited', async () => {
    const peer = mkPeer('node-A', TrustLevel.TRUSTED);
    const { deps, audits } = mkDeps(TrustLevel.TRUSTED, [{ key: 'k', value: 'v' }], {
      sendResponse: async () => {
        throw new Error('socket closed');
      },
    });
    const outcome = await handleInboundMemoryQuery(mkEvent(peer, mkQueryMessage('q')), deps);
    expect(outcome.served).toBe(true);
    expect(audits.some((a) => a.eventType === 'message_sent')).toBe(true);
  });
});
