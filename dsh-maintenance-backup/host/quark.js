/**
 * 夸克网盘 CLI 的薄封装（只走命令行接口，不读 CLI 源码）。
 *
 * 约束：
 * - 每个子命令都必须带 --session-input / --session-id（插件生成固定值）；
 * - 子进程显式继承 DSH_HOME / DSH_SESSION_ID，否则 CLI 返回 -104；
 * - CLI 的退出码不可靠，成败一律解析 NDJSON 的 code 字段。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UNAUTHORIZED_RE = /未授权|授权|认证|token|登录|过期/i;
const NETWORK_RE = /network|fetch|timeout|timed out|ENOTFOUND|ECONNRESET|ETIMEDOUT|网络|连接失败|请求失败/i;
const SESSION_INPUT = 'DSH 网盘备份维护插件：备份、快照与还原操作';

/** @param {string} stdout */
function parseNdjson(stdout) {
  const lines = [];
  for (const raw of String(stdout || '').split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    try {
      lines.push(JSON.parse(text));
    } catch {
      lines.push({ type: 'text', raw: text });
    }
  }
  return lines;
}

/** @param {string} path */
function readJsonlFile(path) {
  const entries = [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return entries;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object') entries.push(value);
    } catch {
      /* 忽略坏行 */
    }
  }
  return entries;
}

