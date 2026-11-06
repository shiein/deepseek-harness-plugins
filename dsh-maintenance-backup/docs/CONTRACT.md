# 「网盘备份维护」插件内部契约（Lead 维护，其他 agent 只读）

插件包：`@local/dsh-maintenance-backup`，源码目录 `~/Documents/workspace/dsh-maintenance-backup/`。
Host 半运行在 DSH 主进程（Node 24 / Electron Node mode），Client 半运行在 Web GUI（React，来自模块表）。

## 运行态目录（绝不在备份范围内）

`~/.dsh-maintenance/`（可用 `DSH_MAINTENANCE_DIR` 覆盖）：

```
state.json             运行态：策略副本、最近备份/还原、连接缓存、禁用条目
schedule.json          策略的即时副本（与 state.json 同步）
lock.json              全局任务锁（backup / restore 互斥）
logs/maintenance.log   插件日志（轮转 2MB）
task.json              当前/最近任务快照（插件重载后用于恢复 UI）
restore/pending.json   两阶段还原 marker（启动时检测）
restore/staging-<ts>/  阶段一解压暂存
restore/safety/        还原前本地安全副本（tar.gz，保留 1 份）
tasks/                 夸克 CLI 的 browse/download 临时目录
backup-meta.json       最近一次备份成功后的元数据（快照名、耗时、归档数）
```

## 数据模型

```ts
Connection = {
  state: 'connected' | 'unauthorized' | 'error' | 'unknown'
  nickname: string | null
  vipType: string | null          // 'SVIP' | 'VIP' | '普通用户' …
  capacity: number | null         // bytes
  used: number | null             // bytes
  expiresAt: number | null        // epoch ms
  message: string                 // 中文说明
  code: number | null             // 夸克 CLI code
  checkedAt: number | null
  stale: boolean                  // 缓存超过 90s
}

BackupTask = {
  id: string
  kind: 'backup' | 'restore'
  phase: 'idle' | 'running' | 'success' | 'failed' | 'skipped'
  stage: string                   // prepare|pack|scan|upload|archive|done|error
                                  // restore: download|extract|verify|diff|safety|apply|finalize
  stageLabel: string              // 中文阶段名
  progress: number                // 0-100 粗粒度
  startedAt: number
  finishedAt: number | null
  error: string | null
  result: object | null
  logTail: string[]               // 最近 120 行
}

Scope = {
  ok: true
  generatedAt: number
  keep: number
  dshFid: string
  archiveFid: string
  entries: Array<{
    src: string                   // 本地绝对路径
    dest: string                  // 包内路径
    label: string                 // 展示名（basename）
    exists: boolean
    readable: boolean
    files: number
    bytes: number
    discovered: boolean           // 通过 link: 自动发现
    disabled: boolean             // 用户在面板里禁用
    warning: string | null
  }>
  excluded: Array<{ path: string; reason: string }>
  notes: string[]
  totals: { files: number; bytes: number; enabledEntries: number }
}

Schedule = {
  enabled: boolean
  intervalMinutes: number         // 15 | 60 | 360 | 1440 之一，也接受 5..10080
  keep: number                    // 1..10
  watch: boolean                  // fs.watch 变更即备份
  debounceSeconds: number         // 30 | 60 | 120 | 300
  persistedTo: 'profile-patch' | 'local'
  nextRunAt: number | null
}

Snapshot = {
  name: string                    // dsh-snap-YYYY-MM-DD_HHMMSS.tar.gz
  fid: string
  size: number
  createdAt: number | null        // 从文件名解析的本地时区 epoch ms
  sidecarFid: string | null
  sidecarSize: number | null
  ageDays: number
}

ManifestPreview = {
  available: boolean
  source: 'sidecar' | 'tar' | 'none'
  manifest: {
    name?: string
    created_at?: string
    hostname?: string
    file_count?: number
    approx_size_mb?: number
    partial?: boolean
    archive_sha256?: string
    entries?: Array<{ dest: string; files: number; bytes: number }>
    files?: Array<[string, number]>
  } | null
}

Diff = {
  scope: 'all' | 'config' | 'workspace'
  includeSelf: boolean
  counts: { added: number; overwritten: number; deleted: number; unchanged: number }
  bytes: { added: number; overwritten: number; deleted: number }
  samples: { added: string[]; overwritten: string[]; deleted: string[] }  // 每类最多 100 条
  targets: Array<{ prefix: string; target: string; counts: {...} }>
  protected: Array<{ path: string; reason: string }>
  warnings: string[]
}

Staging = {
  stagingId: string
  snapshotName: string
  scope: 'all' | 'config' | 'workspace'
  includeSelf: boolean
  dir: string
  createdAt: number
  archiveBytes: number
  diff: Diff
}

PendingRestore = {
  id: string
  snapshotName: string
  scope: string
  includeSelf: boolean
  phase: 'applying' | 'applied'
  startedAt: number
  finishedAt: number | null
  safetyPath: string | null
  targets: Array<{ prefix: string; target: string }>
  result: object | null
}

Overview = {
  ok: true
  version: string
  dataDir: string
  syncDir: string
  connection: Connection
  backup: { task: BackupTask | null; last: object | null }
  schedule: Schedule
  restore: {
    task: BackupTask | null
    pending: PendingRestore | null
    last: object | null
    safetyBackups: Array<{ path: string; createdAt: number; bytes: number }>
  }
  counts: { snapshots: number | null; snapshotsLoading: boolean; scopeFiles: number | null; scopeBytes: number | null }
  lock: { kind: 'backup' | 'restore' | null; since: number | null }
  warnings: string[]
}
```

