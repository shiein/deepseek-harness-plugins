# 端到端测试记录（2026-11-04）

环境：macOS（Darwin 24.x），DSH Desktop 0.2.1-rc.5（Electron Node-mode Host），Node v24.13.1，
夸克 Skill CLI `1.0.25-876f30d`，账号 `shiein`（SVIP）。所有时间均为 Asia/Shanghai。

> **说明**：第 1–10 节是首轮（macOS + `sync.sh` 引擎）的记录；第 11 节是 2026-11-04 傍晚
> 跨平台（native 引擎）改造后的回归记录。最终交付以第 11 节为准，前 10 节保留为历史对照。

> 破坏性操作均未在真实 `~/.dsh` 上执行：还原测试写入 `/tmp` 沙箱。
> 云端仅发生正常备份/滚动归档；`dsh/_archive` 里有 5 个探针文件（CLI 无删除能力，需手动清理，见文末）。

## 1. 静态检查

| 检查 | 结果 |
|---|---|
| `node --check index.js host/*.js client.js test/*.mjs` | 全部通过 |
| `bash -n ~/.dsh-sync/sync.sh` / `scope.sh` | 通过 |
| `node --check` 同步脚本 cjs 工具 | 通过 |
| 插件 bundle 安装 | `application: applied`（安装后接口立即可用；提示 unmanaged-plugin，刷新/重载插件后状态一致） |
| Client 槽位注册 | `sidebar.panellist` 出现 `dsh-maintenance`（order 40，active）；`main` 出现 `dsh-maintenance`（active） |

## 2. 连接状态 / 备份范围（真实 API）

`GET /api/dsh-maintenance/overview`：

```
connection.state = connected, nickname=shiein, vipType=SVIP,
capacity=6,607,807,184,896 B (6.0 TB), used≈4.71 TB,
expiresAt=1793980800000 (2026-11-07 00:00 CST), stale=false
schedule: enabled=true, intervalMinutes=60, keep=5, watch=true, persistedTo=profile-patch
warnings: [launchd 定时任务仍存在]   ← 卸载 launchd 后消失
```

`GET /api/dsh-maintenance/scope`：12 个条目、4,474 文件 / 41.0 MB，全部可读：

```
32     /Users/aesc/.dsh/profiles              -> dsh-home/profiles
17     /Users/aesc/.dsh/skills                -> dsh-home/skills
1      /Users/aesc/.dsh/agent-assets          -> dsh-home/agent-assets
1181   /Users/aesc/.dsh/plugins               -> dsh-home/plugins
3      /Users/aesc/.dsh/.agent-presets        -> dsh-home/.agent-presets
1      /Users/aesc/.dsh/llm-deepseek          -> dsh-home/llm-deepseek
1      /Users/aesc/.dsh/dsh-claude-style      -> dsh-home/dsh-claude-style
1807   /Users/aesc/Documents/workspace/dsh/plugins      -> workspace/plugins
1347   /Users/aesc/Documents/workspace/dsh-page-preview -> workspace/dsh-page-preview
49     /Users/aesc/Documents/workspace/overview/dsh-agent-usage -> workspace/dsh-agent-usage
8      /Users/aesc/.dsh-sync                  -> dsh-sync
27     /Users/aesc/Documents/workspace/dsh-maintenance-backup -> workspace/dsh-maintenance-backup  [自动发现]
```

自动发现验证：安装后未改 `config.sh`，`workspace/dsh-maintenance-backup` 即以 `discovered=true` 出现。

## 3. 立即备份（真实上传 + 滚动归档 + sidecar）

一次通过 HTTP API 触发的完整备份（`POST /backup/start {"force":true}`，1.5s 轮询）：

```
running prepare  6%  检测变更   logLines=15
running pack    44%  打包
running scan    52%  敏感信息扫描
running upload  62%  上传网盘
running archive 88%  归档旧快照
success done   100%  完成       durationMs=16904

result: { skipped:false, snapshotName:"dsh-snap-2026-11-04_140235.tar.gz",
          sizeMB:13, archived:1, partial:false, trigger:"manual" }
```

`GET /snapshots?refresh=1`（真实云端）：

