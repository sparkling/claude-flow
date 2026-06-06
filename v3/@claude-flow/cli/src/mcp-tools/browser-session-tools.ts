/**
 * Browser Session Lifecycle MCP Tools (ADR-0001 ruflo-browser §7).
 *
 * Five lifecycle tools that wrap the 23 raw `browser_*` interaction tools
 * with RVF cognitive containers, ruvector trajectory recording, AgentDB
 * indexing, and AIDefence gates. Implements the contract from
 * `plugins/ruflo-browser/docs/adrs/0001-browser-skills-architecture.md`.
 *
 * Design notes:
 *   - These tools orchestrate at the *primitive* level — they shell out to
 *     the existing `agent-browser` CLI (for browser actions), `ruvector` CLI
 *     (for trajectory hooks + RVF), and the bridged `memory` namespace (for
 *     AgentDB index). They do not inline a replay engine; replay
 *     enumerates trajectory steps and returns them for the caller to dispatch.
 *   - Pinned to ruvector@0.2.25 to match `ruflo-ruvector` ADR-0001.
 *   - Best-effort: missing dependencies (no `ruvector`, no `agent-browser`,
 *     no AgentDB controller) degrade gracefully with a structured error
 *     rather than a process crash.
 */

import type { MCPTool, MCPToolResult } from './types.js';
import { findProjectRoot } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';
// ADR-0298 R3a: persist/read the browser-session AgentDB namespaces through the
// in-process memory router — the SAME path the memory_* MCP tools use — instead
// of shelling `npx @claude-flow/cli@latest memory …` per call. The shelled CLI
// paid a ~26-31× cold-boot penalty (34.7-41s warm) on every browser-session
// memory op (the C6 DA F1 finding), which masqueraded as harness timeouts.
import { routeMemoryOp, ensureRouter } from '../memory/memory-router.js';

/**
 * ADR-0298 R3a: store a value in a browser-session AgentDB namespace IN-PROCESS.
 * Fail-loud — the caller decides whether a failure is fatal (the session index
 * is best-effort; the RVF container is the source of truth).
 */
async function memoryStoreInProcess(
  namespace: string,
  key: string,
  value: string,
): Promise<{ success: boolean; error?: string }> {
  await ensureRouter();
  const res = await routeMemoryOp({ type: 'store', key, value, namespace, generateEmbedding: true });
  return { success: !!res.success, error: res.success ? undefined : String((res as Record<string, unknown>).error ?? 'store failed') };
}

/**
 * ADR-0298 R3a: read a value from a browser-session AgentDB namespace IN-PROCESS
 * by exact (namespace, key). Returns the stored content string on a hit, or a
 * structured miss; throws on a real router error (fail-loud per R3a).
 */
async function memoryRetrieveInProcess(
  namespace: string,
  key: string,
): Promise<{ found: boolean; content?: string }> {
  await ensureRouter();
  const res = await routeMemoryOp({ type: 'get', key, namespace });
  const entry = (res as Record<string, unknown>).entry as Record<string, unknown> | undefined;
  if (res.found && entry) {
    const content = entry.content;
    return { found: true, content: typeof content === 'string' ? content : JSON.stringify(content) };
  }
  return { found: false };
}

const RUVECTOR_PIN = 'ruvector@0.2.25';
const RVF_DIR_DEFAULT = '.ruflo/browser-sessions';
// ADR-0298 R1: the RVF cognitive container for a browser session. 768 to match
// the fork's mpnet embedding model (ADR-0052); the container itself holds
// trajectory segments, not embeddings written by these tools, so any positive
// dimension is valid — 768 keeps it consistent with the fork's vector axis.
const RVF_DIMENSION = 768;

interface ShellResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

