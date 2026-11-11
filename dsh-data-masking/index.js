/**
 * Data Masking — Host half.
 *
 * Masks sensitive business data (regions, departments, terms, people, addresses, ID segments …) in
 * every model request DSH sends through `ctx.llm`, and restores the placeholders in the streamed
 * reply before the agent loop sees it: the provider only ever receives placeholders, while the UI,
 * the session log and the tools work with the real values.
 *
 *   GET  /api/dsh-data-masking/state          status, rules, statistics
 *   POST /api/dsh-data-masking/rules          validate + save rules (body: rules document)
 *   POST /api/dsh-data-masking/toggle         { enabled: boolean }
 *   POST /api/dsh-data-masking/preview        { text, rules? } -> masked text + hits
 *   GET  /api/dsh-data-masking/history        ?limit=&before=
 *   POST /api/dsh-data-masking/history/clear
 *
 * Interception point: an `llm/stream` listener that dispatches the masked copy straight to the
 * runtime's final adapter boundary (`adapterStream`), because the waterfall's `next()` cannot carry
 * a replacement request. See README for the trade-offs.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { isLoopbackRequest } from './host/loopback.js';
import { defaultRules, normalizeRules } from './host/engine.js';
import { Interceptor } from './host/interceptor.js';
import { Store } from './host/store.js';

export const name = 'data-masking';

/** Masking only needs the LLM runtime; the settings page's HTTP API mounts when a web server exists. */
export const inject = ['llm'];