```
dsh-snap-2026-11-04_140235.tar.gz  12,285,954  sidecar
dsh-snap-2026-11-04_140115.tar.gz  12,285,758  sidecar
dsh-snap-2026-11-04_135926.tar.gz  12,284,880  sidecar
dsh-snap-2026-11-04_135840.tar.gz  12,285,099  sidecar
dsh-snap-2026-11-04_132058.tar.gz  12,153,373  no-sidecar（改造前的旧快照）
archiveCount = 15
```

- `dsh/` 保持 5 份 tar；每次新快照把最旧的 tar（若有 sidecar 则连同 sidecar）移入 `dsh/_archive`。
- sidecar 上传成功：`sidecar 清单已上传: dsh-snap-…manifest.json`。
- 旧快照（无 sidecar）仍可被列表/还原；preview 会提示「旧快照无清单」。

### 无变更不再重复上传（自激循环验证）

备份成功后立刻再跑一次不强制备份：

```
result: {"skipped": true, "durationMs": 204, "trigger": "manual"}
log: 指纹 3fbe8fcb319e3fce… 文件数 4475 / STAGE=fingerprint / 无变更，跳过同步 / STAGE=skip 无变更
```

说明夸克 Skill 运行时目录（`skills/quarkclouddrive/deepseek`）已被正确排除，上传不会触发下一次同步。

## 4. 备份范围启停（UI 开关 → sync.sh 生效）

1. `POST /scope/toggle {"src":"/Users/aesc/.dsh/agent-assets","enabled":false}` → `ok=true, disabled=true`。
2. 触发强制备份；日志出现 `已按面板设置禁用 1 个备份条目`。
3. 拉取该快照 sidecar 预览：`entries` 中**没有** `dsh-home/agent-assets`，其余 11 项不变。
4. 重新启用后 scope 恢复 12 项。

## 5. 并发保护

在一次运行中的备份（约 24s）期间：

```
POST /backup/start   -> 409 {"ok":false,"error":"已有备份或还原任务在运行"}
POST /restore/stage  -> 409 {"ok":false,"error":"已有备份或还原任务在运行"}
```

备份结束后状态恢复 success；`lock.json` 在任务结束时释放。

## 6. 定时策略持久化

`POST /schedule {enabled:true,intervalMinutes:15,keep:5,watch:false,debounceSeconds:60}`：

```
response.schedule.persistedTo = "profile-patch"
```

写入后的 `~/.dsh/profiles/desktop/cordis.patch.yml`（profile 覆盖层）：

```yaml
- id: dsh-maintenance-backup
  name: "@local/dsh-maintenance-backup"
  config:
    schedule:
      enabled: true
      intervalMinutes: 15
      keep: 5
      watch: false
      debounceSeconds: 60
    autoRestart: false
```

该文件在备份范围内，因此策略会随快照走；还原后以恢复出来的 Config 为准。

## 7. 还原引擎单元测试（离线沙箱）

`node test/restore-unit.mjs` → **PASS 24/24**。覆盖：快照列表缓存/刷新、sidecar 预览、
stage 大小与 SHA-256 校验、解压后删除 tar、diff 计数/字节/样例/targets/protected、
apply 安全副本（只留最近一套）、`rsync --delete`、marker applying→applied、
`ensureSelfRegistration` 回调、finalize 清理与 `lastRestore`、中断分支、
rollback 恢复被覆盖/被删除/新增文件并保留 safety、includeSelf=false 保护自身、
resolveSources 精确映射/basename 唯一匹配/缺失兜底，以及运行态目录全链路保护。

## 8. 真实云端快照 → 沙箱两阶段还原 + 回滚

`node test/restore-e2e-cloud.mjs`（DSH_HOME 保持真实以避免 CLI 失联；workspace/运行态指向 /tmp 沙箱，
`scope=workspace`，不触碰真实 `~/.dsh`）：

- `preview`：sidecar 可用，`file_count=4475`，sha256 前缀匹配。
- `stage`：下载 12 MB tar、校验大小与 sha256、解压到 staging（3 个 workspace 目标，3175 文件 / 36.5 MB），
  diff 新增 3175 / 删除 2，`protected` 含 `workspace/dsh-maintenance-backup`。
