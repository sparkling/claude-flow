/**
 * ADR-0301 — Fork marketplace identity split (`sparkleideas`).
 *
 * Claude Code marketplace names are machine-global; a same-name
 * `marketplace add` replaces the prior registration. Upstream
 * (`ruvnet/ruflo`) and this fork (`sparkling/ruflo`) both declared
 * `name: "ruflo"`, so an upstream install on 2026-06-04 silently hijacked
 * the fork's marketplace and stranded its installed plugins. ADR-0301
 * renames the fork marketplace to `sparkleideas` and makes init emit Claude
 * Code's native team-marketplace settings so a generated project installs
 * its plugins on folder trust with zero manual `/plugin` commands.
 *
 * Guards:
 *   1. `.claude-plugin/marketplace.json` declares `name: "sparkleideas"`
 *      (NEVER `ruflo` — that name belongs to upstream now).
 *   2. `generateSettings()` emits `extraKnownMarketplaces.sparkleideas`
 *      pointing at `github:sparkling/ruflo`.
 *   3. `generateSettings()` `enabledPlugins` keys mirror the marketplace
 *      manifest EXACTLY (drift gate for the pinned list in
 *      settings-generator.ts), all `@sparkleideas`, default-ON except
 *      `ruflo-security-audit`.
 *   4. No generator emits `@ruflo` plugin references; the statusline
 *      version probe targets `marketplaces/sparkleideas`, not the
 *      upstream-owned `marketplaces/ruflo` (which would report upstream's
 *      version — a lie).
 *   5. The permissions allow-list uses valid MCP rule syntax
 *      (`mcp__<server>__*`); the `mcp__<server>__:*` form is invalid and
 *      silently skipped by Claude Code (/doctor warns), leaving MCP tools
 *      un-allowlisted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateSettings } from '../../src/init/settings-generator.js';
import { generateClaudeMd } from '../../src/init/claudemd-generator.js';
import type { InitOptions } from '../../src/init/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_SRC = resolve(__dirname, '../../src');
const REPO_ROOT = resolve(__dirname, '../../../../..');

const MARKETPLACE_NAME = 'sparkleideas';
const MARKETPLACE_REPO = 'sparkling/ruflo';

function manifestPluginNames(): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf-8'),
  );
  return manifest.plugins.map((p: { name: string }) => p.name);
}

// Minimal InitOptions for generateSettings(): components all off (skips the
// hooks/statusline blocks), runtime stubbed for the claudeFlow section.
function buildOptions(): InitOptions {
  return {
    components: { settings: false, helpers: false, statusline: false },
    statusline: { enabled: false },
    runtime: {
      topology: 'hierarchical-mesh',
      maxAgents: 15,
      memoryBackend: 'hybrid',
      enableHNSW: true,
      enableNeural: true,
      enableLearningBridge: true,
      enableMemoryGraph: true,
      enableAgentScopes: true,
      similarityThreshold: 0.7,
      claudeMdTemplate: 'standard',
    },
    mcp: {
      claudeFlow: true,
      ruvSwarm: true,
      flowNexus: false,
      autoStart: true,
      port: 3000,
    },
  } as any;
}

type GeneratedSettings = {
  permissions: { allow: string[]; deny: string[] };
  extraKnownMarketplaces: Record<
    string,
    { source: { source: string; repo: string } }
  >;
  enabledPlugins: Record<string, boolean>;
};

describe('ADR-0301 — fork marketplace identity (sparkleideas)', () => {
  describe('marketplace manifest', () => {
    it(`.claude-plugin/marketplace.json is named "${MARKETPLACE_NAME}", not upstream's "ruflo"`, () => {
      const manifest = JSON.parse(
        readFileSync(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf-8'),
      );
      expect(manifest.name).toBe(MARKETPLACE_NAME);
      expect(manifest.owner?.name).toBe('sparkling');
    });
  });

  describe('settings-generator emits the team-marketplace block', () => {
    const settings = generateSettings(buildOptions()) as GeneratedSettings;

    it(`extraKnownMarketplaces.${MARKETPLACE_NAME} points at github:${MARKETPLACE_REPO}`, () => {
      const entry = settings.extraKnownMarketplaces?.[MARKETPLACE_NAME];
      expect(entry).toBeDefined();
      expect(entry.source).toEqual({ source: 'github', repo: MARKETPLACE_REPO });
      // No entry may claim upstream's name or repo.
      expect(settings.extraKnownMarketplaces.ruflo).toBeUndefined();
      const repos = Object.values(settings.extraKnownMarketplaces).map(
        (m) => m.source.repo,
      );
      expect(repos).not.toContain('ruvnet/ruflo');
    });

    it('enabledPlugins keys mirror the marketplace manifest exactly (drift gate)', () => {
      const expected = manifestPluginNames()
        .map((p) => `${p}@${MARKETPLACE_NAME}`)
        .sort();
      const actual = Object.keys(settings.enabledPlugins).sort();
      expect(actual).toEqual(expected);
    });

    it('all plugins default ON except ruflo-security-audit', () => {
      for (const [key, enabled] of Object.entries(settings.enabledPlugins)) {
        if (key === `ruflo-security-audit@${MARKETPLACE_NAME}`) {
          expect(enabled, key).toBe(false);
        } else {
          expect(enabled, key).toBe(true);
        }
      }
    });

    it('no enabledPlugins key references the upstream-owned @ruflo marketplace', () => {
      for (const key of Object.keys(settings.enabledPlugins)) {
        expect(key).not.toMatch(/@ruflo$/);
      }
    });
  });

  describe('no generator emits @ruflo plugin references', () => {
    it('CLAUDE.md (standard + full) install hints use @sparkleideas', () => {
      for (const template of ['standard', 'full'] as const) {
        const md = generateClaudeMd(buildOptions(), template);
        expect(md).not.toContain('@ruflo');
        if (md.includes('/plugin install')) {
          expect(md).toContain(`@${MARKETPLACE_NAME}`);
        }
      }
    });

    it('statusline-generator probes marketplaces/sparkleideas, never marketplaces/ruflo', () => {
      const src = readFileSync(
        resolve(CLI_SRC, 'init/statusline-generator.ts'),
        'utf-8',
      );
      expect(src).not.toMatch(/marketplaces['"/, ]+ruflo\b/);
      expect(src).toContain(`'${MARKETPLACE_NAME}'`);
    });
  });

  describe('permissions allow-list uses valid MCP rule syntax', () => {
    const settings = generateSettings(buildOptions()) as GeneratedSettings;

    it('contains the server-wide MCP glob in the tool position', () => {
      expect(settings.permissions.allow).toContain('mcp__claude-flow__*');
    });

    it('contains NO mcp__<server>__:* rules (invalid — silently skipped)', () => {
      for (const rule of settings.permissions.allow) {
        expect(rule, `invalid MCP allow-rule syntax: ${rule}`).not.toMatch(
          /^mcp__.*:\*$/,
        );
      }
    });
  });
});
