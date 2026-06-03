/**
 * Phase 5 — FTS5 keyword index (ADR-125)
 *
 * Verifies the FTS5 wiring on the SQL backend:
 * - SQLiteBackend (better-sqlite3 — bundles FTS5 since 11.x)
 *
 * The SQLiteBackend test is conditional: better-sqlite3 is an optional
 * dependency. If it isn't installable in the current env, that test is
 * skipped.
 *
 * (The SqlJsBackend FTS5 coverage was removed with the sql.js fallback per
 * ADR-0086.)
 */

import { describe, it, expect } from 'vitest';
import { createDefaultEntry } from './types.js';

// Conditionally run the SQLiteBackend tests — better-sqlite3 is an optional
// dependency, so probe for it first.
async function probeBetterSqlite3(): Promise<boolean> {
  try {
    await import('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

describe('Phase 5 — SQLiteBackend FTS5 (better-sqlite3)', async () => {
  const hasBetterSqlite3 = await probeBetterSqlite3();
  const maybeIt = hasBetterSqlite3 ? it : it.skip;

  maybeIt('searchKeyword returns matching entries with FTS5 ranking', async () => {
    const { SQLiteBackend } = await import('./sqlite-backend.js');
    const backend = new SQLiteBackend({ databasePath: ':memory:' });
    await backend.initialize();

    for (let i = 0; i < 20; i++) {
      const entry = createDefaultEntry({
        key: `k-${i}`,
        content: i % 2 === 0
          ? `authentication patterns OAuth ${i}`
          : `database indexing strategies ${i}`,
      });
      await backend.store(entry);
    }

    const results = await (backend as any).searchKeyword('authentication', 10);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.entry.content.toLowerCase()).toContain('authentication');
    }

    await backend.shutdown();
  });

  maybeIt('searchKeyword stops finding entries after delete', async () => {
    const { SQLiteBackend } = await import('./sqlite-backend.js');
    const backend = new SQLiteBackend({ databasePath: ':memory:' });
    await backend.initialize();

    const entry = createDefaultEntry({ key: 'doomed', content: 'unique-marker' });
    await backend.store(entry);
    let results = await (backend as any).searchKeyword('unique-marker', 5);
    expect(results.length).toBe(1);
    await backend.delete(entry.id);
    results = await (backend as any).searchKeyword('unique-marker', 5);
    expect(results.length).toBe(0);

    await backend.shutdown();
  });
});