- `apply`：安全副本 1.22 KB → rsync 落地；`restartRequired=true, selfSkipped=true`；
  - 快照里的新文件落地；
  - 旧文件被删除；
  - `node_modules/.git` 保留（排除项生效）；
  - 维护插件自身未被覆盖（`keep.txt` 仍在）；
  - `dsh-sync/logs` 未被删除。
- `finalizeOnStartup`：marker 删除、staging 清理、`state.lastRestore.pendingAck=true`。
- `rollback`：旧文件与内容恢复、自身仍未被触碰。
- 结果：`PASS —— 云端快照 → 沙箱两阶段还原 + 安全副本回滚 全部通过`，沙箱自动清理。

## 9. launchd 卸载

```
launchctl bootout gui/501/com.aesc.dsh-sync     # 服务已 unload（此前 print 显示 state=not running）
launchctl print gui/501/com.aesc.dsh-sync       # Could not find service
mv ~/Library/LaunchAgents/com.aesc.dsh-sync.plist \
   ~/Library/LaunchAgents/com.aesc.dsh-sync.plist.disabled-20261104
```

插件 overview 的 launchd 警告随 plist 改名消失；定时备份改由插件负责。最终策略：
`enabled=true, intervalMinutes=15, keep=5, watch=true, debounce=60`，已写入 profile 覆盖层。

**变更监听实测**：最后一次备份完成约 40s 后，插件日志出现
`检测到文件变更，触发备份` → `开始备份（trigger=watch force=false）`，
207ms 后 `备份跳过（无变更）`；overview 显示 `task.phase=skipped, trigger=watch`。
说明 fs.watch + 防抖 + 指纹去重链路工作正常，不会因自身写入产生循环。

## 10. 未覆盖/需人工确认

1. **未授权 / 网络异常三态的真实复现**：逻辑上按 CLI `code<0` + `msg` 关键词分类
   （未授权/授权/认证/token/过期 → unauthorized；超时/无 result → error），本次环境授权正常，
   没有主动制造过期 token。面板未授权分支与 `connection/login` 空 token 400 校验已实现。
2. **GUI 真实视觉**：无浏览器控制能力；已验证 Client 模块被加载且两个 slot 注册 active，
   但主题观感、窄宽度布局、浏览器控制台是否零报错需人工打开面板确认（建议截图留档）。
3. **自动重启**：`POST /restart` 实现「electron.relaunch 优先，否则 kill 父进程 + open -a」，
   因会终止当前会话，未在本次任务中执行破坏性验证；请手动重启验证。
4. **12 MB stage 的 UI 表现**：接口实测耗时约 10–30s，前端为 loading + 已用时提示，未做视觉核对。

## 附：夸克 `_archive` 探针残留（需手动清理）

探针只上传到 `dsh/_archive`（不影响 5 份快照配额），CLI 无删除能力：

- `probe.txt`、`probe(1).txt`、`probe(2).txt`（约 1.1 KB/个）
- `dsh-probe-…-135137-c37f.manifest.json`、`dsh-probe-…-135410-2642.manifest.json`（测试清单）

请在夸克 App 中打开 `夸克网盘 / dsh / _archive` 手动删除。


---

## 11. 跨平台（Windows 兼容）改造后的回归（2026-11-04 18:00–18:20）

### 11.1 离线测试

| 命令 | 结果 |
|---|---|
| `node test/native-unit.mjs` | **PASS 11/11 组**：config（config.json 优先 / config.sh 行式解析 / 默认值 / `link:` 自动发现）、scope（排除/prune/不可读/禁用）、sidecar 兼容、完整 backup 流水线（fake quark）、指纹 skip 与变更重传、密钥扫描阻断、rotation、取消清理、Windows 路径模拟、tar 不支持 gzip 时的 `tar -cf + node:zlib` 退路 |
| `node test/windows-sim.mjs` | **PASS 12/12 项**：`pathInside` 的 win32 盘符/大小写/分隔符、Windows PATH（System32、分号）、`DSH_DESKTOP_NODE_EXECUTABLE` / Electron Node-mode 解析、`DSH_MAINTENANCE_TAR` 覆盖、`mirror` 排除语义与受保护子树保留 |
| `node test/restore-unit.mjs` | **PASS 28/28 项**（原 24 项改为 mirror/`resolveTarCommand` 后全部保留；新增 4 项：win32 路径、platform 注入、mirror add/overwrite/delete/exclude、tamper tar 覆盖） |
| `node test/host-smoke.mjs` | **PASS**：连接正常；native scope 12 条目 / 4,492 文件 / 41.2 MB；自动发现 `workspace/dsh-maintenance-backup` |

