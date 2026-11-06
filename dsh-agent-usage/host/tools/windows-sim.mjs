#!/usr/bin/env node
/**
 * Windows code-path simulation.
 *
 * This machine is macOS, so the plugin's `win32` branches cannot be exercised for real here. This
 * tool builds a temporary fake Windows user profile / AppData tree with real fixture files and
 * runs the providers with `env.platform = 'win32'` and Windows-style env roots, which exercises:
 *
 *   - the per-provider Windows path candidates (`%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%`)
 *   - CRLF line endings and a UTF-8 BOM (common for Windows-written JSON/JSONL)
 *   - multi-frame zstd session logs (DeepSeek Harness) and SQLite fixtures (Devin, IDE state DBs)
 *   - the scanner helpers' Windows-safe path handling (basename/dirname/quoted path expansion)
 *
 * Path *separators* stay POSIX here because Node's `path` module follows the host OS; on a real
 * Windows machine `path.join` produces backslashes automatically. Run on every release:
 *
 *   E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
 *   ELECTRON_RUN_AS_NODE=1 "$E" host/tools/windows-sim.mjs
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';
import { join } from 'node:path';
import * as utils from '../scan-utils.js';

const ROOT = await fs.mkdtemp(join(os.tmpdir(), 'dsh-agent-usage-win-'));
const home = join(ROOT, 'Users', 'aesc');
const appData = join(home, 'AppData', 'Roaming');
const localAppData = join(home, 'AppData', 'Local');
const xdgData = join(home, '.local', 'share');

const env = { home, platform: 'win32', appData, localAppData, xdgData, config: {} };

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail && !condition ? ` — ${detail}` : ''}`);
}

/** JSONL with a UTF-8 BOM and CRLF line endings — the hostile Windows case. */
async function writeWindowsJsonl(path, records) {
  const body = '\ufeff' + records.map((record) => JSON.stringify(record)).join('\r\n') + '\r\n';
  await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(path, body, 'utf8');
}

/** Concatenated zstd frames, one per line (DSH session log layout). */
async function writeZstdSession(path, lines) {
  await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  const frames = lines.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')));
  await fs.writeFile(path, Buffer.concat(frames));
}

let sqlite;
async function createSqlite(path, sql, rows) {
  if (!sqlite) sqlite = await import('node:sqlite');
  await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  const db = new sqlite.DatabaseSync(path);
  try {
    db.exec(sql);
    for (const [statement, params] of rows) db.prepare(statement).run(...params);
  } finally {
    db.close();
  }
}

const DAY1 = '2026-03-04T05:06:07.000Z';
const DAY2 = '2026-03-05T06:07:08.000Z';
const DAY1_MS = Date.parse(DAY1);