## HTTP API（全部 loopback-only，JSON，`{ok:true,...}` / `{ok:false,error}`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/dsh-maintenance/overview` | — | Overview |
| GET | `/api/dsh-maintenance/scope?refresh=1` | — | `{ok, scope: Scope}` |
| POST | `/api/dsh-maintenance/scope/toggle` | `{src, enabled}` | `{ok, scope: Scope}` |
| POST | `/api/dsh-maintenance/connection/refresh` | — | `{ok, connection}` |
| POST | `/api/dsh-maintenance/connection/login` | `{token}` | `{ok, connection}`（token 为空或非法时 400） |
| GET | `/api/dsh-maintenance/backup/status` | — | `{ok, task: BackupTask|null, last}` |
| POST | `/api/dsh-maintenance/backup/start` | `{force?:boolean}` | `{ok, task}`；忙碌 409 |
| POST | `/api/dsh-maintenance/backup/cancel` | — | `{ok, task}` |
| GET | `/api/dsh-maintenance/snapshots?refresh=1` | — | `{ok, snapshots: Snapshot[], archiveCount: number}` |
| POST | `/api/dsh-maintenance/snapshots/preview` | `{name}` | `{ok, preview: ManifestPreview}` |
| POST | `/api/dsh-maintenance/restore/stage` | `{name, scope, includeSelf}` | `{ok, staging: Staging}`；忙碌 409 |
| POST | `/api/dsh-maintenance/restore/apply` | `{stagingId, scope, includeSelf}` | `{ok, result}`（restartRequired=true） |
| POST | `/api/dsh-maintenance/restore/discard` | `{stagingId}` | `{ok}` |
| POST | `/api/dsh-maintenance/restore/rollback` | — | `{ok, result}` |
| POST | `/api/dsh-maintenance/restore/ack` | — | `{ok}`（清除 pending marker） |
| GET | `/api/dsh-maintenance/logs?lines=200` | — | `{ok, lines: string[]}` |
| POST | `/api/dsh-maintenance/schedule` | `{enabled, intervalMinutes, keep, watch, debounceSeconds}` | `{ok, schedule: Schedule}` |
| POST | `/api/dsh-maintenance/restart` | `{confirm:true}` | `{ok, method, instructions}` |
| GET | `/api/dsh-maintenance/health` | — | 诊断信息 |

`BackupTask` 轮询：`GET /backup/status` 每 1.5–2s，直到 `phase !== 'running'`。

## Host 模块接口（供 restore.js 等内部使用）

`host/core.js` 导出：`createCore(ctx)` → `core`：

```js
core.paths         // { home, dshHome, workspace, syncDir, dataDir, restoreDir, stagingRoot,
                   //   safetyDir, tasksDir, pendingFile, stateFile, logFile, profileDir,
                   //   selfPackageDir, syncScript, scopeScript, cliPath }
core.now()         // epoch ms
core.uuid()        // 短 id
core.log(msg, level='info')            // 写日志 + ctx.logger
core.ensureDir(dir)
core.readJson(path, fallback)
core.writeJson(path, value)            // 原子写
core.readText(path)
core.writeText(path, text)
core.walkFiles(root, {excludeNames})   // [{path(相对), size, abs}]（不跟随符号链接）
core.sha256File(path)                  // hex
core.formatBytes(n)
core.state                          // 读 state.json 后的对象
core.updateState(patch)                // merge + 持久化
core.getTask() / core.setTask(task)    // task.json
core.acquireLock(kind) / core.releaseLock(kind) / core.getLock() / core.withLock(kind, fn)
core.run(cmd, args, {timeoutMs, env, input}) -> {code, stdout, stderr, durationMs}
core.spawnStream(cmd, args, {env, onLine}) -> {child, done:Promise<{code,signal}>, kill()}
core.tailLog(lines)
core.isBusy()
```

