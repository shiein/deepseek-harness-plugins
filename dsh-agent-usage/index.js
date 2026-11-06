/**
 * Agent Token Usage — Host half.
 *
 * Serves the local usage snapshot of every supported AI coding agent through a small read-only
 * JSON API, and scans the local session files only when the browser asks for a refresh.
 *
 *   GET  /api/dsh-agent-usage/snapshot  -> last snapshot (from memory or last-scan.json)
 *   POST /api/dsh-agent-usage/scan      -> run one full scan and return the new snapshot
 *   GET  /api/dsh-agent-usage/health    -> plugin/route diagnostics
 *
 * Mounted by the Cordis bundle row in cordis.patch.yml. The Client half (client.js) renders the
 * sidebar entry and the dashboard page.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { loadSnapshot } from './host/scanner.js';

const SCAN_WORKER_URL = new URL('./host/scan-worker.js', import.meta.url);

/**
 * Run one scan on a worker thread (see host/scan-worker.js for why it must leave the Host thread).
 * @param {{dataDir: string, config: Record<string, unknown>, onWorker: (worker: Worker|null) => void}} options
 * @returns {Promise<import('./host/scanner.js').Snapshot>}
 */
function runScanInWorker({ dataDir, config, onWorker }) {
  return new Promise((resolve, reject) => {
    // Profile config is plain YAML data; a JSON round-trip drops anything a worker cannot clone.
    const worker = new Worker(SCAN_WORKER_URL, { workerData: { dataDir, config: JSON.parse(JSON.stringify(config ?? {})) } });
    onWorker(worker);
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      onWorker(null);
      fn(value);
    };
    worker.once('message', (message) => {
      if (message?.ok) settle(resolve, message.snapshot);
      else settle(reject, new Error(`scan worker failed: ${message?.error ?? 'unknown error'}`));
    });
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) => settle(reject, new Error(`scan worker exited with code ${code} before reporting`)));
  });
}

/** Cordis plugin name. */
export const name = 'agent-usage';

/** Hard dependency: the browser HTTP carrier that serves the Web GUI this page renders in. */
export const inject = ['webServer'];

const ROUTES = {
  snapshot: '/api/dsh-agent-usage/snapshot',
  scan: '/api/dsh-agent-usage/scan',
  health: '/api/dsh-agent-usage/health',
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
 * Loopback trust fence: the dashboard is a local-machine view, so only requests that arrived on a
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

/**
 * @param {string} dataDir
 * @returns {string}
 */
function resolveDataDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir.trim() !== '') return config.dataDir.trim();
  if (process.env.DSH_AGENT_USAGE_DATA_DIR) return process.env.DSH_AGENT_USAGE_DATA_DIR;
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'agent-usage');
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
  /** @type {Worker|null} */
  let activeWorker = null;

  const logger = typeof ctx.logger?.info === 'function' ? ctx.logger : null;

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
      const result = await runScanInWorker({ dataDir, config, onWorker: (worker) => { activeWorker = worker; } });
      snapshot = result;
      return { snapshot: result };
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  }

  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const routes = [
    {
      kind: 'exact',
      path: ROUTES.snapshot,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) {
          writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
          return;
        }
        if (request.method !== 'GET') {
          writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
          return;
        }
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
        if (!isLoopbackRequest(request)) {
          writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
          return;
        }
        if (request.method !== 'POST') {
          writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
          return;
        }
        try {
          const started = Date.now();
          const { snapshot: next } = await ensureScan();
          logger?.info?.(`[agent-usage] scan finished in ${Date.now() - started}ms: ${next.cells.length} cells, ${next.agents.length} agents`);
          writeJson(response, 200, { ok: true, scanning: false, dataDir, snapshot: next });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger?.warn?.(`[agent-usage] scan failed: ${message}`);
          writeJson(response, 500, { ok: false, scanning: false, error: message });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) {
          writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
          return;
        }
        if (request.method !== 'GET') {
          writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
          return;
        }
        let current = null;
        try {
          current = await getSnapshot();
        } catch {
          current = null;
        }
        writeJson(response, 200, {
          ok: true,
          plugin: '@local/dsh-agent-usage',
          version: '0.1.0',
          dataDir,
          scanning: scanning !== null,
          lastScannedAt: current?.scannedAt ?? null,
          agents: current?.agents?.length ?? 0,
        });
      },
    },
  ];

  ctx.effect(() => () => {
    // Plugin stop / hot reload: do not leave a scan worker reading databases in the background.
    void activeWorker?.terminate();
    activeWorker = null;
  }, 'agent-usage: scan worker');

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    logger?.info?.(`[agent-usage] mounted ${ROUTES.snapshot}, ${ROUTES.scan}, ${ROUTES.health}; dataDir=${dataDir}`);
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'agent-usage: routes');
}