/** @param {unknown} value */
function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {Record<string, unknown>} data @param {string[]} keys */
function pickPath(data, keys) {
  if (!data || typeof data !== 'object') return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * @param {ReturnType<import('./core.js').createCore>} core
 */
export function createQuark(core) {
  const sessionId = `dsh-mnt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionArgs = ['--session-input', SESSION_INPUT, '--session-id', sessionId];

  function classifyError(code, message) {
    if (code === 0) return 'ok';
    const text = String(message || '');
    if (UNAUTHORIZED_RE.test(text)) return 'unauthorized';
    if (NETWORK_RE.test(text)) return 'network';
    if (code === null || code === undefined) return 'network';
    return 'error';
  }

  /**
   * 运行一次 CLI。返回最后一条 result 行（没有 result 时为 null）与全部 NDJSON 行。
   * @param {string[]} args
   * @param {{timeoutMs?: number}} [options]
   */
  async function call(args, options = {}) {
    const { timeoutMs = 120000 } = options;
    const started = core.now();
    const result = await core.runNode([core.paths.cliPath, ...args, ...sessionArgs], { timeoutMs });
    const lines = parseNdjson(result.stdout);
    const resultLine = [...lines].reverse().find((line) => line && line.type === 'result') || null;
    const code = resultLine && typeof resultLine.code === 'number' ? resultLine.code : result.code === 0 ? null : -1;
    const msg = resultLine?.msg ?? (result.stderr || '').trim().split('\n').slice(-3).join(' ') ?? '';
    return {
      ok: Boolean(resultLine && resultLine.code === 0),
      code,
      msg,
      data: resultLine?.data ?? null,
      resultLine,
      lines,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      durationMs: core.now() - started,
      timedOut: /timed out|SIGKILL/i.test(result.error || '') || result.code === null,
    };
  }

  /** @returns {Promise<{state:string,nickname:string|null,vipType:string|null,capacity:number|null,used:number|null,expiresAt:number|null,code:number|null,message:string,checkedAt:number}>} */
  async function getUserInfo() {
    const response = await call(['get-user-info'], { timeoutMs: 60000 });
    const checkedAt = core.now();
    if (!response.resultLine) {
      const kind = response.timedOut ? 'network' : classifyError(-1, response.msg);
      return {
        state: kind === 'unauthorized' ? 'unauthorized' : 'error',
        nickname: null,
        vipType: null,
        capacity: null,
        used: null,
        expiresAt: null,
        code: response.code,
        message:
          kind === 'unauthorized'
            ? '夸克授权已失效，请重新授权'
            : response.timedOut
              ? '连接夸克网盘超时，请检查网络'
              : `无法读取网盘账户信息${response.msg ? `：${response.msg}` : ''}`,
        checkedAt,
      };
    }
    if (!response.ok) {
      return {
        state: classifyError(response.code, response.msg) === 'unauthorized' ? 'unauthorized' : 'error',
        nickname: null,
        vipType: null,
        capacity: null,
        used: null,
        expiresAt: null,
        code: response.code,
        message:
          classifyError(response.code, response.msg) === 'unauthorized'
            ? '夸克授权已失效，请重新授权'
            : `网盘返回错误（${response.code}）：${response.msg}`,
        checkedAt,
      };
    }
    const data = response.data || {};
    const vipInfo = data.vipInfo || {};
    const userInfo = data.userInfo || {};
    const vipType = typeof vipInfo.vipType === 'string' && vipInfo.vipType.trim() ? vipInfo.vipType.trim() : '普通用户';
    return {
      state: 'connected',
      nickname: typeof userInfo.nickname === 'string' && userInfo.nickname.trim() ? userInfo.nickname.trim() : null,
      vipType,
      capacity: toNumber(vipInfo.capacity),
      used: toNumber(vipInfo.used),
      expiresAt: toNumber(vipInfo.expiresIn),
      code: 0,
      message: '已连接夸克网盘',
      checkedAt,
    };
  }

  /** @param {string} token */
  async function login(token) {
    const response = await call(['login', '--token', String(token || '').trim()], { timeoutMs: 180000 });
    return { ok: response.ok, code: response.code, msg: response.msg, data: response.data, raw: response };
  }

  /**
   * 列出网盘目录全部直接子项。
   * @param {string} parentFid
   * @returns {Promise<{ok:boolean, entries:Array<Object>, filePath:string|null, code:number|null, msg:string}>}
   */
  async function browseAll(parentFid) {
    const taskDir = join(core.paths.tasksDir, `browse-${core.uuid()}`);
    mkdirSync(taskDir, { recursive: true });
    const response = await call(
      ['browse', '--parent-fid', parentFid, '--all', '--page-size', '100', '--task-dir', taskDir],
      { timeoutMs: 120000 },
    );
    const filePath = typeof response.data?.file_path === 'string' ? response.data.file_path : null;
    const entries = filePath ? readJsonlFile(filePath) : [];
    // 清理临时目录，避免运行态堆积
    try {
      core.removeTree(taskDir);
    } catch {
      /* ignore */
    }
    return { ok: response.ok, entries, filePath, code: response.code, msg: response.msg };
  }

  /**
   * 下载一个文件。返回实际落盘路径。
   * @param {string} fid
   * @param {string} outDir
   * @param {{name?: string}} [options]
   */
  async function download(fid, outDir, options = {}) {
    const { name } = options;
    mkdirSync(outDir, { recursive: true });
    const before = new Set(
      readdirSync(outDir)
        .map((entry) => {
          try {
            return { entry, mtime: statSync(join(outDir, entry)).mtimeMs };
          } catch {
            return { entry, mtime: 0 };
          }
        })
        .map((item) => item.entry),
    );
    const response = await call(
      ['download', '--fid', fid, '--output-dir', outDir, '--overwrite'],
      { timeoutMs: 20 * 60 * 1000 },
    );
    let path =
      pickPath(response.data, [
        'path',
        'file_path',
        'filePath',
        'local_path',
        'localPath',
        'output_path',
        'outputPath',
        'save_path',
        'download_path',
        'dest',
      ]) || null;
    if (path && !existsSync(path)) {
      // 有的实现返回的是目录
      const candidate = name ? join(path, name) : null;
      path = candidate && existsSync(candidate) ? candidate : existsSync(path) ? path : null;
    }
    if (!path && name && existsSync(join(outDir, name))) path = join(outDir, name);
    if (!path) {
      // 兜底：找 outDir 里新增或最新的文件
      const files = readdirSync(outDir)
        .map((entry) => {
          const abs = join(outDir, entry);
          try {
            const info = statSync(abs);
            return info.isFile() ? { abs, mtime: info.mtimeMs } : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
      const fresh = files.find((file) => !before.has(core.basename(file.abs)));
      path = fresh?.abs || files[0]?.abs || null;
    }
    return { ok: response.ok && Boolean(path), path, data: response.data, code: response.code, msg: response.msg };
  }

  /**
   * @param {string} file
   * @param {string} parentFid
   */
  async function upload(file, parentFid) {
    const response = await call(['upload', file, '--parent-fid', parentFid], { timeoutMs: 20 * 60 * 1000 });
    const data = response.data || {};
    const fid =
      (Array.isArray(data.fids) && typeof data.fids[0] === 'string' ? data.fids[0] : null) ||
      data.fid ||
      data.file_fid ||
      data.fileId ||
      (Array.isArray(data.file_list) && data.file_list[0]?.fid) ||
      null;
    return {
      ok: response.ok && Boolean(fid),
      fid: typeof fid === 'string' ? fid : null,
      data,
      code: response.code,
      msg: response.msg,
    };
  }

  /**
   * @param {string[]} fids
   * @param {string} targetFid
   */
  async function move(fids, targetFid) {
    const list = (Array.isArray(fids) ? fids : [fids]).filter(Boolean);
    const response = await call(['move', ...list, '--target-fid', targetFid], { timeoutMs: 180000 });
    return { ok: response.ok, data: response.data, code: response.code, msg: response.msg };
  }

  return {
    sessionArgs,
    sessionId,
    call,
    classifyError,
    getUserInfo,
    login,
    browseAll,
    download,
    upload,
    move,
  };
}
