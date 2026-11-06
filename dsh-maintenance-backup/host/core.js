/**
 * 网盘备份维护 —— Host 侧基础设施。
 *
 * 运行态目录、原子 JSON 读写、日志、全局任务锁、子进程、文件遍历与哈希。
 * 这里不包含任何业务规则（备份 / 还原 / 定时各自在独立模块里）。
 */

import { execFile, spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IS_WINDOWS,
  PLATFORM,
  buildChildEnv,
  defaultDshHome,
  defaultSyncDir,
  defaultWorkspaceDir,
  homeDirectory,
  platformInfo,
  resolveNodeCommand,
} from './platform.js';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_ROTATE_KEEP = 1;
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

const DEFAULT_STATE = () => ({
  version: 1,
  schedule: null,
  scheduleSource: null,
  disabledEntries: [],
  lastBackup: null,
  lastRestore: null,
  connection: null,
  pendingRestore: null,
  backupMeta: null,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {*} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} base @param {unknown} patch */
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return next;
}

/**
 * @param {{ logger?: Function | object }} ctx Cordis context（只用到 logger）
 */
export function createCore(ctx) {
  const home = homeDirectory();
  const env = process.env;
  const dshHome = defaultDshHome(home);
  // quarkclouddrive skill 的安装位置随宿主 agent 不同（.dsh 是文档约定，.agents/.claude 是
  // agent 通用目录，.codeium/windsurf 是 windsurf 时代遗留）。按序探测第一个存在的副本；
  // 都找不到时回退到文档默认路径，让错误信息指向规范位置。
  const cliCandidates = [
    typeof env.QUARK_CLI === 'string' ? env.QUARK_CLI.trim() : '',
    join(dshHome, 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs'),
    join(home, '.agents', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs'),
    join(home, '.codeium', 'windsurf', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs'),
    join(home, '.claude', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs'),
    join(home, '.devin', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs'),
  ].filter((p) => p !== '');
  const cliPath = cliCandidates.find((p) => existsSync(p)) || cliCandidates[0];
  const dataDir = env.DSH_MAINTENANCE_DIR || join(home, '.dsh-maintenance');
  const restoreDir = join(dataDir, 'restore');
  const paths = {
    home,
    dshHome,
    workspace: defaultWorkspaceDir(home),
    syncDir: defaultSyncDir(home),
    dataDir,
    restoreDir,
    nativeDir: join(dataDir, 'native'),
    stateDir: join(dataDir, 'state'),
    nativeFingerprintFile: join(dataDir, 'state', 'native-fingerprint.json'),
    stagingRoot: join(restoreDir, 'staging'),
    safetyDir: join(restoreDir, 'safety'),
    tasksDir: join(dataDir, 'tasks'),
    logsDir: join(dataDir, 'logs'),
    pendingFile: join(restoreDir, 'pending.json'),
    stateFile: join(dataDir, 'state.json'),
    scheduleFile: join(dataDir, 'schedule.json'),
    taskFile: join(dataDir, 'task.json'),
    lockFile: join(dataDir, 'lock.json'),
    logFile: join(dataDir, 'logs', 'maintenance.log'),
    syncLogFile: join(defaultSyncDir(home), 'logs', 'sync.log'),
    backupMetaFile: join(dataDir, 'backup-meta.json'),
    profileDir: env.DSH_PROFILE_DIR || join(dshHome, 'profiles', 'desktop'),
    profilePatch: join(env.DSH_PROFILE_DIR || join(dshHome, 'profiles', 'desktop'), 'cordis.patch.yml'),
    selfPackageDir: dirname(dirname(fileURLToPath(import.meta.url))),
    syncScript: join(defaultSyncDir(home), 'sync.sh'),
    scopeScript: join(defaultSyncDir(home), 'scope.sh'),
    cliPath,
    cliCandidates,
    configFile: join(dataDir, 'config.json'),
  };

  let state = { ...DEFAULT_STATE() };
  let inMemoryLock = null;
  let cachedTask = null;

  function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
  }

  for (const dir of [
    paths.dataDir,
    paths.logsDir,
    paths.tasksDir,
    paths.restoreDir,
    paths.stagingRoot,
    paths.safetyDir,
    paths.nativeDir,
    paths.stateDir,
  ]) {
    ensureDir(dir);
  }

  const nodeRuntime = resolveNodeCommand();

  function now() {
    return Date.now();
  }

  function uuid() {
    return `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function log(message, level = 'info') {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
    try {
      if (existsSync(paths.logFile) && statSync(paths.logFile).size > MAX_LOG_BYTES) {
        for (let i = LOG_ROTATE_KEEP; i >= 1; i -= 1) {
          const from = `${paths.logFile}.${i}`;
          if (existsSync(from)) {
            try {
              renameSync(from, `${paths.logFile}.${i + 1}`);
            } catch {
              /* ignore */
            }
          }
        }
        renameSync(paths.logFile, `${paths.logFile}.1`);
      }
      appendFileSync(paths.logFile, `${line}\n`, 'utf8');
    } catch {
      /* 日志失败不影响业务 */
    }
    try {
      const sink = typeof ctx?.logger === 'function' ? ctx.logger('dsh-maintenance') : ctx?.logger;
      const emit = level === 'error' ? sink?.error : level === 'warn' ? sink?.warn : sink?.info;
      if (typeof emit === 'function') emit.call(sink, message);
    } catch {
      /* ignore */
    }
  }

  function readJson(file, fallback) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  /**
   * 原子替换：Windows 上目标文件被杀毒/索引/另一个读者短暂占用时 rename 会抛
   * EPERM/EACCES/EBUSY，短暂重试即可；最终失败时清理临时文件并抛出。
   */
  function replaceFile(tmp, file) {
    const attempts = IS_WINDOWS ? 6 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        renameSync(tmp, file);
        return;
      } catch (error) {
        const transient = error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY');
        if (!transient || attempt >= attempts) {
          try {
            unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
      }
    }
  }

  function writeJson(file, value) {
    ensureDir(dirname(file));
    const tmp = `${file}.${process.pid}.${now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    replaceFile(tmp, file);
  }

  function readText(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  function writeText(file, text) {
    ensureDir(dirname(file));
    const tmp = `${file}.${process.pid}.${now()}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    replaceFile(tmp, file);
  }

  function loadState() {
    const loaded = readJson(paths.stateFile, null);
    state = isPlainObject(loaded) ? deepMerge(DEFAULT_STATE(), loaded) : DEFAULT_STATE();
    return state;
  }

  function getState() {
    return state;
  }

  function updateState(patch) {
    state = deepMerge(state, patch);
    writeJson(paths.stateFile, state);
    return state;
  }

  function getTask() {
    if (cachedTask) return cachedTask;
    const disk = readJson(paths.taskFile, null);
    cachedTask = isPlainObject(disk) ? disk : null;
    return cachedTask;
  }

  function setTask(task) {
    cachedTask = task;
    if (task) writeJson(paths.taskFile, task);
    else {
      try {
        unlinkSync(paths.taskFile);
      } catch {
        /* ignore */
      }
    }
  }

  function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error && error.code === 'EPERM';
    }
  }

  function lockIsAlive(lock) {
    if (!isPlainObject(lock)) return false;
    if (lock.hostPid !== undefined && lock.hostPid !== process.pid) {
      // 别的 DSH 进程留下的锁：按 pid 判断
      return processAlive(lock.hostPid) && now() - (lock.startedAt || 0) < LOCK_STALE_MS;
    }
    return processAlive(lock.pid) && now() - (lock.startedAt || 0) < LOCK_STALE_MS;
  }

  function getLock() {
    if (inMemoryLock) return inMemoryLock;
    const disk = readJson(paths.lockFile, null);
    if (!isPlainObject(disk)) return null;
    if (lockIsAlive(disk)) return disk;
    try {
      unlinkSync(paths.lockFile);
    } catch {
      /* ignore */
    }
    return null;
  }

  /** @returns {{kind:string,pid:number,startedAt:number}|null} 拿不到锁返回 null */
  function acquireLock(kind) {
    if (getLock()) return null;
    const lock = { kind, pid: process.pid, hostPid: process.pid, startedAt: now() };
    try {
      const fd = openSync(paths.lockFile, 'wx');
      try {
        writeFileSync(fd, JSON.stringify(lock));
      } finally {
        closeSync(fd);
      }
      inMemoryLock = lock;
      return lock;
    } catch {
      // 竞争失败：只在文件确实是陈旧锁时重试一次
      const disk = readJson(paths.lockFile, null);
      if (isPlainObject(disk) && !lockIsAlive(disk)) {
        try {
          unlinkSync(paths.lockFile);
          const fd = openSync(paths.lockFile, 'wx');
          try {
            writeFileSync(fd, JSON.stringify(lock));
          } finally {
            closeSync(fd);
          }
          inMemoryLock = lock;
          return lock;
        } catch {
          /* fallthrough */
        }
      }
      return null;
    }
  }

  function releaseLock(kind) {
    const lock = inMemoryLock;
    if (!lock) return;
    if (kind && lock.kind !== kind) return;
    inMemoryLock = null;
    const disk = readJson(paths.lockFile, null);
    if (!isPlainObject(disk) || disk.pid === process.pid) {
      try {
        unlinkSync(paths.lockFile);
      } catch {
        /* ignore */
      }
    }
  }

  /** 跨进程 + 同进程互斥；fn 正常/异常都会释放锁。 */
  async function withLock(kind, fn) {
    const lock = acquireLock(kind);
    if (!lock) return { ok: false, busy: true, lock: getLock() };
    try {
      return await fn(lock);
    } finally {
      releaseLock(kind);
    }
  }

  function isBusy() {
    return getLock() !== null;
  }

  function childEnv(extra = {}, options = {}) {
    const base = buildChildEnv(env, {
      home,
      dshHome,
      nodeEnv: options.node ? nodeRuntime.env : undefined,
    });
    if (!base.DSH_SESSION_ID) base.DSH_SESSION_ID = `dsh-maintenance-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return { ...base, ...extra };
  }

  /**
   * 运行 Node 脚本（夸克 CLI 等）：Windows 上没有系统 node，会用 Electron Node-mode。
   * @param {string[]} args
   * @param {{timeoutMs?: number, env?: Record<string,string>, cwd?: string}} [options]
   */
  function runNode(args, options = {}) {
    return run(nodeRuntime.command, args, { ...options, env: { ...(options.env || {}), ...nodeRuntime.env }, node: true });
  }

  function run(cmd, args, options = {}) {
    const { timeoutMs = 120000, env: extraEnv = {}, cwd, input = null } = options;
    const started = now();
    return new Promise((resolve) => {
      let settled = false;
      const child = execFile(
        cmd,
        args,
        {
          cwd,
          env: childEnv(extraEnv, { node: Boolean(options.node) }),
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 16 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (settled) return;
          settled = true;
          const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
          resolve({
            ok: !error,
            code,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: error ? String(error.message ?? error) : null,
            durationMs: now() - started,
          });
        },
      );
      if (input != null && child.stdin) {
        child.stdin.end(String(input));
      }
    });
  }

  /**
   * 流式运行子进程；onLine 收到 stdout/stderr 的每一行（stderr 以 level=warn 传入）。
   * @returns {{child: import('node:child_process').ChildProcess, done: Promise<{code:number|null,signal:string|null}>, kill: (signal?:string)=>void}}
   */
  function spawnStream(cmd, args, options = {}) {
    const { env: extraEnv = {}, cwd, onLine } = options;
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv(extraEnv, { node: Boolean(options.node) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const feed = (stream, level) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line.trim()) onLine?.(line, level);
        }
      });
      stream.on('end', () => {
        if (buffer.trim()) onLine?.(buffer.trim(), level);
      });
    };
    feed(child.stdout, 'out');
    feed(child.stderr, 'warn');
    const done = new Promise((resolve) => {
      child.on('error', () => resolve({ code: -1, signal: null }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    return {
      child,
      done,
      kill(signal = 'SIGKILL') {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
      },
    };
  }

  function tailLog(lines = 100) {
    const text = readText(paths.logFile) || '';
    const all = text.split('\n').filter((line) => line.length > 0);
    return all.slice(-lines);
  }

  function walkFiles(root, options = {}) {
    const { excludeNames = new Set(), maxFiles = 50000, maxDepth = 40 } = options;
    /** @type {Array<{path:string,abs:string,size:number,mtimeMs:number}>} */
    const out = [];
    function visit(dir, prefix, depth) {
      if (out.length >= maxFiles || depth > maxDepth) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (excludeNames.has(entry.name)) continue;
        const abs = join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          visit(abs, rel, depth + 1);
        } else if (entry.isFile()) {
          let info;
          try {
            info = statSync(abs);
          } catch {
            continue;
          }
          out.push({ path: rel, abs, size: info.size, mtimeMs: info.mtimeMs });
          if (out.length >= maxFiles) return;
        }
      }
    }
    visit(root, '', 0);
    return out;
  }

  function sha256File(file) {
    const hash = createHash('sha256');
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let read = 0;
      while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, read));
      }
    } finally {
      closeSync(fd);
    }
    return hash.digest('hex');
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
  }

  loadState();

  const core = {
    paths,
    platform: PLATFORM,
    isWindows: IS_WINDOWS,
    platformInfo,
    nodeRuntime,
    runNode,
    now,
    uuid,
    sleep,
    log,
    ensureDir,
    readJson,
    writeJson,
    readText,
    writeText,
    getState,
    updateState,
    loadState,
    getTask,
    setTask,
    acquireLock,
    releaseLock,
    getLock,
    withLock,
    isBusy,
    childEnv,
    run,
    spawnStream,
    tailLog,
    walkFiles,
    sha256File,
    formatBytes,
    processAlive,
    removeTree(target) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
    pathExists: (target) => existsSync(target),
    statSafe(target) {
      try {
        return statSync(target);
      } catch {
        return null;
      }
    },
    listDirSafe(dir) {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    },
    basename,
  };
  core.log(`插件运行态目录: ${dataDir}`, 'info');
  return core;
}
