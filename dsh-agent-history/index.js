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
 *   GET  /api/dsh-agent-history/search     -> sessions matching ?q= (metadata of all, text of recent ones)
 *   GET  /api/dsh-agent-history/projects   -> folders the user opened (most recent first)
 *   POST /api/dsh-agent-history/projects/open | /projects/remove -> record / forget one folder
 *   GET  /api/dsh-agent-history/health     -> plugin/route diagnostics
 *
 * Mounted by the Cordis bundle row in cordis.patch.yml. The Client half (client.js) renders the
 * sidebar entry, the grouped conversation browser and the launch buttons.
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isLoopbackRequest } from './host/loopback.js';
import { runScanInWorker } from './host/scan-in-worker.js';
import { runWithConcurrency } from './host/concurrency.js';
import { loadSnapshot } from './host/scanner.js';
import { TranscriptReaderPool } from './host/transcript-reader-pool.js';
import { TranscriptReader, buildTimeline } from './host/transcript.js';
import { buildLaunchPlan, copyableCommand, launchInTerminal } from './host/launch.js';
import { projectKey, snapshotSignature } from './host/model.js';
import { OpenedProjects } from './host/opened-projects.js';

/** Cordis plugin name. */
export const name = 'agent-history';

const SCAN_WORKER_URL = new URL('./host/scan-worker.js', import.meta.url);
const TRANSCRIPT_WORKER_URL = new URL('./host/transcript-worker.js', import.meta.url);

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
  search: '/api/dsh-agent-history/search',
};

const SEARCH_LIMIT = 100;
const SEARCH_FULLTEXT_SESSIONS = 200;
const SEARCH_BUDGET_MS = 8000;