`host/quark.js` 导出 `createQuark(core)`：

```js
quark.sessionArgs              // ['--session-input', '…', '--session-id', '…']
quark.call(args, {timeoutMs})  // 运行 CLI，返回 {ok, code, msg, data, type, lines}
quark.getUserInfo()            // -> {state, nickname, vipType, capacity, used, expiresAt, code, message}
quark.login(token)             // -> {ok, code, msg}
quark.browseAll(parentFid)     // -> {ok, entries:[{fid,filename,size,createdAt,updatedAt,fileType}]}
quark.download(fid, outDir, {name}) // -> {ok, path, code, msg}
quark.upload(path, parentFid)
quark.move(fids, targetFid)
quark.classifyError(code, msg) // 'unauthorized' | 'network' | 'other'
```

## 文件所有权（并行开发不重叠）

| 文件 | owner |
|---|---|
| `host/core.js`, `host/quark.js`, `host/backup.js`, `host/scope.js`, `host/schedule.js`, `host/routes.js`, `index.js` | Lead |
| `host/restore.js`, `test/restore-unit.mjs` | restore teammate |
| `client.js` | client teammate |
| `~/.dsh-sync/sync.sh`, `scope.sh`, `parse-browse.cjs`, `make-sidecar.cjs`, `config.sh` | Lead |
| `test/quark-probe.mjs`, `docs/QUARK-CLI-NOTES.md` | probe teammate |

除自己 owner 的文件外不要修改任何文件；不要运行 `plugin_manager`、不要重启/杀掉 DSH、不要动
`~/.dsh/profiles/`、不要做破坏性还原测试。

## 实现增量（2026-11-04 联调后）

- `createRestoreEngine({ core, quark, logger, resolveSources })`：`resolveSources` 返回当前
  `config.sh` + link: 发现结果 `[{src, dest}]`，用于把包内 `workspace/<x>` 映射回真实本地路径
  （`workspace/plugins` 实际对应 `~/Documents/workspace/dsh/plugins`）。精确 dest → basename 唯一 → 默认路径兜底。
- `apply()` 写入的 marker 增加 `applyPid`；`finalizeOnStartup()` 发现 `applyPid === process.pid` 时
  只返回 `{sameProcess:true}`，保留 marker 等待真正重启后收尾。
- `overview` 额外返回顶层 `archiveCount`（`dsh/_archive` 条目数，5 分钟缓存）。
- `GET /health` 额外返回 `syncLogFile` 等诊断字段。
- 备份阶段来源：`~/.dsh-sync/logs/sync.log` 中的 `STAGE=` 标记（不是插件自身日志）。


## 2026-11-04 跨平台改造（native engine）

- 备份链路不再依赖 `sync.sh`。`host/backup.js` 调用 `host/native/backup.js`：
  `loadNativeConfig(core, {keep})` → `runNativeBackup({core, quark, config, keep, force, trigger, signal, onEvent})`；
  onEvent 为 `{stage,label,progress,line}`（prepare/pack/scan/upload/archive/done/skip/error）。
- 范围报告由 `host/native/scope.js#buildScopeReport` 生成，与配置解析同源；`scope.sh` 不再被插件调用。
- 配置优先级：`~/.dsh-sync/config.json` → `~/.dsh-sync/config.sh`（安全行式解析，不执行 bash）→ 内置默认。
- 跨平台工具：`host/platform.js`（resolveNodeCommand/resolveTarCommand/pathInside/buildChildEnv）、
  `host/mirror.js`（替代 rsync）。
- 还原引擎 `createRestoreEngine` 新增可选 `platform` 参数；tar 通过 `resolveTarCommand()`；
  apply/rollback 用 `mirrorDirectory`；安全副本仍为 tar.gz。
- `/health` 增加 `engine: 'native'`、`platform`（label/home/workspace/node/tar/bash）。
- 运行态新增 `~/.dsh-maintenance/state/native-fingerprint.json`（仅上传成功后写）。

## 2026-11-05 目录 FID 同源

- `createRestoreEngine` 新增可选 `resolveFolders: async () => ({ dshFid, archiveFid })`；`index.js` 用
  `loadNativeConfig(core)` 提供，与备份上传目录同源（`config.json` / `config.sh` → env → 内置默认）。
  未提供或解析失败时回退 `DSH_SYNC_DSH_FID` / `DSH_SYNC_ARCHIVE_FID` / 内置默认（与旧行为一致）。
- 引擎导出新增 `folders()`；`overview.archiveCount` 改用 `restore.folders().archiveFid` 计数。
- `overview.warnings` 不再在 Windows 上提示 `sync.sh` 缺失（原生引擎不依赖它）。