// ADR-0298 R1 robustness: a stable, per-user npx cache so `npx -y <pkg>`
// installs ONCE and is reused across calls/sessions (not re-fetched per call),
// marked .metadata_never_index so macOS Spotlight does not scan a freshly-
// installed binary mid-exec — the cause of transient status-126 ("cannot
// execute") for ruvector/agent-browser under heavy churn + concurrent load.
// Memoized; best-effort (null → fall back to the ambient default cache). No-op
// on Linux (the marker is simply ignored).
let _npxCacheDir: string | null | undefined;
async function stableNpxCacheDir(): Promise<string | null> {
  if (_npxCacheDir !== undefined) return _npxCacheDir;
  try {
    const os = await import('node:os');
    const path = await import('node:path');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = path.join(os.homedir(), '.ruflo', 'npx-cache');
    mkdirSync(dir, { recursive: true });
    try { writeFileSync(path.join(dir, '.metadata_never_index'), ''); } catch { /* best-effort */ }
    _npxCacheDir = dir;
  } catch {
    _npxCacheDir = null;
  }
  return _npxCacheDir;
}

async function shell(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<ShellResult> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // npx shell-outs (ruvector, agent-browser) install fresh binaries; route them
  // through the stable Spotlight-protected cache so they install once + are
  // not scanned mid-exec (ADR-0298 R1).
  let env: NodeJS.ProcessEnv | undefined;
  if (cmd === 'npx') {
    const cache = await stableNpxCacheDir();
    if (cache) env = { ...process.env, npm_config_cache: cache };
  }
  try {
    const { stdout, stderr } = await run(cmd, args, {
      timeout: opts.timeout ?? 30000,
      encoding: 'utf-8',
      ...(env ? { env } : {}),
    });
    return { success: true, stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      success: false,
      error: err.code === 'ENOENT' ? `command not found: ${cmd}` : err.message,
      stdout: err.stdout,
      stderr: err.stderr,
    };
  }
}

async function ensureSessionsDir(): Promise<string> {
  const { mkdir } = await import('node:fs/promises');
  const path = await import('node:path');
  // ADR-0100: anchor RVF browser sessions on findProjectRoot() so the
  // .ruflo/browser-sessions/ tree lands at the project root regardless
  // of which subdirectory the agent's cwd happens to be in.
  const dir = path.resolve(findProjectRoot(), RVF_DIR_DEFAULT);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeSessionId(taskSlug: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slug = taskSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'session';
  return `${stamp}-${slug}`;
}

function ok(payload: Record<string, unknown>): MCPToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }, null, 2) }] };
}

function fail(error: string, extra: Record<string, unknown> = {}): MCPToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error, ...extra }, null, 2) }],
    isError: true,
  };
}