/** `…text around the match…` for a result list. */
function snippetAround(text, index, length) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 80);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

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
  /** @type {import('node:worker_threads').Worker|null} */
  let activeWorker = null;

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

  // Transcript reads (synchronous SQLite for several agents) run off the Host thread.
  const readerPool = new TranscriptReaderPool(TRANSCRIPT_WORKER_URL, { dataDir, config });
  const reader = new TranscriptReader({
    read: (session) => readerPool.read(session),
    version: async (session) => {
      try {
        const info = await stat(session.sourcePath);
        return `${info.size}:${info.mtimeMs}`;
      } catch {
        return ''; // sourcePath is display text for some agents; the snapshot's updatedAt still applies
      }
    },
  });

  /** Load the last persisted snapshot once (never scans). */
  async function getSnapshot() {
    if (snapshot !== null) return snapshot;
    if (!snapshotLoadAttempted) {
      snapshotLoadAttempted = true;
      snapshot = await loadSnapshot(dataDir);
      // Snapshots saved before signatures existed get one here.
      if (snapshot && typeof snapshot.signature !== 'string') snapshot.signature = snapshotSignature(snapshot);
    }
    return snapshot;
  }

  /**
   * The snapshot, or only its timing when the Client already holds the same content (`since` is the
   * signature it has). Saves re-sending (and re-rendering) megabytes after an unchanged rescan.
   */
  function snapshotPayload(current, since) {
    if (current && typeof since === 'string' && since !== '' && current.signature === since) {
      return { unchanged: true, signature: current.signature, scannedAt: current.scannedAt, durationMs: current.durationMs };
    }
    return { snapshot: current };
  }

  /** Run (or join) one scan. */
  function ensureScan() {
    if (scanning !== null) return scanning;
    scanning = (async () => {
      const result = await runScanInWorker(SCAN_WORKER_URL, { dataDir, config, onWorker: (worker) => { activeWorker = worker; } });
      snapshot = result;
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

  /**
   * Search every session: titles, previews and folders of all of them, and the messages of the most
   * recently active SEARCH_FULLTEXT_SESSIONS (transcripts are read on the worker and cached), within
   * a time budget. The answer says how far the full-text part got.
   */
  async function search(raw) {
    const query = String(raw).trim().slice(0, 200);
    const needle = query.toLowerCase();
    if (needle.length < 2) return { query, hits: [], fullText: { searched: 0, total: 0, complete: true } };
    const current = await getSnapshot();
    const sessions = current?.sessions ?? [];
    const hits = [];
    const seen = new Set();
    const add = (session, where, snippet, ts) => {
      if (hits.length >= SEARCH_LIMIT) return;
      hits.push({ sessionId: session.id, agentId: session.agentId, title: session.title, projectPath: session.projectPath,
        updatedAt: session.updatedAt, where, snippet, ts: ts || session.updatedAt });
      seen.add(session.id);
    };
    for (const session of sessions) {
      if (hits.length >= SEARCH_LIMIT) break;
      for (const [where, text] of [['title', session.title], ['preview', session.preview], ['preview', session.lastPreview], ['folder', session.projectPath]]) {
        const index = String(text || '').toLowerCase().indexOf(needle);
        if (index >= 0) { add(session, where, snippetAround(String(text), index, needle.length)); break; }
      }
    }
    const candidates = sessions
      .filter((session) => session.messages > 0 && !seen.has(session.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, SEARCH_FULLTEXT_SESSIONS);
    const deadline = Date.now() + SEARCH_BUDGET_MS;
    let searched = 0;
    await runWithConcurrency(candidates, 4, async (session) => {
      if (Date.now() > deadline || hits.length >= SEARCH_LIMIT) return;
      let entry;
      try {
        entry = await reader.get(session, new AbortController().signal);
      } catch {
        return;
      }
      searched += 1;
      for (const message of entry.messages) {
        if (message.kind === 'tool-call' || message.kind === 'tool-result' || message.role === 'system') continue;
        const index = message.text.toLowerCase().indexOf(needle);
        if (index >= 0) { add(session, 'message', snippetAround(message.text, index, needle.length), message.ts); break; }
      }
    });
    hits.sort((a, b) => b.ts - a.ts);
    return { query, hits, fullText: { searched, total: candidates.length, complete: searched === candidates.length } };
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
          const since = requestUrl(request).searchParams.get('since');
          writeJson(response, 200, { ok: true, scanning: scanning !== null, dataDir, ...snapshotPayload(current, since) });
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
          const since = requestUrl(request).searchParams.get('since');
          const { snapshot: next } = await ensureScan();
          logger?.info?.(`[agent-history] scan finished in ${Date.now() - started}ms: ${next.totals.sessions} sessions, ${next.totals.agents} agents`);
          writeJson(response, 200, { ok: true, scanning: false, dataDir, ...snapshotPayload(next, since) });
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
          const loaded = await runWithConcurrency(chosen, 4, async (session) => {
            const entry = await reader.getForTimeline(session, abort.signal);
            if (entry.error !== undefined) {
              logger?.warn?.(`[agent-history] transcript read failed for ${session.id}: ${entry.error}`);
            }
            return { session, messages: entry.messages, error: entry.error, truncated: entry.truncated === true };
          });
          const readable = loaded.filter(Boolean);
          const failedSessions = readable
            .filter((item) => item.error !== undefined)
            .map((item) => ({ id: item.session.id, title: item.session.title, error: item.error }));
          const timed = buildTimeline(readable, { limit, cursor, order, role, query });
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
            failedSessions,
            truncatedSessions: readable
              .filter((item) => item.truncated)
              .map((item) => ({ id: item.session.id, title: item.session.title })),
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
        writeJson(response, 200, { ok: result.ok, plan, terminal: result.terminal, error: result.error, code: result.code, copy });
      },
    },
    jsonRoute(ROUTES.search, 'GET', async (_body, request) => search(requestUrl(request).searchParams.get('q') || '')),
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

  ctx.effect(() => () => {
    // Plugin stop / hot reload: do not leave a scan worker reading databases in the background.
    void activeWorker?.terminate();
    activeWorker = null;
    readerPool.dispose();
  }, 'agent-history: scan worker');

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    logger?.info?.(`[agent-history] mounted ${Object.values(ROUTES).join(', ')}; dataDir=${dataDir}`);
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'agent-history: routes');
}
