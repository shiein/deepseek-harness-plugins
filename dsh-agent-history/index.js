/**
 * Agent History — Host half.
 *
 * Serves the local conversation history of every supported AI coding agent through a small
 * read-only JSON API, and reads the local session stores only when the browser asks for a refresh.
 *
 *   GET  /api/dsh-agent-history/snapshot   -> last snapshot (memory or last-scan.json, no reads)
 *   POST /api/dsh-agent-history/scan       -> run one scan and return the new snapshot
 *   GET  /api/dsh-agent-history/session    -> one session's messages (lazy transcript read)
 *   GET  /api/dsh-agent-history/timeline   -> one project's merged multi-agent message timeline
 *   POST /api/dsh-agent-history/launch     -> resume one session (native terminal / DSH GUI)
 *   GET  /api/dsh-agent-history/projects   -> folders the user opened (most recent first)
 *   POST /api/dsh-agent-history/projects/open | /projects/remove -> record / forget one folder
 *   GET  /api/dsh-agent-history/health     -> plugin/route diagnostics
 *
 * Mounted by the Cordis bundle row in cordis.patch.yml. The Client half (client.js) renders the
 * sidebar entry, the grouped conversation browser and the launch buttons.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSnapshot, readSessionViaProvider, runScan } from './host/scanner.js';
import { TranscriptReader, buildTimeline } from './host/transcript.js';
import { buildLaunchPlan, copyableCommand, launchInTerminal } from './host/launch.js';
import { projectKey } from './host/model.js';
import { OpenedProjects } from './host/opened-projects.js';

/** Cordis plugin name. */
export const name = 'agent-history';

/** Hard dependency: the browser HTTP carrier that serves the Web GUI this page renders in. */
export const inject = ['webServer'];

const ROUTES = {
  snapshot: '/api/dsh-agent-history/snapshot',
  scan: '/api/dsh-agent-history/scan',
  session: '/api/dsh-agent-history/session',
  timeline: '/api/dsh-agent-history/timeline',
  launch: '/api/dsh-agent-history/launch',
  health: '/api/dsh-agent-history/health',
  projects: '/api/dsh-agent-history/projects',
  projectsOpen: '/api/dsh-agent-history/projects/open',
  projectsRemove: '/api/dsh-agent-history/projects/remove',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(res, status, body) {
  try {
    res.writeHead(status, JSON_HEADERS);
    res.end(JSON.stringify(body));
  } catch {
    // Socket may already be gone.
  }
}

/**
 * Loopback trust fence: this is a local-machine history view, so only requests that arrived on a
 * loopback socket with a loopback Host header are served.
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress || '';
  const loopbackAddress =
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.') ||
    address === '::ffff:7f00:1';
  if (!loopbackAddress) return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostname = '';
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!(hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname.startsWith('127.'))) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

/** @param {Record<string, unknown>} [config] @returns {string} */
function resolveDataDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir.trim() !== '') return config.dataDir.trim();
  if (process.env.DSH_AGENT_HISTORY_DATA_DIR) return process.env.DSH_AGENT_HISTORY_DATA_DIR;
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'agent-history');
}

/** @param {import('node:http').IncomingMessage} request @returns {URL} */
function requestUrl(request) {
  try {
    return new URL(request.url || '/', 'http://127.0.0.1');
  } catch {
    return new URL('http://127.0.0.1/');
  }
}

