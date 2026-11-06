# Windows 兼容改造（2026-11-04）

目标：同一份插件在 macOS 与 Windows 上都能完成备份 / 定时 / 快照 / 两阶段还原。
Windows 上的硬约束：

- **没有 bash / rsync**（DSH Windows 用 PowerShell；Git Bash 不能假设存在）；
- **有 Node**（DSH Desktop 的 Electron Node-mode，`ELECTRON_RUN_AS_NODE=1`）；
- **Windows 10 1803+ 自带 `System32\tar.exe`**（bsdtar，支持 `-czf`/`-xzf`/`--exclude`）；
- `Documents` 目录可能被 OneDrive 重定向；
- 目录符号链接需要权限，`node_modules` 直接用 junction。

## 架构：插件不再依赖 `sync.sh` / `scope.sh`

原实现 spawn `~/.dsh-sync/sync.sh`、`scope.sh`（bash + rsync + macOS 的 `stat -f` / `shasum`），
只在 macOS 成立。改造后：

```
                          ┌─────────────────────────────┐
   Host 插件（跨平台）     │ host/native/                │
   ─────────────────────  │  config.js   解析/生成同步配置 │
                          │  scope.js    范围统计（纯 Node）│
                          │  backup.js   指纹→打包→扫描→上传→滚动│
                          │  sidecar.js  MANIFEST/RESTORE/小清单│
                          │  secret-scan.js 密钥扫描        │
                          │  rotation.js 保留份数/归档 FID 计算│
                          └─────────────────────────────┘
                                   │ 只是 spawn
                                   ▼
                          node quark-drive.cjs upload/browse/move/download
```

- `sync.sh` / `scope.sh` **保留**给 macOS 手动排查/旧脚本用户；插件默认不再执行它们。
  （可用环境变量 `DSH_MAINTENANCE_ENGINE=sync.sh` 强制旧引擎，仅 POSIX。）
- 备份语义保持一致：全量快照 tar.gz + sidecar 清单、5 份滚动、`_archive`、密钥扫描、
  `node_modules/.git/.DS_Store/*.log/*.tmp/.turbo` 排除、夸克 Skill 运行时目录排除（防自激）。
- 备份配置的**唯一事实来源**：
  1. `~/.dsh-sync/config.json`（若存在，便携配置，Windows 推荐）；
  2. 否则解析 `~/.dsh-sync/config.sh`（macOS 现状，保留原有自定义）；
  3. 否则按内置默认条目生成（Windows 首次运行即用）。
  另外始终合并 profile `package.json` 里的 `link:` 本地插件（自动发现）。
- 指纹状态改存 `~/.dsh-maintenance/state/native-fingerprint.json`，与旧 `sync.sh` 的
  `last.hash` 分开，避免两个引擎互相误判。

## 新增模块接口

### `host/platform.js`（Lead 已实现）

```js
IS_WINDOWS, PLATFORM
homeDirectory(), defaultDshHome(), defaultWorkspaceDir(), defaultSyncDir()
resolveNodeCommand() -> { command, env: { ELECTRON_RUN_AS_NODE? }, source }
resolveTarCommand() -> 'C:\\Windows\\System32\\tar.exe' | '/usr/bin/tar'
resolveBashCommand() -> string | null        // Windows = null
buildChildEnv(baseEnv, { home, dshHome, nodeEnv })
pathInside(parent, child, platform = PLATFORM)  // Windows 盘符 + 大小写不敏感
platformInfo()
```

### `host/mirror.js`（Lead 已实现）

```js
compileExcludes(patterns) -> (relativePath) => boolean
mirrorDirectory({ source, target, excludes, signal, onLog, onProgress })
  -> { files, bytes, removed, warnings, errors, sourceEntries }
summarizeTree(root, excludes) -> { files, bytes, entries }
```

替代 `rsync -a --delete`；支持文件/目录/符号链接、mtime、POSIX 权限、排除子树；
返回 `errors[]`，调用方决定是否抛错。

### `host/native/config.js`（native-engine owner）

