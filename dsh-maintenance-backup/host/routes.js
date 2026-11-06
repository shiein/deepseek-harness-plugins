/**
 * 本地 HTTP API：面板的全部读写入口。全部 loopback-only。
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { IS_WINDOWS, platformInfo } from './platform.js';

const requireFromHere = createRequire(import.meta.url);

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const SNAPSHOT_RE = /^dsh-snap-\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/;
const SCOPES = new Set(['all', 'config', 'workspace']);

/** @param {import('node:http').ServerResponse} response */
function writeJson(response, status, body) {
  try {
    response.writeHead(status, JSON_HEADERS);
    response.end(JSON.stringify(body));
  } catch {
    /* socket already gone */
  }
}

/** @param {unknown} error @param {number} status */
function httpError(message, status = 500) {
  const error = new Error(String(message));
  error.status = status;
  return error;
}

/** @param {import('node:http').IncomingMessage} request */
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

/** @param {import('node:http').IncomingMessage} request */
function readJsonBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError('请求体过大', 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError('请求体不是合法 JSON', 400));
      }
    });
    request.on('error', (error) => reject(httpError(error.message, 400)));
  });
}

/**
 * @param {{
 *   core: ReturnType<import('./core.js').createCore>,
 *   quark: ReturnType<import('./quark.js').createQuark>,
 *   scope: ReturnType<import('./scope.js').createScope>,
 *   backup: ReturnType<import('./backup.js').createBackup>,
 *   schedule: ReturnType<import('./schedule.js').createSchedule>,
 *   restore: ReturnType<import('./restore.js').createRestoreEngine>,
 *   ctx: any,
 *   config: Record<string, unknown>,
 * }} deps
 */