/** @param {import('node:http').IncomingMessage} request @returns {Promise<any>} */
function readJsonBody(request) {
  return new Promise((resolve) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    request.on('error', () => resolve(null));
  });
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config);
  /** @type {import('./host/scanner.js').Snapshot|null} */
  let snapshot = null;
  let snapshotLoadAttempted = false;
  /** @type {Promise<{snapshot: import('./host/scanner.js').Snapshot}>|null} */
  let scanning = null;

  const logger = typeof ctx.logger?.info === 'function' ? ctx.logger : null;
  const opened = new OpenedProjects(dataDir);

  /** Shared guard + error envelope for the small JSON routes. */
  const jsonRoute = (path, method, run) => ({
    kind: 'exact',
    path,
    handler: async (request, response) => {
      if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
      if (request.method !== method) return writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
      try {
        const body = method === 'POST' ? await readJsonBody(request) : {};
        if (body === null) return writeJson(response, 400, { ok: false, error: 'request body must be JSON (≤ 1 MB)' });
        writeJson(response, 200, { ok: true, ...(await run(body, request)) });
      } catch (error) {
        const status = Number(error?.status) || 500;
        writeJson(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  const reader = new TranscriptReader({
    read: (session, signal) => readSessionViaProvider(dataDir, config, session, signal),
  });

  /** Load the last persisted snapshot once (never scans). */
  async function getSnapshot() {
    if (snapshot !== null) return snapshot;
    if (!snapshotLoadAttempted) {
      snapshotLoadAttempted = true;
      snapshot = await loadSnapshot(dataDir);
    }
    return snapshot;
  }

  /** Run (or join) one scan. */
  function ensureScan() {
    if (scanning !== null) return scanning;
    scanning = (async () => {
      const result = await runScan({ dataDir, config, signal: new AbortController().signal });
      snapshot = result;
      reader.clear();
      return { snapshot: result };
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  }

  /** @param {string} id */
  async function findSession(id) {
    const current = await getSnapshot();
    if (!current) return null;
    return current.sessions.find((session) => session.id === id) || null;
  }

  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const routes = [
    {
      kind: 'exact',
      path: ROUTES.snapshot,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
        if (request.method !== 'GET') return writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
        try {
          const current = await getSnapshot();
          writeJson(response, 200, { ok: true, scanning: scanning !== null, dataDir, snapshot: current });
        } catch (error) {
          writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.scan,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
        if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
        try {
          const started = Date.now();
          const { snapshot: next } = await ensureScan();
          logger?.info?.(`[agent-history] scan finished in ${Date.now() - started}ms: ${next.totals.sessions} sessions, ${next.totals.agents} agents`);
          writeJson(response, 200, { ok: true, scanning: false, dataDir, snapshot: next });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger?.warn?.(`[agent-history] scan failed: ${message}`);
          writeJson(response, 500, { ok: false, scanning: false, error: message });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.session,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
        if (request.method !== 'GET') return writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
        const url = requestUrl(request);
        const id = url.searchParams.get('id') || '';
        const session = await findSession(id);
        if (!session) return writeJson(response, 404, { ok: false, error: 'unknown session' });
        try {
          const entry = await reader.get(session, new AbortController().signal);
          writeJson(response, 200, { ok: true, session, supported: entry.supported, messages: entry.messages });
        } catch (error) {
          writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.timeline,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
        if (request.method !== 'GET') return writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
        const current = await getSnapshot();
        if (!current) return writeJson(response, 200, { ok: true, events: [], total: 0, nextCursor: null, sessions: [] });
        const url = requestUrl(request);
        const key = url.searchParams.get('project') || '';
        const agentFilter = url.searchParams.get('agent') || '';
        const idsParam = url.searchParams.get('ids') || '';
        const limit = Number(url.searchParams.get('limit') || '200');
        const cursor = url.searchParams.get('cursor') || '';
        const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
        const role = url.searchParams.get('role') || 'all';
        const query = (url.searchParams.get('q') || '').slice(0, 200);
        const idFilter = idsParam === '' ? null : new Set(idsParam.split(',').slice(0, 400).filter((id) => id !== ''));
        const matching = current.sessions
          .filter((session) => (idFilter ? idFilter.has(session.id) : projectKey(session.projectPath) === key))
          .filter((session) => agentFilter === '' || session.agentId === agentFilter)
          .filter((session) => session.messages > 0)
          .sort((a, b) => a.startedAt - b.startedAt);
        // Bound the merge: a project with hundreds of sessions would otherwise read every
        // transcript for one page. Keep the most recently active sessions, then restore the
        // chronological order the timeline is supposed to show.
        const requestedSessions = Number(url.searchParams.get('sessions') || '120');
        const sessionCap = Number.isFinite(requestedSessions) ? Math.max(1, Math.min(400, Math.round(requestedSessions))) : 120;
        const chosen = matching.length > sessionCap
          ? [...matching].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, sessionCap).sort((a, b) => a.startedAt - b.startedAt)
          : matching;
        try {
          const abort = new AbortController();
          const loaded = await mapWithConcurrency(chosen, 4, async (session) => {
            const entry = await reader.getForTimeline(session, abort.signal);
            return { session, messages: entry.messages };
          });
          const timed = buildTimeline(loaded.filter(Boolean), { limit, cursor, order, role, query });
          writeJson(response, 200, {
            ok: true,
            events: timed.events,
            total: timed.total,
            nextCursor: timed.nextCursor,
            cursorLost: timed.cursorLost,
            order,
            sessionsTotal: matching.length,
            sessionsIncluded: chosen.length,
            sessions: chosen.map((session) => ({ id: session.id, title: session.title, agentId: session.agentId })),
          });
        } catch (error) {
          writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.launch,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
        if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
        const body = await readJsonBody(request);
        if (!body || typeof body.sessionId !== 'string') return writeJson(response, 400, { ok: false, error: 'sessionId required' });
        const current = await getSnapshot();
        const session = current?.sessions.find((entry) => entry.id === body.sessionId);
        if (!session) return writeJson(response, 404, { ok: false, error: 'unknown session' });
        const agent = current?.agents.find((entry) => entry.id === session.agentId);
        if (!agent) return writeJson(response, 404, { ok: false, error: 'unknown agent' });
        const plan = buildLaunchPlan(agent, session, config);
        if (plan.kind === 'unsupported') return writeJson(response, 200, { ok: false, plan, error: plan.reason });
        const copy = copyableCommand(plan);
        if (plan.kind === 'dsh') {
          return writeJson(response, 200, { ok: true, plan, handledBy: 'client', copy });
        }
        if (body.dryRun === true) {
          return writeJson(response, 200, { ok: true, plan, dryRun: true, copy });
        }
        const result = await launchInTerminal(plan, { dataDir, config });
        if (!result.ok) {
          logger?.warn?.(`[agent-history] launch failed for ${session.id}: ${result.error || ''}`);
        }
        writeJson(response, 200, { ok: result.ok, plan, terminal: result.terminal, error: result.error, copy });
      },
    },
    jsonRoute(ROUTES.projects, 'GET', async () => ({ projects: await opened.list() })),
    jsonRoute(ROUTES.projectsOpen, 'POST', async (body) => ({ projects: await opened.open(body.path) })),
    jsonRoute(ROUTES.projectsRemove, 'POST', async (body) => ({ projects: await opened.remove(body) })),
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
        if (request.method !== 'GET') return writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
        let current = null;
        try {
          current = await getSnapshot();
        } catch {
          current = null;
        }
        writeJson(response, 200, {
          ok: true,
          plugin: '@local/dsh-agent-history',
          version: '0.1.0',
          dataDir,
          scanning: scanning !== null,
          lastScannedAt: current?.scannedAt ?? null,
          agents: current?.agents?.length ?? 0,
          sessions: current?.sessions?.length ?? 0,
        });
      },
    },
  ];

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    logger?.info?.(`[agent-history] mounted ${Object.values(ROUTES).join(', ')}; dataDir=${dataDir}`);
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'agent-history: routes');
}

/**
 * Run `worker` over `items` with fixed concurrency, preserving order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, worker) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
