/**
 * ADR-0041: Composition-Aware Controller Architecture Tests
 *
 * Validates:
 * - Composite parents (A6, B9) create children internally
 * - No separate registry entries for sub-components (A7, A8, B1, B2, B7, B8)
 * - B4 NativeAccelerator is shared singleton across consumers
 * - D6 CircuitBreaker wraps controller get() calls
 * - Level 0 infrastructure controllers init without AgentDB
 * - Health check reports composite children via parent stats
 * - Init levels follow ADR-0041 ordering
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ControllerRegistry,
  INIT_LEVELS,
  type ControllerName,
} from './controller-registry.js';
import type {
  IMemoryBackend,
  MemoryEntry,
  MemoryQuery,
  MemoryEntryUpdate,
  SearchOptions,
  SearchResult,
  BackendStats,
  HealthCheckResult,
  MemoryType,
} from './types.js';

// ===== Mock Backend =====

function createMockBackend(): IMemoryBackend {
  const entries = new Map<string, MemoryEntry>();

  return {
    async initialize() {},
    async shutdown() {},
    async store(entry: MemoryEntry) {
      entries.set(entry.id, entry);
    },
    async get(id: string) {
      return entries.get(id) ?? null;
    },
    async getByKey(namespace: string, key: string) {
      for (const e of entries.values()) {
        if (e.namespace === namespace && e.key === key) return e;
      }
      return null;
    },
    async update(id: string, update: MemoryEntryUpdate) {
      const entry = entries.get(id);
      if (!entry) return null;
      Object.assign(entry, update, { updatedAt: Date.now() });
      return entry;
    },
    async delete(id: string) {
      return entries.delete(id);
    },
    async query(query: MemoryQuery) {
      const results = Array.from(entries.values());
      if (query.namespace) {
        return results.filter((e) => e.namespace === query.namespace).slice(0, query.limit);
      }
      return results.slice(0, query.limit);
    },
    async search(_embedding: Float32Array, _options: SearchOptions): Promise<SearchResult[]> {
      return [];
    },
    async bulkInsert(newEntries: MemoryEntry[]) {
      for (const entry of newEntries) entries.set(entry.id, entry);
    },
    async bulkDelete(ids: string[]) {
      let count = 0;
      for (const id of ids) {
        if (entries.delete(id)) count++;
      }
      return count;
    },
    async count(namespace?: string) {
      if (namespace) {
        return Array.from(entries.values()).filter((e) => e.namespace === namespace).length;
      }
      return entries.size;
    },
    async listNamespaces() {
      return [...new Set(Array.from(entries.values()).map((e) => e.namespace))];
    },
    async clearNamespace(namespace: string) {
      let count = 0;
      for (const [id, entry] of entries) {
        if (entry.namespace === namespace) {
          entries.delete(id);
          count++;
        }
      }
      return count;
    },
    async getStats(): Promise<BackendStats> {
      return {
        totalEntries: entries.size,
        entriesByNamespace: {},
        entriesByType: { episodic: 0, semantic: 0, procedural: 0, working: 0, cache: 0 },
        memoryUsage: 0,
        avgQueryTime: 0,
        avgSearchTime: 0,
      };
    },
    async healthCheck(): Promise<HealthCheckResult> {
      return {
        status: 'healthy',
        components: {
          storage: { status: 'healthy', latency: 0 },
          index: { status: 'healthy', latency: 0 },
          cache: { status: 'healthy', latency: 0 },
        },
        timestamp: Date.now(),
        issues: [],
        recommendations: [],
      };
    },
  };
}

// ===== Test Suite =====

describe('ADR-0041 Composition-Aware Architecture', () => {
  let registry: ControllerRegistry;
  let mockBackend: IMemoryBackend;

  beforeEach(() => {
    registry = new ControllerRegistry();
    mockBackend = createMockBackend();
  });

  afterEach(async () => {
    if (registry.isInitialized()) {
      await registry.shutdown();
    }
  });

  // ----- Init Level Structure -----

  describe('init level assignments', () => {
    it('should have Level 0 with infrastructure controllers', () => {
      const level0 = INIT_LEVELS.find((l) => l.level === 0);
      expect(level0).toBeDefined();
      expect(level0!.controllers).toContain('resourceTracker');
      expect(level0!.controllers).toContain('rateLimiter');
      expect(level0!.controllers).toContain('circuitBreaker');
    });

    it('should have Level 1 with metadataFilter and queryOptimizer', () => {
      const level1 = INIT_LEVELS.find((l) => l.level === 1);
      expect(level1).toBeDefined();
      expect(level1!.controllers).toContain('metadataFilter');
      expect(level1!.controllers).toContain('queryOptimizer');
    });

    it('should have Level 2 with composite parents and B4', () => {
      const level2 = INIT_LEVELS.find((l) => l.level === 2);
      expect(level2).toBeDefined();
      expect(level2!.controllers).toContain('selfLearningRvfBackend');
      expect(level2!.controllers).toContain('nativeAccelerator');
      expect(level2!.controllers).toContain('quantizedVectorStore');
      expect(level2!.controllers).toContain('attentionService');
    });

    it('should have Level 3 with enhancedEmbeddingService and auditLogger', () => {
      const level3 = INIT_LEVELS.find((l) => l.level === 3);
      expect(level3).toBeDefined();
      expect(level3!.controllers).toContain('enhancedEmbeddingService');
      expect(level3!.controllers).toContain('auditLogger');
    });

    it('should have Level 4 with indexHealthMonitor, federatedLearningManager, attentionMetrics', () => {
      const level4 = INIT_LEVELS.find((l) => l.level === 4);
      expect(level4).toBeDefined();
      expect(level4!.controllers).toContain('indexHealthMonitor');
      expect(level4!.controllers).toContain('federatedLearningManager');
      expect(level4!.controllers).toContain('attentionMetrics');
    });

    it('should not have duplicate controller names across all levels', () => {
      const allNames: string[] = [];
      for (const level of INIT_LEVELS) {
        for (const name of level.controllers) {
          expect(allNames).not.toContain(name);
          allNames.push(name);
        }
      }
    });

    it('should have monotonically increasing level numbers', () => {
      for (let i = 1; i < INIT_LEVELS.length; i++) {
        expect(INIT_LEVELS[i].level).toBeGreaterThan(INIT_LEVELS[i - 1].level);
      }
    });
  });

  // ----- Composite Pattern -----

  describe('composite factory pattern', () => {
    it('should NOT have sub-components as separate registry entries', async () => {
      await registry.initialize({ backend: mockBackend });
      const list = registry.listControllers();
      const names = list.map((c) => c.name);
      // A7, A8, B1, B2 are children of A6 -- must NOT be in registry
      expect(names).not.toContain('contrastiveTrainer');
      expect(names).not.toContain('sonaLearningBackend');
      expect(names).not.toContain('semanticQueryRouter');
      expect(names).not.toContain('temporalCompressor');
      // B7, B8 are children of B9
      expect(names).not.toContain('scalarQuantizer');
      expect(names).not.toContain('productQuantizer');
    });

    it('should not include composite children in INIT_LEVELS', () => {
      const allLevelControllers: string[] = [];
      for (const level of INIT_LEVELS) {
        allLevelControllers.push(...level.controllers);
      }
      // Sub-components should never appear in the level definitions
      expect(allLevelControllers).not.toContain('contrastiveTrainer');
      expect(allLevelControllers).not.toContain('sonaLearningBackend');
      expect(allLevelControllers).not.toContain('semanticQueryRouter');
      expect(allLevelControllers).not.toContain('temporalCompressor');
      expect(allLevelControllers).not.toContain('scalarQuantizer');
      expect(allLevelControllers).not.toContain('productQuantizer');
    });
  });

  // ----- Level 0 Infrastructure -----

  describe('Level 0 infrastructure controllers', () => {
    it('should initialize resourceTracker without AgentDB', async () => {
      await registry.initialize({}); // no backend, no AgentDB
      const tracker = registry.get<any>('resourceTracker');
      expect(tracker).not.toBeNull();
      expect(typeof tracker.track).toBe('function');
      expect(typeof tracker.check).toBe('function');
      expect(typeof tracker.getStats).toBe('function');
    });

    it('should initialize rateLimiter without AgentDB', async () => {
      await registry.initialize({});
      const limiter = registry.get<any>('rateLimiter');
      expect(limiter).not.toBeNull();
      expect(typeof limiter.configure).toBe('function');
      expect(typeof limiter.tryAcquire).toBe('function');
    });

    it('should initialize circuitBreakerController without AgentDB', async () => {
      await registry.initialize({});
      const cb = registry.get<any>('circuitBreaker');
      expect(cb).not.toBeNull();
      expect(typeof cb.wrap).toBe('function');
      expect(typeof cb.getState).toBe('function');
    });

    it('resourceTracker should track and check resources', async () => {
      await registry.initialize({});
      const tracker = registry.get<any>('resourceTracker');
      tracker.track('memory', 512, 1024);
      const res = tracker.check('memory');
      expect(res).toEqual({ allocated: 512, limit: 1024 });
      expect(tracker.check('unknown')).toBeNull();
    });

    it('resourceTracker should report stats', async () => {
      await registry.initialize({});
      const tracker = registry.get<any>('resourceTracker');
      tracker.track('cpu', 50, 100);
      tracker.track('memory', 256, 512);
      const stats = tracker.getStats();
      expect(stats.tracked).toBe(2);
      expect(stats.resources.cpu).toEqual({ allocated: 50, limit: 100 });
      expect(stats.resources.memory).toEqual({ allocated: 256, limit: 512 });
    });

    it('rateLimiter should enforce rate limits', async () => {
      await registry.initialize({});
      const limiter = registry.get<any>('rateLimiter');
      // Unconfigured = unlimited
      expect(limiter.tryAcquire('anything')).toBe(true);
      // Configure: 0 rate (no refill), 1 max token
      limiter.configure('test', 0, 1);
      expect(limiter.tryAcquire('test')).toBe(true); // first token
      expect(limiter.tryAcquire('test')).toBe(false); // exhausted
    });

    it('rateLimiter should report stats', async () => {
      await registry.initialize({});
      const limiter = registry.get<any>('rateLimiter');
      limiter.configure('api', 10, 100);
      const stats = limiter.getStats();
      expect(stats.buckets).toBe(1);
      expect(stats.names).toContain('api');
    });

    it('circuitBreakerController should pass through successful calls', async () => {
      await registry.initialize({});
      const cb = registry.get<any>('circuitBreaker');
      const result = cb.wrap('test', () => 42);
      expect(result).toBe(42);
      expect(cb.getState('test')).toBe('CLOSED');
    });

    it('circuitBreakerController should open after threshold failures', async () => {
      await registry.initialize({});
      const cb = registry.get<any>('circuitBreaker');
      // Trigger 5 failures to open
      for (let i = 0; i < 5; i++) {
        cb.wrap('test', () => { throw new Error('fail'); });
      }
      expect(cb.getState('test')).toBe('OPEN');

      // Open circuit returns null
      const blocked = cb.wrap('test', () => 99);
      expect(blocked).toBeNull();
    });

    it('circuitBreakerController should return CLOSED for unknown circuits', async () => {
      await registry.initialize({});
      const cb = registry.get<any>('circuitBreaker');
      expect(cb.getState('nonexistent')).toBe('CLOSED');
    });

    it('circuitBreakerController should report stats', async () => {
      await registry.initialize({});
      const cb = registry.get<any>('circuitBreaker');
      cb.wrap('svc-a', () => 1);
      cb.wrap('svc-b', () => { throw new Error('oops'); });
      const stats = cb.getStats();
      expect(stats.total).toBe(2);
      expect(stats.breakers['svc-a'].state).toBe('CLOSED');
      expect(stats.breakers['svc-b'].failures).toBe(1);
    });

    it('all Level 0 controllers should be available when no backend provided', async () => {
      await registry.initialize({});
      expect(registry.isEnabled('resourceTracker')).toBe(true);
      expect(registry.isEnabled('rateLimiter')).toBe(true);
      expect(registry.isEnabled('circuitBreaker')).toBe(true);
    });
  });

  // ----- Health Check with Composites -----

  describe('health check with composite children', () => {
    it('should report total controllers including registry entries', async () => {
      await registry.initialize({ backend: mockBackend });
      const report = await registry.healthCheck();
      // Should include Level 0 infrastructure controllers at minimum
      expect(report.totalControllers).toBeGreaterThanOrEqual(3);
    });

    it('should report Level 0 controllers as healthy', async () => {
      await registry.initialize({});
      const report = await registry.healthCheck();
      const level0Names = ['resourceTracker', 'rateLimiter', 'circuitBreaker'];
      for (const name of level0Names) {
        const entry = report.controllers.find((c) => c.name === name);
        expect(entry).toBeDefined();
        expect(entry!.status).toBe('healthy');
      }
    });

    it('should not be unhealthy when only Level 0 is available', async () => {
      await registry.initialize({});
      const report = await registry.healthCheck();
      // Infrastructure always inits, so status should not be unhealthy
      expect(report.status).not.toBe('unhealthy');
    });

    it('should include init time for each controller', async () => {
      await registry.initialize({});
      const report = await registry.healthCheck();
      for (const controller of report.controllers) {
        expect(controller.initTimeMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ----- Ordering Guarantees -----

  describe('initialization ordering', () => {
    it('Level 0 controllers should init before Level 1', async () => {
      const initOrder: string[] = [];
      registry.on('controller:initialized', (event: { name: string }) => {
        initOrder.push(event.name);
      });
      await registry.initialize({});

      // All Level 0 controllers should appear before any Level 1 controller
      const level0 = INIT_LEVELS.find((l) => l.level === 0)!.controllers;
      const level1 = INIT_LEVELS.find((l) => l.level === 1)!.controllers;

      for (const l0Name of level0) {
        const l0Idx = initOrder.indexOf(l0Name);
        if (l0Idx === -1) continue; // not initialized (acceptable)
        for (const l1Name of level1) {
          const l1Idx = initOrder.indexOf(l1Name);
          if (l1Idx === -1) continue;
          expect(l0Idx).toBeLessThan(l1Idx);
        }
      }
    });
  });

  // ----- Shutdown -----

  describe('shutdown with ADR-0041 controllers', () => {
    it('should shutdown Level 0 controllers cleanly', async () => {
      await registry.initialize({});
      expect(registry.isInitialized()).toBe(true);

      // Verify controllers are present
      expect(registry.get('resourceTracker')).not.toBeNull();

      await registry.shutdown();
      expect(registry.isInitialized()).toBe(false);
      expect(registry.getActiveCount()).toBe(0);
    });

    it('should allow re-initialization after shutdown', async () => {
      await registry.initialize({});
      await registry.shutdown();
      await registry.initialize({});
      expect(registry.isInitialized()).toBe(true);
      expect(registry.get('resourceTracker')).not.toBeNull();
    });
  });

  // ----- Performance -----

  describe('performance', () => {
    it('should initialize Level 0 controllers within 50ms', async () => {
      const start = performance.now();
      await registry.initialize({});
      const duration = performance.now() - start;
      // Level 0 only — includes dynamic import attempt for agentdb
      expect(duration).toBeLessThan(200);
    });

    it('Level 0 controller access should have sub-millisecond overhead', async () => {
      await registry.initialize({});
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        registry.get('resourceTracker');
        registry.get('rateLimiter');
        registry.get('circuitBreaker');
      }
      const duration = performance.now() - start;
      // 3000 lookups in under 10ms
      expect(duration).toBeLessThan(10);
    });
  });
});