export function createRoutes(deps) {
  const { core, quark, scope, backup, schedule, restore, syncTools, ctx, config } = deps;
  let connectionRefresh = null;
  let archiveCache = null;
  let lastOverview = null;

  const pluginVersion = (() => {
    try {
      const pkg = JSON.parse(core.readText(join(core.paths.selfPackageDir, 'package.json')) || '{}');
      return typeof pkg.version === 'string' ? pkg.version : '0.1.0';
    } catch {
      return '0.1.0';
    }
  })();

  async function refreshConnection() {
    if (connectionRefresh) return connectionRefresh;
    connectionRefresh = (async () => {
      const previous = core.getState().connection;
      const connection = await quark.getUserInfo();
      // 未授权时保留上次已知昵称，便于展示
      if (connection.state !== 'connected' && previous?.nickname) {
        connection.nickname = previous.nickname;
        connection.vipType = previous.vipType;
      }
      core.updateState({ connection });
      return connection;
    })().finally(() => {
      connectionRefresh = null;
    });
    return connectionRefresh;
  }

  function staleConnection() {
    const connection = core.getState().connection;
    const stale = !connection || core.now() - (connection.checkedAt || 0) > 90000;
    if (stale && !connectionRefresh) {
      void refreshConnection().catch(() => {});
    }
    if (!connection) {
      return {
        state: 'unknown',
        nickname: null,
        vipType: null,
        capacity: null,
        used: null,
        expiresAt: null,
        code: null,
        message: '正在检查网盘连接…',
        checkedAt: null,
        stale: true,
      };
    }
    return { ...connection, stale };
  }

  async function countArchive() {
    if (archiveCache && core.now() - archiveCache.at < 5 * 60 * 1000) return archiveCache.count;
    try {
      const { archiveFid } = await restore.folders();
      const result = await quark.browseAll(archiveFid);
      archiveCache = { at: core.now(), count: result.ok ? result.entries.length : null };
    } catch {
      archiveCache = { at: core.now(), count: null };
    }
    return archiveCache.count;
  }

  async function overviewPayload() {
    const state = core.getState();
    const task = backup.status();
    let pending = null;
    try {
      pending = await restore.inspectPending();
    } catch {
      pending = state.pendingRestore || null;
    }
    let safety = [];
    try {
      safety = await restore.listSafetyBackups();
    } catch {
      safety = [];
    }
    const scheduleInfo = schedule.get();
    const summary = state.lastScopeSummary || null;
    const warnings = [];
    if (state.lastBackup?.partial) warnings.push('最近一次快照不完整：有目录不可读，建议检查备份范围可读性。');
    if (pending?.phase === 'applying') {
      warnings.push('检测到上次还原在「应用」阶段被中断，请先查看还原结果或回滚到安全副本。');
    }
    const launchdPlist = join(core.paths.home, 'Library', 'LaunchAgents', 'com.aesc.dsh-sync.plist');
    if (existsSync(launchdPlist)) {
      warnings.push('launchd 定时任务 com.aesc.dsh-sync 仍存在，可能与插件定时重复备份；建议卸载（见设置页）。');
    }
    if (staleConnection().state === 'unauthorized') warnings.push('夸克网盘授权已失效：重新授权前无法备份或还原。');
    // 原生引擎不依赖 sync.sh；它只是 macOS 手动排查用的随包副本（Windows 上不安装）
    if (!IS_WINDOWS && !existsSync(core.paths.syncScript)) {
      warnings.push(`手动排查脚本不存在（不影响插件备份）：${core.paths.syncScript}`);
    }
    const lock = core.getLock();
    return {
      ok: true,
      version: pluginVersion,
      dataDir: core.paths.dataDir,
      syncDir: core.paths.syncDir,
      connection: staleConnection(),
      backup: { task, last: state.lastBackup || null },
      schedule: scheduleInfo,
      restore: {
        task: null,
        pending,
        last: state.lastRestore || null,
        safetyBackups: safety,
      },
      counts: {
        snapshots: state.snapshotCount ?? null,
        snapshotsLoading: false,
        scopeFiles: summary?.files ?? null,
        scopeBytes: summary?.bytes ?? null,
      },
      lock: lock ? { kind: lock.kind, since: lock.startedAt } : { kind: null, since: null },
      warnings,
      archiveCount: archiveCache?.count ?? null,
    };
  }

  /** 还原 apply 后把维护插件自身重新注册回去（profile 可能被旧快照覆盖）。 */
  async function ensureSelfRegistration() {
    const packageJsonPath = join(core.paths.profileDir, 'package.json');
    try {
      const pkg = JSON.parse(core.readText(packageJsonPath) || '{}');
      pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
      const spec = `link:${core.paths.selfPackageDir}`;
      if (!pkg.dependencies['@local/dsh-maintenance-backup']) {
        pkg.dependencies['@local/dsh-maintenance-backup'] = spec;
        core.writeJson(packageJsonPath, pkg);
        core.log('还原后已把维护插件依赖写回 profile package.json');
      }
      // 保证 profile 的 patch 层里有本插件行（否则重启后不会加载）
      const patchPath = core.paths.profilePatch;
      const patchText = core.readText(patchPath) || '';
      if (!/^-\s+id:\s*dsh-maintenance-backup\s*$/m.test(patchText) && !/- id:\s*dsh-maintenance-backup\b/.test(patchText)) {
        const scheduleInfo = schedule.get();
        const block = `
# 网盘备份维护（还原后自动补回；随后可在面板里调整）
- id: dsh-maintenance-backup
  name: '@local/dsh-maintenance-backup'
  config:
    schedule:
      enabled: ${scheduleInfo.enabled}
      intervalMinutes: ${scheduleInfo.intervalMinutes}
      keep: ${scheduleInfo.keep}
      watch: ${scheduleInfo.watch}
      debounceSeconds: ${scheduleInfo.debounceSeconds}
    autoRestart: false
`;
        core.writeText(patchPath, `${patchText.replace(/\s*$/, '')}\n${block}`);
        core.log('还原后已把维护插件行补回 profile cordis.patch.yml');
      }
      // 保证 node_modules 里的本地链接存在（不跑 pnpm install）
      const linkPath = join(core.paths.profileDir, 'node_modules', '@local', 'dsh-maintenance-backup');
      if (!existsSync(linkPath)) {
        mkdirSync(dirname(linkPath), { recursive: true });
        try {
          symlinkSync(core.paths.selfPackageDir, linkPath, IS_WINDOWS ? 'junction' : 'dir');
        } catch (error) {
          if (IS_WINDOWS) {
            try {
              symlinkSync(core.paths.selfPackageDir, linkPath, 'dir');
            } catch (secondError) {
              core.log(
                `创建插件链接失败（可稍后 pnpm install）: ${secondError?.message || secondError}`,
                'warn',
              );
            }
          } else {
            core.log(`创建插件链接失败（可稍后 pnpm install）: ${error?.message || error}`, 'warn');
          }
        }
      }
    } catch (error) {
      core.log(`还原后自愈注册失败: ${error?.message || error}`, 'error');
    }
  }

  function restartDsh() {
    const execPath = process.execPath || '';
    let appPath = '/Applications/DeepSeek Harness.app';
    const marker = '/Contents/MacOS/';
    if (execPath.includes(marker)) appPath = execPath.slice(0, execPath.indexOf(marker));
    // 1) 极少数情况下 host 直接跑在 Electron main 里，可用 app.relaunch()
    try {
      const electron = requireFromHere('electron');
      if (electron?.app?.relaunch) {
        setTimeout(() => {
          try {
            electron.app.relaunch();
            electron.app.exit(0);
          } catch {
            /* ignore */
          }
        }, 600);
        return { method: 'electron-app-relaunch', instructions: 'DSH 正在自动重启，请等待窗口重新打开。' };
      }
    } catch {
      /* Node-mode host 没有 electron app API */
    }
    // 2) Windows：Host 是 Electron 子进程，用 taskkill 结束应用后重新启动
    if (IS_WINDOWS) {
      const ppid = process.ppid;
      const exe = process.execPath;
      const script = [
        'ping -n 2 127.0.0.1 >nul',
        `taskkill /PID ${ppid} /T /F >nul 2>&1`,
        'ping -n 3 127.0.0.1 >nul',
        `start "" "${exe}"`,
      ].join(' & ');
      try {
        const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', script], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: core.childEnv(),
        });
        child.unref();
        return {
          method: 'windows-taskkill-and-start',
          instructions: 'DSH 将在约 4 秒后自动重启；若没有自动打开，请手动启动 DeepSeek Harness。',
        };
      } catch (error) {
        return {
          method: 'manual',
          instructions: `自动重启失败（${error?.message || error}）。请手动退出（Alt+F4 / 任务管理器）后重新打开 DeepSeek Harness。`,
        };
      }
    }

    // 3) macOS/Linux：Desktop host 是 Electron 子进程：杀掉父进程并重新 open 应用
    const ppid = process.ppid;
    const script = `sleep 1; kill -TERM ${ppid} 2>/dev/null; sleep 3; open -a ${JSON.stringify(appPath)}`;
    try {
      const child = spawn('/bin/sh', ['-c', script], {
        detached: true,
        stdio: 'ignore',
        env: core.childEnv(),
      });
      child.unref();
      return {
        method: 'shell-quit-and-open',
        instructions: 'DSH 将在约 4 秒后自动重启；若没有自动打开，请手动启动 DeepSeek Harness。',
      };
    } catch (error) {
      return {
        method: 'manual',
        instructions: `自动重启失败（${error?.message || error}）。请手动退出（⌘Q）后重新打开 DeepSeek Harness。`,
      };
    }
  }

  /** @type {import('@deepseek-ai/dsh-host-webserver').WebRoute[]} */
  const routes = [];

  function add(method, path, handler) {
    routes.push({
      kind: 'exact',
      path,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) {
          writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' });
          return;
        }
        const methods = Array.isArray(method) ? method : [method];
        if (!methods.includes(request.method)) {
          writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` });
          return;
        }
        try {
          const result = await handler(request);
          writeJson(response, 200, result ?? { ok: true });
        } catch (error) {
          const status = Number(error?.status) || 500;
          if (status >= 500) core.log(`接口 ${path} 失败: ${error?.message || error}`, 'error');
          writeJson(response, status, { ok: false, error: String(error?.message || error) });
        }
      },
    });
  }

  add('GET', '/api/dsh-maintenance/overview', async () => {
    lastOverview = await overviewPayload();
    return lastOverview;
  });

  add('GET', '/api/dsh-maintenance/scope', async (request) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const refresh = url.searchParams.get('refresh') === '1';
    const report = await scope.get({ refresh });
    return { ok: true, scope: report };
  });

  add('POST', '/api/dsh-maintenance/scope/toggle', async (request) => {
    const body = await readJsonBody(request);
    if (typeof body.src !== 'string' || !body.src) throw httpError('缺少 src', 400);
    if (typeof body.enabled !== 'boolean') throw httpError('缺少 enabled', 400);
    if (core.isBusy()) throw httpError('备份/还原进行中，暂不能修改范围', 409);
    const result = await scope.setEnabled(body.src, body.enabled);
    return result;
  });

  add('POST', '/api/dsh-maintenance/connection/refresh', async () => {
    const connection = await refreshConnection();
    return { ok: true, connection };
  });

  add('POST', '/api/dsh-maintenance/connection/login', async (request) => {
    const body = await readJsonBody(request);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) throw httpError('请输入夸克授权码（login --token）', 400);
    const result = await quark.login(token);
    if (!result.ok) {
      const connection = staleConnection();
      return { ok: false, error: result.msg || '授权失败', code: result.code, connection };
    }
    const connection = await refreshConnection();
    return { ok: true, connection };
  });

  add('GET', '/api/dsh-maintenance/backup/status', async () => ({
    ok: true,
    task: backup.status(),
    last: core.getState().lastBackup || null,
  }));

  add('POST', '/api/dsh-maintenance/backup/start', async (request) => {
    const body = await readJsonBody(request);
    const restorePending = await restore.inspectPending().catch(() => null);
    if (restorePending?.phase === 'applying') throw httpError('存在未收尾的还原，请先处理还原结果', 409);
    const result = await backup.start({
      force: body.force === true,
      trigger: typeof body.trigger === 'string' ? body.trigger : 'manual',
      keep: schedule.keep(),
    });
    if (!result.ok) throw httpError('已有备份或还原任务在运行', 409);
    return { ok: true, task: result.task };
  });

  add('POST', '/api/dsh-maintenance/backup/cancel', async () => {
    const result = backup.cancel();
    if (!result.ok) throw httpError(result.error || '没有正在运行的备份', 409);
    return { ok: true, task: result.task };
  });

  add('GET', '/api/dsh-maintenance/snapshots', async (request) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const refresh = url.searchParams.get('refresh') === '1';
    const snapshots = await restore.listSnapshots({ refresh });
    core.updateState({ snapshotCount: snapshots.length });
    const archiveCount = await countArchive();
    return { ok: true, snapshots, archiveCount };
  });

  add('POST', '/api/dsh-maintenance/snapshots/preview', async (request) => {
    const body = await readJsonBody(request);
    if (typeof body.name !== 'string' || !SNAPSHOT_RE.test(body.name)) throw httpError('快照名不合法', 400);
    const preview = await restore.preview({ name: body.name });
    return { ok: true, preview };
  });

  add('POST', '/api/dsh-maintenance/restore/stage', async (request) => {
    const body = await readJsonBody(request);
    if (typeof body.name !== 'string' || !SNAPSHOT_RE.test(body.name)) throw httpError('快照名不合法', 400);
    if (!SCOPES.has(body.scope)) throw httpError('还原范围不合法', 400);
    const includeSelf = body.includeSelf === true;
    const staged = await core.withLock('restore', async () =>
      restore.stage({ name: body.name, scope: body.scope, includeSelf }),
    );
    if (!staged.ok && staged.busy) throw httpError('已有备份或还原任务在运行', 409);
    return { ok: true, staging: staged };
  });

  add('POST', '/api/dsh-maintenance/restore/apply', async (request) => {
    const body = await readJsonBody(request);
    if (typeof body.stagingId !== 'string' || !body.stagingId) throw httpError('缺少 stagingId', 400);
    if (!SCOPES.has(body.scope)) throw httpError('还原范围不合法', 400);
    const includeSelf = body.includeSelf === true;
    const applied = await core.withLock('restore', async () =>
      restore.apply({
        stagingId: body.stagingId,
        scope: body.scope,
        includeSelf,
        ensureSelfRegistration: includeSelf ? undefined : ensureSelfRegistration,
      }),
    );
    if (!applied.ok && applied.busy) throw httpError('已有备份或还原任务在运行', 409);
    schedule.suspend(10 * 60 * 1000);
    scope.invalidate();
    try {
      syncTools.ensure();
    } catch (error) {
      core.log(`还原后备份工具自愈失败: ${error?.message || error}`, 'warn');
    }
    // 两阶段语义：marker 保留到下次插件启动时收尾（校验落地结果、清理 staging、展示结果）
    return { ok: true, result: applied };
  });

  add('POST', '/api/dsh-maintenance/restore/discard', async (request) => {
    const body = await readJsonBody(request);
    if (typeof body.stagingId !== 'string' || !body.stagingId) throw httpError('缺少 stagingId', 400);
    const result = await restore.discard({ stagingId: body.stagingId });
    return { ok: true, result };
  });

  add('POST', '/api/dsh-maintenance/restore/rollback', async () => {
    const result = await core.withLock('restore', async () => restore.rollback());
    if (!result.ok && result.busy) throw httpError('已有备份或还原任务在运行', 409);
    scope.invalidate();
    return { ok: true, result };
  });

  add('POST', '/api/dsh-maintenance/restore/ack', async () => {
    await restore.ackPending();
    const state = core.getState();
    if (state.lastRestore) core.updateState({ lastRestore: { ...state.lastRestore, pendingAck: false } });
    return { ok: true };
  });

  add('GET', '/api/dsh-maintenance/logs', async (request) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const lines = Math.max(10, Math.min(1000, Number(url.searchParams.get('lines')) || 200));
    return { ok: true, lines: core.tailLog(lines) };
  });

  add('POST', '/api/dsh-maintenance/schedule', async (request) => {
    const body = await readJsonBody(request);
    if (body.intervalMinutes !== undefined) {
      const minutes = Number(body.intervalMinutes);
      if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10080) throw httpError('间隔不合法', 400);
    }
    if (body.keep !== undefined) {
      const keep = Number(body.keep);
      if (!Number.isFinite(keep) || keep < 1 || keep > 10) throw httpError('保留份数需在 1-10 之间', 400);
    }
    if (body.debounceSeconds !== undefined) {
      const debounce = Number(body.debounceSeconds);
      if (!Number.isFinite(debounce) || debounce < 15 || debounce > 3600) throw httpError('防抖时间不合法', 400);
    }
    const next = await schedule.update(body);
    return { ok: true, schedule: next };
  });

  add('POST', '/api/dsh-maintenance/restart', async (request) => {
    const body = await readJsonBody(request);
    if (body.confirm !== true) throw httpError('需要 confirm:true 才会重启 DSH', 400);
    const result = restartDsh();
    core.log(`用户请求重启 DSH（method=${result.method}）`, 'warn');
    return { ok: true, ...result };
  });

  add('GET', '/api/dsh-maintenance/health', async () => ({
    ok: true,
    plugin: '@local/dsh-maintenance-backup',
    version: pluginVersion,
    engine: 'native',
    platform: platformInfo(),
    syncLogFile: core.paths.syncLogFile,
    dataDir: core.paths.dataDir,
    syncDir: core.paths.syncDir,
    dshHome: core.paths.dshHome,
    profileDir: core.paths.profileDir,
    cliPath: core.paths.cliPath,
    cliExists: existsSync(core.paths.cliPath),
    syncScript: core.paths.syncScript,
    syncScriptExists: existsSync(core.paths.syncScript),
    scopeScriptExists: existsSync(core.paths.scopeScript),
    lock: core.getLock(),
    schedule: schedule.get(),
    config,
    now: core.now(),
  }));

  return routes;
}