```js
export async function loadNativeConfig(core, options = {})
// options: { platform?, keep? , home?, workspace?, dshHome?, syncDir? }（测试注入用）
// -> {
//   source: 'config.json' | 'config.sh' | 'defaults',
//   dshFid, archiveFid, keep,
//   entries: [{ src, dest, discovered }],   // src 绝对路径；dest 包内 posix 路径
//   pruneAbs: string[],                      // 绝对路径（整棵跳过）
//   excludes: string[],                      // 名字/后缀/相对路径模式
//   disabledEntries: string[],               // 来自 core.getState().disabledEntries
// }
```

规则：

- `config.json` 字段同上；存在即优先。
- `config.sh`：写一个安全的行式解析器，支持 `NAME=( "a|b" "c|d" )` 多行数组、
  `NAME="value"`、注释；展开 `$HOME`/`~`/`${HOME}`。解析失败退回 defaults 并写 warning。
- defaults：与当前 `config.sh` 的固定条目一致（`dsh-home/*`、`workspace/*`、`dsh-sync`），
  自动发现逻辑：读取 `dshHome/profiles/*/package.json` 的 dependencies/devDependencies/
  optionalDependencies 中 `link:`/`file:` 的绝对/相对路径，去重（父目录已覆盖则跳过），
  dest = `workspace/<basename>`。
- `pruneAbs` 默认：`dshHome/skills/quarkclouddrive/{deepseek,browse}`、`dsh-sync/{state,logs}`，
  再加上 `config.json`/`config.sh` 里的值。
- keep 默认 5（`options.keep` > config > 5），限制 1..10。

### `host/native/scope.js`（native-engine owner）

```js
export async function buildScopeReport({ core, config, keep, platform })
// -> 与旧 scope.sh 输出同构：
// { ok, generatedAt, keep, dshFid, archiveFid, entries:[{src,dest,label,exists,readable,
//   files,bytes,discovered,disabled,warning}], excluded:[{path,reason}], notes:[string],
//   totals:{files,bytes,enabledEntries}, source }
```

### `host/native/backup.js`（native-engine owner）

```js
export async function runNativeBackup({
  core, quark, config, keep, force, trigger, signal, onEvent,
}) -> {
  ok, skipped, snapshotName, sizeMB, archived, partial, durationMs,
  fileCount, totalBytes, sidecarName, warnings
}
```

- `onEvent({ stage, label?, progress?, line? })`，stage ∈
  `prepare|pack|scan|upload|archive|done|skip|error`。`line` 追加到 UI 日志。
- 失败抛错（中文、可展示）；**不可读目录必须失败、不生成残缺快照**。
- 打包：`tar -czf`；若 tar 不支持 gzip，则 `tar -cf` + node:zlib 压缩成 `.tar.gz`。
- 上传：`quark.upload(tar, config.dshFid)` → 成功后上传 sidecar（失败只 warning）。
- 滚动：`quark.browseAll(config.dshFid)` → 按 tar 名倒序保留 `keep` 份；把超出的 tar 与
  对应/更旧的 sidecar FID 一起 `quark.move(fids, config.archiveFid)`。
- 成功后写 `~/.dsh-maintenance/state/native-fingerprint.json`（hash/files/bytes/at/trigger/platform），
  清理 stage/tar（`DSH_MAINTENANCE_KEEP_STAGE=1` 可保留排查）。
- `force=false` 且指纹一致 → `onEvent({stage:'skip'})` 返回 `{skipped:true}`（不触碰网盘）。
- 目录结构：`<stage>/dsh-home/...`、`<stage>/workspace/...`、`<stage>/dsh-sync/...`，
  外加 `MANIFEST.json`、`RESTORE.md`（与旧快照兼容，供还原使用）。

### `host/native/sidecar.js`（native-engine owner）

```js
export function buildStagedFileList(stageDir) -> Array<[path, size]>
export function buildSidecar({ snapshotName, archivePath, archiveSha256, files, entries, partial, createdAt })
export function writeManifestAndRestore(stageDir, { snapshotName, files, entries, platform, engine, partial })
```

sidecar 字段与现有 `make-sidecar.cjs` 一致（`schema,name,created_at,hostname,archive_sha256,archive_size,
file_count,total_bytes,partial,entries,files`），保证还原预览兼容。

### `host/native/rotation.js`（native-engine owner，纯函数）