export const browserSessionTools: MCPTool[] = [
  // ==========================================================================
  // browser_session_record — open a recorded session
  // ==========================================================================
  {
    name: 'browser_session_record',
    description: 'Open a named, traced browser session: allocate an RVF cognitive container, begin a ruvector trajectory, then open the URL via agent-browser. Returns the session id and rvf path.',
    category: 'browser-session',
    tags: ['session', 'rvf', 'trajectory', 'lifecycle'],
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL to open' },
        task: { type: 'string', description: 'Human-readable task description (recorded in trajectory)' },
        session: { type: 'string', description: 'Optional explicit session id; otherwise auto-generated' },
        rvf_dir: { type: 'string', description: 'Override the default .ruflo/browser-sessions directory' },
      },
      required: ['url', 'task'],
    },
    handler: async (input) => {
      const vUrl = validateText(input.url as string, 'url');
      if (!vUrl.valid) return fail(vUrl.error || 'invalid url');
      const vTask = validateText(input.task as string, 'task');
      if (!vTask.valid) return fail(vTask.error || 'invalid task');
      const path = await import('node:path');

      const explicitSession = input.session as string | undefined;
      if (explicitSession) {
        const v = validateIdentifier(explicitSession, 'session');
        if (!v.valid) return fail(v.error || 'invalid session');
      }
      const sessionId = explicitSession ?? makeSessionId(input.task as string);
      const dir = (input.rvf_dir as string | undefined) ?? (await ensureSessionsDir());
      const rvfPath = path.join(dir, `${sessionId}.rvf`);

      // 1. RVF allocate.
      // ADR-0298 R1: ruvector@0.2.25 `rvf create <path>` takes a POSITIONAL path
      // and a REQUIRED `-d/--dimension <n>`; there is no `--kind` flag. The
      // fork's hand-port (Batch S) captured a pre-Issue-#2015 form (`--kind
      // browser-session`, no `-d`) that ruvector rejects with exit 1
      // ("required option '-d, --dimension' not specified") — record died at
      // step-1, one step earlier than upstream. Fix: drop `--kind`, pass
      // `--dimension <RVF_DIMENSION>`.
      const rvf = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'create', rvfPath, '--dimension', String(RVF_DIMENSION)], { timeout: 60000 });
      if (!rvf.success) return fail('rvf create failed', { detail: rvf.error, stderr: rvf.stderr, sessionId, rvfPath });

      // 2. trajectory-begin.
      // ADR-0298 R1 (UPSTREAM-BROKEN-SHARED, same skew class as ADR-0293 D1):
      // ruvector@0.2.25 `hooks trajectory-begin` takes `-c/--context` (required)
      // and `-a/--agent`; it has NO `--session-id`/`--task`. The fork passed the
      // stale `--session-id`/`--task` shape, which ruvector rejects with exit 1.
      // Map the human task into `--context` and tag the agent `browser-session`.
      // NB: ruvector's trajectory state is process-local (it does not reload an
      // active trajectory across separate CLI invocations), so step/end below
      // run as their own processes and emit a soft "no active trajectory" notice
      // while still exiting 0 — the RVF container (compacted in browser_session_end
      // and read back by browser_session_replay) is the durable source of truth.
      const tb = await shell('npx', ['-y', RUVECTOR_PIN, 'hooks', 'trajectory-begin', '--context', input.task as string, '--agent', 'browser-session']);
      if (!tb.success) return fail('trajectory-begin failed', { detail: tb.error, stderr: tb.stderr, sessionId, rvfPath });

      // 3. browser_open via agent-browser
      const bo = await shell('agent-browser', ['--session', sessionId, '--json', 'open', input.url as string], { timeout: 30000 });
      if (!bo.success) {
        const npxBo = await shell('npx', ['--yes', 'agent-browser', '--session', sessionId, '--json', 'open', input.url as string], { timeout: 60000 });
        if (!npxBo.success) {
          return fail('browser open failed', { detail: npxBo.error, stderr: npxBo.stderr, sessionId, rvfPath });
        }
      }

      // 4. log the open as the first trajectory step.
      // ADR-0298 R1: ruvector@0.2.25 `hooks trajectory-step` takes `-a/--action`
      // (required) and `-r/--result`; it has NO `--session-id`/`--args`. The URL
      // is already captured in the RVF container + the response envelope, so the
      // step records action+result only. Best-effort (return value unchecked) —
      // the open already succeeded above and the RVF container is authoritative.
      await shell('npx', ['-y', RUVECTOR_PIN, 'hooks', 'trajectory-step',
        '--action', 'browser_open',
        '--result', 'ok']);

      return ok({
        sessionId,
        rvfPath,
        url: input.url,
        task: input.task,
        ruvectorPin: RUVECTOR_PIN,
      });
    },
  },

  // ==========================================================================
  // browser_session_end — commit a recorded session
  // ==========================================================================
  {
    name: 'browser_session_end',
    description: 'End a recorded browser session: trajectory-end with verdict, rvf compact, AIDefence pre-store gate (best-effort), and AgentDB index in the browser-sessions namespace.',
    category: 'browser-session',
    tags: ['session', 'rvf', 'trajectory', 'lifecycle', 'agentdb'],
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id (returned from browser_session_record)' },
        rvf_path: { type: 'string', description: 'Path to the .rvf container' },
        verdict: { type: 'string', enum: ['pass', 'fail', 'partial'], description: 'Outcome verdict' },
        host: { type: 'string', description: 'Host (for namespace key); inferred from manifest if omitted' },
        task: { type: 'string', description: 'Task description (recorded for index)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for AgentDB index' },
      },
      required: ['session', 'rvf_path', 'verdict'],
    },
    handler: async (input) => {
      const vS = validateIdentifier(input.session as string, 'session');
      if (!vS.valid) return fail(vS.error || 'invalid session');
      const verdict = input.verdict as string;
      if (!['pass', 'fail', 'partial'].includes(verdict)) return fail(`invalid verdict: ${verdict}`);

      // 1. trajectory-end.
      // ADR-0298 R1: ruvector@0.2.25 `hooks trajectory-end` takes `--success`
      // (boolean flag) and `--quality <0-1>`; it has NO `--session-id`/`--verdict`.
      // Map the fork's verdict onto that shape: pass → --success --quality 1,
      // partial → --quality 0.5, fail → --quality 0. (ruvector internally also
      // pins --success to quality 0.8, but the explicit --quality keeps the
      // intent legible.) ruvector exits 0 here even when its process-local
      // trajectory state has no active trajectory to close (the cross-process
      // limitation noted in browser_session_record) — so the `te.success`
      // gate reflects "the end hook ran", and the rvf compact below is the
      // operation that actually finalizes the durable container.
      const teArgs = ['-y', RUVECTOR_PIN, 'hooks', 'trajectory-end',
        '--quality', verdict === 'pass' ? '1' : verdict === 'partial' ? '0.5' : '0'];
      if (verdict === 'pass') teArgs.push('--success');
      const te = await shell('npx', teArgs);
      if (!te.success) return fail('trajectory-end failed', { detail: te.error, stderr: te.stderr });

      // 2. rvf compact
      const compact = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'compact', input.rvf_path as string]);
      if (!compact.success) return fail('rvf compact failed', { detail: compact.error, stderr: compact.stderr });

      // 3. AgentDB index — best-effort, IN-PROCESS (ADR-0298 R3a: no per-call
      // CLI cold-boot). Index failure is non-fatal — the RVF container is the
      // source of truth.
      const indexValue = JSON.stringify({
        rvf_id: input.session,
        rvf_path: input.rvf_path,
        host: input.host ?? null,
        task: input.task ?? null,
        verdict,
        tags: input.tags ?? [],
        ended_at: new Date().toISOString(),
      });
      let idxOk = false;
      let idxError: string | undefined;
      try {
        const idx = await memoryStoreInProcess('browser-sessions', input.session as string, indexValue);
        idxOk = idx.success;
        idxError = idx.error;
      } catch (e) {
        // Non-fatal: surface the error in the envelope but still return ok —
        // the session's durable artifact is the compacted RVF container above.
        idxError = e instanceof Error ? e.message : String(e);
      }

      return ok({
        sessionId: input.session,
        rvfPath: input.rvf_path,
        verdict,
        indexed: idxOk,
        indexError: idxOk ? undefined : idxError,
      });
    },
  },

  // ==========================================================================
  // browser_session_replay — load a trajectory for caller-level dispatch
  // ==========================================================================
  {
    name: 'browser_session_replay',
    description: 'Load a recorded session trajectory and return its steps so the caller can dispatch them through the 23 browser_* tools. Does NOT itself drive the browser — replay execution is caller-orchestrated to keep this tool a primitive (ADR-0001 §7).',
    category: 'browser-session',
    tags: ['session', 'replay', 'trajectory', 'lifecycle'],
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Source session id to replay' },
        rvf_path: { type: 'string', description: 'Path to source .rvf container' },
        url_override: { type: 'string', description: 'Optional URL to use instead of the original' },
        derive: { type: 'boolean', description: 'Derive a new RVF child container for the replay run (default true)' },
      },
      required: ['session', 'rvf_path'],
    },
    handler: async (input) => {
      const vS = validateIdentifier(input.session as string, 'session');
      if (!vS.valid) return fail(vS.error || 'invalid session');

      // 1. Verify RVF container exists
      const status = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'status', input.rvf_path as string]);
      if (!status.success) return fail('rvf status failed', { detail: status.error, stderr: status.stderr });

      // 2. Derive child container if requested
      let replayId: string | null = null;
      let replayPath: string | null = null;
      const derive = input.derive !== false;
      if (derive) {
        const path = await import('node:path');
        const dir = path.dirname(input.rvf_path as string);
        replayId = `${input.session}-replay-${Date.now()}`;
        replayPath = path.join(dir, `${replayId}.rvf`);
        const dr = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'derive', input.rvf_path as string, replayPath]);
        if (!dr.success) return fail('rvf derive failed', { detail: dr.error, stderr: dr.stderr });
      }

      // 3. Surface the trajectory steps from the segments listing — the caller is
      //    expected to read trajectory.ndjson from the RVF container and dispatch.
      const segments = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'segments', input.rvf_path as string]);

      return ok({
        sourceSession: input.session,
        sourceRvfPath: input.rvf_path,
        replaySession: replayId,
        replayRvfPath: replayPath,
        urlOverride: input.url_override ?? null,
        rvfStatus: status.stdout?.slice(0, 4000) ?? null,
        rvfSegments: segments.stdout?.slice(0, 4000) ?? null,
        nextStep: 'Caller MUST: (a) read trajectory.ndjson from the source RVF container, (b) for each step, dispatch the matching browser_* MCP tool, (c) on selector miss, query browser-selectors AgentDB namespace and retry, (d) call browser_session_end with verdict aggregate.',
      });
    },
  },

  // ==========================================================================
  // browser_template_apply — fetch a stored template
  // ==========================================================================
  {
    name: 'browser_template_apply',
    description: 'Fetch a recipe from the browser-templates AgentDB namespace and return it for caller-level execution.',
    category: 'browser-session',
    tags: ['template', 'agentdb', 'extract'],
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Template name (key in browser-templates namespace)' },
      },
      required: ['name'],
    },
    handler: async (input) => {
      const vN = validateText(input.name as string, 'name');
      if (!vN.valid) return fail(vN.error || 'invalid name');
      // ADR-0298 R3a: read the template IN-PROCESS (no per-call CLI cold-boot).
      // A real router error fails loud; an honest miss returns found:false.
      let r: { found: boolean; content?: string };
      try {
        r = await memoryRetrieveInProcess('browser-templates', input.name as string);
      } catch (e) {
        return fail('template fetch failed', { detail: e instanceof Error ? e.message : String(e) });
      }
      return ok({
        templateName: input.name,
        found: r.found,
        recipe: r.found ? r.content : null,
        nextStep: r.found
          ? 'Caller dispatches the recipe via browser_* tools; persist updated selectors to browser-selectors on success.'
          : `No template named "${input.name}" in the browser-templates namespace.`,
      });
    },
  },

  // ==========================================================================
  // browser_cookie_use — fetch a vaulted cookie handle
  // ==========================================================================
  // ADR-0238 S1: description honesty — this tool does not run an AIDefence
  // scan. It reads whatever the `browser-cookies` namespace writer (e.g.
  // browser-login) stored. The convention is that the writer attaches a
  // vault_handle + expiry (+ optionally an aidefence_verdict the writer
  // computed); this tool surfaces whatever is there. It does NOT verify
  // the verdict exists or pre-scan returned content.
  {
    name: 'browser_cookie_use',
    description: 'Fetch a vault handle for a host from the browser-cookies AgentDB namespace. Raw cookie values are NEVER returned — only the opaque handle plus expiry. (Whether an AIDefence verdict is attached depends on the writer; this tool does not run a scan.)',
    category: 'browser-session',
    tags: ['cookie', 'agentdb', 'auth'],
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host (e.g. "example.com") to look up' },
      },
      required: ['host'],
    },
    handler: async (input) => {
      const vH = validateText(input.host as string, 'host');
      if (!vH.valid) return fail(vH.error || 'invalid host');
      // ADR-0298 R3a: read the vault handle IN-PROCESS (no per-call CLI
      // cold-boot). A real router error fails loud; an honest miss returns
      // found:false.
      let r: { found: boolean; content?: string };
      try {
        r = await memoryRetrieveInProcess('browser-cookies', input.host as string);
      } catch (e) {
        return fail('cookie lookup failed', { detail: e instanceof Error ? e.message : String(e) });
      }
      // The convention: the value blob includes a vault_handle, expiry, and
      // OPTIONALLY an aidefence_verdict attached by the writer (browser-login).
      // This tool surfaces whatever the writer stored; it does NOT run a scan
      // here (ADR-0238 S1 — no central-dispatch enforcement; caller-opt-in).
      // Raw values do not enter this namespace (browser-login is responsible).
      return ok({
        host: input.host,
        found: r.found,
        vault: r.found ? r.content : null,
        nextStep: r.found
          ? 'Caller mounts the handle via the browser runner; the raw cookie is materialized only inside the browser process, never returned to the model.'
          : `No vaulted cookie for host "${input.host}" in the browser-cookies namespace.`,
      });
    },
  },
];

export default browserSessionTools;