try {
  // ---------------------------------------------------------------------------------------
  // 1. Claude Code: %USERPROFILE%\.claude\projects\... with BOM + CRLF
  // ---------------------------------------------------------------------------------------
  await writeWindowsJsonl(join(home, '.claude', 'projects', 'C--Users-aesc-proj', 'session-win.jsonl'), [
    { type: 'mode', sessionId: 's1' },
    {
      type: 'assistant',
      uuid: 'u1',
      timestamp: DAY1,
      sessionId: 's1',
      message: {
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
      },
    },
  ]);

  // ---------------------------------------------------------------------------------------
  // 2. Codex: %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl
  // ---------------------------------------------------------------------------------------
  await writeWindowsJsonl(join(home, '.codex', 'sessions', '2026', '03', '04', 'rollout-win.jsonl'), [
    { timestamp: DAY1, type: 'turn_context', payload: { model: 'gpt-5.5' } },
    {
      timestamp: DAY1,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 100 } },
      },
    },
  ]);

  // ---------------------------------------------------------------------------------------
  // 3. DeepSeek Harness: %USERPROFILE%\.dsh\sessions\<slug>\<id>\session.v4.jsonl.zstd
  // ---------------------------------------------------------------------------------------
  await writeZstdSession(join(home, '.dsh', 'sessions', 'C--Users-aesc-proj', 'session-win', 'session.v4.jsonl.zstd'), [
    JSON.stringify({ type: 'session', version: 4, id: 'session-win', createdAt: DAY1_MS, cwd: 'C:\\Users\\aesc\\proj' }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 1,
      time: DAY1_MS,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 35 },
      },
    }),
  ]);

  // ---------------------------------------------------------------------------------------
  // 4. Devin CLI: %LOCALAPPDATA%\devin\cli\sessions.db (duplicate rows must be deduplicated)
  // ---------------------------------------------------------------------------------------
  const devinMessage = (id, model, ts, metrics, extra = {}) =>
    JSON.stringify({ message_id: id, role: 'assistant', metadata: { request_id: id, generation_model: model, started_generation_at: ts, metrics, ...extra } });
  await createSqlite(
    join(localAppData, 'devin', 'cli', 'sessions.db'),
    'CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT)',
    [
      ['INSERT INTO message_nodes (chat_message) VALUES (?)', [devinMessage('m1', 'swe-2-high', DAY1, { input_tokens: 3, output_tokens: 7, cache_read_tokens: 0, cache_creation_tokens: 100 })]],
      // Same response stored a second time with extensions attached:
      ['INSERT INTO message_nodes (chat_message) VALUES (?)', [devinMessage('m1', 'swe-2-high', DAY1, { input_tokens: 3, output_tokens: 7, cache_read_tokens: 0, cache_creation_tokens: 100 }, { extensions: { x: true } })]],
      ['INSERT INTO message_nodes (chat_message) VALUES (?)', [devinMessage('m2', 'claude-sonnet-4-5', DAY2, { input_tokens: 1, output_tokens: 2, cache_read_tokens: 5, cache_creation_tokens: 0 })]],
    ],
  );

  // ---------------------------------------------------------------------------------------
  // 5. IDE-style apps: Windows AppData detection + empty SQLite state (must not throw)
  // ---------------------------------------------------------------------------------------
  const emptyState = 'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)';
  await createSqlite(join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'), emptyState, []);
  await createSqlite(join(appData, 'Windsurf', 'User', 'globalStorage', 'state.vscdb'), emptyState, []);
  await createSqlite(join(appData, 'Trae CN', 'ModularData', 'ai-agent', 'database.db'), 'CREATE TABLE t (a TEXT)', []);

  // ---------------------------------------------------------------------------------------
  // 6. Run providers with the simulated Windows environment
  // ---------------------------------------------------------------------------------------
  const overrides = [
    'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'OPENCODE_DATA_DIR', 'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR', 'GROK_HOME', 'GEMINI_DIR', 'GEMINI_CLI_HOME', 'QWEN_DATA_DIR',
    'CONTINUE_GLOBAL_DIR', 'FACTORY_DIR', 'AIDER_ANALYTICS_LOG', 'DEVIN_DATA_DIR', 'WORKBUDDY_HOME',
    'GOOSE_PATH_ROOT', 'CRUSH_GLOBAL_DATA', 'ANTIGRAVITY_DATA_DIR',
  ];
  const savedEnv = new Map(overrides.map((name) => [name, process.env[name]]));
  for (const name of overrides) delete process.env[name];

  const cache = { get: () => undefined, set: () => {} };
  async function run(id) {
    const provider = await import(`../providers/${id}.js`);
    const warnings = [];
    const context = {
      providerId: id,
      signal: new AbortController().signal,
      env,
      utils,
      cache,
      warn: (message) => warnings.push(message),
    };
    const started = Date.now();
    try {
      const result = await provider.scan(context);
      const cells = result?.cells || [];
      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
      for (const cell of cells) {
        totals.input += cell.input || 0;
        totals.output += cell.output || 0;
        totals.cacheRead += cell.cacheRead || 0;
        totals.cacheWrite += cell.cacheWrite || 0;
        totals.messages += cell.messages || 0;
      }
      return { ok: true, cells, totals, warnings, ms: Date.now() - started, sources: result?.sources || [] };
    } catch (error) {
      return { ok: false, error, warnings, ms: Date.now() - started };
    }
  }

  const claude = await run('claude-code');
  check('claude-code scans under win32 env', claude.ok, claude.error?.stack);
  check(
    'claude-code BOM + CRLF transcript parsed',
    claude.ok && claude.totals.input === 100 && claude.totals.output === 20 && claude.totals.cacheRead === 50 && claude.totals.cacheWrite === 10,
    JSON.stringify(claude.totals),
  );

  const codex = await run('codex');
  check('codex scans under win32 env', codex.ok, codex.error?.stack);
  check(
    'codex token_count delta parsed (uncached input)',
    codex.ok && codex.totals.input === 600 && codex.totals.output === 100 && codex.totals.cacheRead === 400,
    JSON.stringify(codex.totals),
  );

  const dsh = await run('deepseek-harness');
  check('deepseek-harness scans under win32 env', dsh.ok, dsh.error?.stack);
  check(
    'deepseek-harness multi-frame zstd parsed',
    dsh.ok && dsh.totals.input === 10 && dsh.totals.output === 5 && dsh.totals.cacheRead === 20,
    JSON.stringify(dsh.totals),
  );

  const devin = await run('devin');
  check('devin scans under win32 env', devin.ok, devin.error?.stack);
  check(
    'devin sessions.db aggregated and deduplicated',
    devin.ok && devin.totals.input === 4 && devin.totals.output === 9 && devin.totals.cacheRead === 5 && devin.totals.cacheWrite === 100 && devin.totals.messages === 2,
    JSON.stringify(devin.totals),
  );

  // Every adapter must survive the Windows environment (most will report MISS on this fixture).
  const { loadProviders } = await import('../providers/index.js');
  const providers = await loadProviders();
  check('provider registry discovers every adapter', providers.length >= 20, `${providers.length} providers`);
  for (const provider of providers) {
    const id = provider.meta?.id;
    if (!id) continue;
    const outcome = await run(id);
    check(`provider ${id} runs under win32 env`, outcome.ok, outcome.error?.stack);
  }

  const cursor = await run('cursor');
  check('cursor handles a Windows state.vscdb without throwing', cursor.ok, cursor.error?.stack);
  const windsurf = await run('windsurf');
  check('windsurf handles a Windows state.vscdb without throwing', windsurf.ok, windsurf.error?.stack);
  const trae = await run('trae');
  check('trae handles a Windows AppData install without throwing', trae.ok, trae.error?.stack);

  // ---------------------------------------------------------------------------------------
  // 7. Helper-level Windows behaviour
  // ---------------------------------------------------------------------------------------
  check('basenameOf understands backslash paths', utils.basenameOf('C:\\Users\\aesc\\.claude\\session.jsonl') === 'session.jsonl');
  check('dirnameOf understands backslash paths', utils.dirnameOf('C:\\Users\\aesc\\.claude\\session.jsonl') === 'C:\\Users\\aesc\\.claude');

  const savedAppData = process.env.APPDATA;
  process.env.APPDATA = 'C:\\Users\\aesc\\AppData\\Roaming';
  check('expandPath expands %APPDATA%', utils.expandPath('%APPDATA%\\Cursor\\User') === 'C:\\Users\\aesc\\AppData\\Roaming\\Cursor\\User');
  if (savedAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = savedAppData;

  check('expandPath strips surrounding quotes', utils.expandPath('"C:\\Users\\aesc\\.claude"') === 'C:\\Users\\aesc\\.claude');
  check(
    'expandPath handles ~\\',
    utils.expandPath('~\\.claude').includes('.claude') && !utils.expandPath('~\\.claude').startsWith('~'),
  );

  const bomText = await utils.readText(join(home, '.claude', 'projects', 'C--Users-aesc-proj', 'session-win.jsonl'));
  check('readText strips a UTF-8 BOM', typeof bomText === 'string' && bomText.charCodeAt(0) !== 0xfeff);

  let parsedLines = 0;
  await utils.readJsonl(join(home, '.claude', 'projects', 'C--Users-aesc-proj', 'session-win.jsonl'), (line) => {
    if (utils.safeJsonParse(line) !== null) parsedLines += 1;
  });
  check('readJsonl + safeJsonParse survive BOM/CRLF', parsedLines === 2, `parsed ${parsedLines}`);

  check('safeJsonParse tolerates a BOM-prefixed line', utils.safeJsonParse('\ufeff{"a":1}')?.a === 1);

  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (Windows simulation, temp root ${ROOT})`);
  if (failed.length > 0) {
    console.log('failed:', failed.map((result) => result.name).join(' | '));
    process.exitCode = 1;
  }
} finally {
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
}