### 11.2 真实云端备份（native 引擎，macOS 实机）

`node test/backup-driver.mjs`（真实上传）：

```
phase=success, durationMs=18526
snapshotName=dsh-snap-2026-11-04_181344.tar.gz
sizeMB=11.8, fileCount=4492, totalBytes=41246921, archived=2
sidecarName=dsh-snap-2026-11-04_181344.manifest.json
warnings=[8 个测试文件含假密钥样本，未阻断]
log: 使用 /usr/bin/tar 打包压缩… → 上传成功(FID) → sidecar 已上传 → dsh/ 现有快照 6 份 → 已归档 2 个对象
```

随后通过插件 HTTP API 触发的 native 备份同样成功（`dsh-snap-2026-11-04_181430`、`_181456`），
阶段/日志/结果与 driver 一致；`GET /snapshots` 显示 **5 份 tar + 5 份 sidecar**，
`GET /snapshots/preview` 读取新 sidecar：`file_count=4492`、`total_bytes≈41 MB`、
12 个 entries（与备份范围一致）、`files` 列表不含 `MANIFEST.json`。

立即再跑（无变更）：

```
phase=skipped, 耗时 36 ms
result={skipped:true,fileCount:4492}
log: 指纹 6554fa275627508b… 文件数 4492，39.3 MB / 无变更，跳过同步
```

说明 native 指纹去重生效，自激循环不会出现。

### 11.3 插件在线状态（native 引擎）

```
GET /health:
  engine = "native"
  platform = { label: "macOS", workspace: ".../Documents/workspace",
               tar: "/usr/bin/tar", node: { source: "path", command: ".../bin/node" } }
GET /overview: warnings=[]，schedule={enabled:true, intervalMinutes:15, watch:true, persistedTo:"profile-patch"}
GET /scope: source="config.sh"，12 entries，totals={files:4492, bytes:41246921}
```

### 11.4 真实还原接口（在线插件，非破坏性）

`POST /restore/stage`（最新快照，scope=workspace）→ 3.5s 完成：

```
stagingId=stg-mw1yo22m-27v0jc
diff counts={added:0, overwritten:0, deleted:0, unchanged:3177}
targets: workspace/dsh-agent-usage 51、dsh-page-preview 1319、plugins 1807（全部 unchanged）
```

随后 `POST /restore/discard` 返回 `{ok:true}`，staging 目录清空。未对真实目标做 apply。

### 11.5 真实云端还原 E2E（native 快照 + mirror 引擎）

`node test/restore-e2e-cloud.mjs`：选择最新 native 快照 → preview（sidecar）→
stage（下载 12 MB、解压、diff）→ apply（mirror 落地 3175 文件 / 36.5 MB，安全副本）→
finalize（模拟重启）→ rollback，**PASS**，沙箱自动清理；全程未触碰真实 `~/.dsh`。

### 11.6 Windows 未覆盖项（需在真实 Windows 上验证）

1. `C:\Windows\System32\tar.exe` 的 `-czf / -cf / -C / --exclude` 实际行为；
2. Electron Node-mode（`ELECTRON_RUN_AS_NODE=1`）执行夸克 CLI 的 `download/upload/browse/move`；
3. 盘符（`C:\` / `D:\`）与 OneDrive 重定向 Documents 下的实际读写；
4. Windows junction / 符号链接（`mirror.js` 创建 links 的降级路径）；
5. `taskkill /PID <ppid> /T` + `start "" "<exe>"` 自动重启；
6. 文件被占用/只读时的 mirror 错误分支（已有代码路径，未构造真实用例）；
7. Windows 超长路径（>260 字符）是否触发 `tar.exe` 失败。

以上均已在 `README` 的「Windows 兼容 / 已知限制」与 `docs/WINDOWS-PORT.md` 中标注。