const PLUGIN_VERSION = '0.1.0';
const BASE = '/api/dsh-data-masking';
const MAX_BODY = 8 * 1024 * 1024;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function writeJson(res, status, body) {
  try {
    res.writeHead(status, JSON_HEADERS);
    res.end(JSON.stringify(body));
  } catch {
    // socket gone
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.trim() === '' ? {} : JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function resolveDataDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir.trim() !== '') return config.dataDir.trim();
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(dshHome, 'data-masking');
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const logger = typeof ctx.logger?.info === 'function' ? ctx.logger : null;
  const store = new Store(resolveDataDir(config));
  const core = new Interceptor({
    store,
    logger,
    sessionLogPresent: () => {
      try {
        return ctx.get('sessionLogDeepSeek') !== undefined;
      } catch {
        return false;
      }
    },
  });

  // 1. Model requests. Registered after the base bundle's listeners, so they all still run first.
  //    `global` + the bound `this` (the emitting LlmRuntime) also covers an isolated llm service.
  ctx.on(
    'llm/stream',
    function onLlmStream(options, next) {
      const runtime = this && typeof this === 'object' && typeof this.adapterStream === 'function' ? this : ctx.llm;
      return core.onStream(options, next, runtime);
    },
    { global: true },
  );

  // 2. The DeepSeek session-log uploader would otherwise ship the raw session events next to the
  //    masked messages. Sessions that ever ran with masking on stay excluded after it is turned off.
  ctx.inject(['sessionLogDeepSeek'], (child) => {
    child.sessionLogDeepSeek.registerExclusion((upload) => core.excludeSessionLog(upload));
    child.effect(() => {
      core.exclusionActive = true;
      return () => {
        core.exclusionActive = false;
      };
    }, 'data-masking: session-log exclusion');
  });

  // 3. Tools that send their arguments off the machine must not receive restored values.
  ctx.inject(['tools'], (child) => {
    child.tools.guard((exec) => core.guardTool(exec));
  });

  const guardLoopback = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` });
      return false;
    }
    return true;
  };

  const historyStats = () => {
    const { entries, total } = store.readHistory({ limit: 5000 });
    const byCode = {};
    let masked = 0;
    let blocked = 0;
    let toolBlocked = 0;
    const since = Date.now() - 24 * 3600 * 1000;
    let today = 0;
    for (const entry of entries) {
      if (entry.kind === 'mask') {
        masked += 1;
        if (entry.at >= since) today += 1;
        for (const item of entry.items ?? []) {
          const bucket = (byCode[item.code] ??= { code: item.code, label: item.label, values: 0 });
          bucket.values += 1;
          bucket.label = item.label;
        }
      } else if (entry.kind === 'block') blocked += 1;
      else if (entry.kind === 'tool-block') toolBlocked += 1;
    }
    return { total, masked, blocked, toolBlocked, today, byCode: Object.values(byCode).sort((a, b) => b.values - a.values) };
  };

  const statePayload = (sessionId) => ({
    ok: true,
    plugin: '@local/dsh-data-masking',
    version: PLUGIN_VERSION,
    dataDir: store.dataDir,
    status: {
      ...core.status(ctx.llm),
      ...(sessionId ? { sessionProtected: core.protectedSessions.has(sessionId) } : {}),
    },
    rules: core.rules,
    // Starting point for the editor when the rules file is broken (rules === null).
    defaults: core.rules ? undefined : defaultRules(),
    stats: historyStats(),
  });

  const routes = [
    {
      kind: 'exact',
      path: `${BASE}/state`,
      handler: async (req, res) => {
        if (!guardLoopback(req, res, 'GET')) return;
        try {
          const session = new URL(req.url, 'http://localhost').searchParams.get('session') || undefined;
          writeJson(res, 200, statePayload(session));
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/rules`,
      handler: async (req, res) => {
        if (!guardLoopback(req, res, 'POST')) return;
        try {
          const body = await readBody(req);
          let rules;
          try {
            // Saving over a broken rules file keeps masking on: the previous state is unknown.
            rules = normalizeRules({ ...body, enabled: body.enabled ?? (core.rules ? core.rules.enabled : true) });
          } catch (error) {
            writeJson(res, 422, { ok: false, error: error.message, problems: error.problems ?? [error.message] });
            return;
          }
          core.saveRules(rules);
          logger?.info?.('[data-masking] rules saved');
          writeJson(res, 200, statePayload());
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/toggle`,
      handler: async (req, res) => {
        if (!guardLoopback(req, res, 'POST')) return;
        try {
          const body = await readBody(req);
          if (typeof body.enabled !== 'boolean') {
            writeJson(res, 400, { ok: false, error: 'enabled must be a boolean' });
            return;
          }
          if (!core.rules) {
            writeJson(res, 409, { ok: false, error: core.rulesError ?? '规则未加载' });
            return;
          }
          core.saveRules({ ...core.rules, enabled: body.enabled });
          logger?.info?.(`[data-masking] masking ${body.enabled ? 'enabled' : 'disabled'}`);
          writeJson(res, 200, statePayload());
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/preview`,
      handler: async (req, res) => {
        if (!guardLoopback(req, res, 'POST')) return;
        try {
          const body = await readBody(req);
          const text = typeof body.text === 'string' ? body.text.slice(0, 200000) : '';
          let draft;
          if (body.rules) {
            try {
              draft = normalizeRules(body.rules);
            } catch (error) {
              writeJson(res, 422, { ok: false, error: error.message, problems: error.problems ?? [error.message] });
              return;
            }
          }
          writeJson(res, 200, { ok: true, ...core.preview(text, draft) });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/history`,
      handler: async (req, res) => {
        if (!guardLoopback(req, res, 'GET')) return;
        try {
          const url = new URL(req.url, 'http://localhost');
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
          const beforeRaw = url.searchParams.get('before');
          const before = beforeRaw ? Number(beforeRaw) : undefined;
          const session = url.searchParams.get('session') || undefined;
          writeJson(res, 200, { ok: true, ...store.readHistory({ limit, before: Number.isFinite(before) ? before : undefined, sessionId: session }) });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error.message });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/history/clear`,
      handler: async (req, res) => {
        if (!guardLoopback(req, res, 'POST')) return;
        try {
          store.clearHistory();
          writeJson(res, 200, statePayload());
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error.message });
        }
      },
    },
  ];

  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const disposers = routes.map((route) => child.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'data-masking: routes');
  });

  const status = core.status(ctx.llm);
  logger?.info?.(`[data-masking] ready; enabled=${status.enabled} interceptorReady=${status.interceptorReady} dataDir=${store.dataDir}`);
  if (!status.interceptorReady) logger?.warn?.('[data-masking] ctx.llm.adapterStream is missing: model requests will be blocked while masking is on');
  if (status.rulesError) logger?.warn?.(`[data-masking] ${status.rulesError}`);
}