```js
export function planRotation(browseEntries, keep) -> { kept: string[], pruneFids: string[], pruned: string[] }
// 兼容旧快照（无 sidecar）；sidecar 与对应 tar 一起归档；孤儿 sidecar 按时间边界处理
```

### `host/native/secret-scan.js`（native-engine owner）

```js
export function scanSecrets(stageDir) -> { hits: string[], testHits: string[], scanned: number }
// 正则：sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----
// 测试路径（/test|tests|__tests__|fixtures/ 或 *.spec|test.*）只告警；二进制/超大文件跳过。
```

## 还原引擎改造（restore-engine owner）

`host/restore.js`：

- 删除 `TAR` / `RSYNC` 常量与 `/usr/bin/*` 探测；改用
  `resolveTarCommand()`（`core.run(tar, args)`）与 `mirrorDirectory()`。
- `apply`：把 `rsync -a --delete ...` 换成
  `mirrorDirectory({ source: snapshotDir, target: safeTarget, excludes: [...BASE_EXCLUDES, ...protectedExcludes(prefix).tar], signal, onLog })`；
  `errors.length > 0` 时抛错（消息里带前 3 条）。
- `rollback`：解压安全副本到 tmp 后用 `mirrorDirectory` 回镜像。
- `assertSafeTarget` 用 `pathInside()`（Windows 大小写不敏感/盘符），root 相等拒绝。
- `stagingDirFor` 用 `pathInside()` 判断。
- 安全副本 tar 使用 `resolveTarCommand()`；macOS/Windows 的 bsdtar 都支持 `-czf/--exclude`。
- 新增测试：mirror-based apply/rollback 全套（原 24 项应保留），另加 Windows 路径语义单元测试
  （`pathInside` 用 `platform='win32'`；`assertSafeTarget` 可注入 `platform` 选项）。

## 其余 Lead 负责的接线

- `core.js`：路径用 `platform.js` 默认值；`childEnv` 用 `buildChildEnv`；新增 `runNode()`；
  `spawnStream` 在 Windows 上不做 Unix 信号假设。
- `quark.js`：用 `core.runNode()` 而不是写死 `node`。
- `scope.js`：改为调用 native scope。
- `backup.js`：默认调用 native 引擎（事件驱动），保留 `DSH_MAINTENANCE_ENGINE=sync.sh` 旧引擎。
- `routes.js`：重启分支（Windows 用 `taskkill` + `start`）、`symlink` 失败回退 junction、
  `health` 暴露 platform/engine。
- `sync-tools.js`：仅 POSIX 执行；Windows 不复制 .sh。
- 文档/测试：Windows 安装说明、限制（未在真实 Windows 上跑过）、`test/windows-sim.mjs`
  （platform/path/mirror 的跨平台单元验证）。

## 验收（macOS 上必须全部通过）

1. `node test/native-unit.mjs` — native 引擎单测（config/scope/sidecar/rotation/scan/镜像/打包）。
2. `node test/restore-unit.mjs` — 24+ 项（mirror 版）。
3. `node test/backup-driver.mjs` — 真实云端备份一次（native 引擎），结果含 snapshotName/archived。
4. `node test/restore-e2e-cloud.mjs` — 真实快照 → /tmp 沙箱两阶段还原 + 回滚。
5. 插件热重载后 HTTP `/backup/start` 阶段/日志/结果正确；无变更第二次 `skipped`。
6. `node test/host-smoke.mjs` — 连接/范围（native）/策略。

Windows 上无法在本机验证的部分（明确写入交付说明）：`System32\tar.exe` 实际行为、
Electron Node-mode 运行夸克 CLI、盘符/OneDrive 路径、taskkill 重启。


## 实施状态（2026-11-04 18:20）

已完成：`host/platform.js`、`host/mirror.js`、`host/native/*`（config/scope/backup/sidecar/rotation/secret-scan）、
`host/restore.js` 跨平台化、`core/quark/scope/backup/routes/schedule/sync-tools` 接线、Windows 重启分支、
`test/native-unit.mjs`（11 组）、`test/windows-sim.mjs`（12 项）、restore 单测 28 项、真实云端备份/还原回归。

真实 Windows 未运行验证，未覆盖项见 README「已知限制」与 `docs/TEST-REPORT.md`。
