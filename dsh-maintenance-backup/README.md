# 网盘备份维护（DSH 插件，macOS + Windows）

把原先由 launchd 定时脚本承担的「DSH 配置与插件 → 夸克网盘」备份，改造成一个运行在
DSH 主进程内的跨平台插件：左侧栏独立入口，面板里查看网盘连接、备份范围、立即备份、
定时/变更策略、云端快照，以及分两阶段做的可回滚还原。

**为什么是插件**：插件跑在 DSH 的 Host 进程里，继承 DSH App 的文件权限，因此能直接读取
工作区中的插件工程，**不需要给 `/bin/bash` 授予「完全磁盘访问权限」**（launchd 派生的
进程会被 macOS TCC 拒绝读取 `~/Documents`，这正是旧方案被取代的原因）。

**跨平台**：核心链路已改为纯 Node 实现，macOS / Windows 共用同一套代码，不依赖 bash、
rsync、GNU coreutils 或 macOS 专有命令。Windows 只需系统自带的 `tar.exe`（Windows 10
1803+）与 DSH 自带的 Node 运行时；详见 [Windows 兼容](#windows-兼容)。

---

## 功能

| 区域 | 能力 |
|---|---|
| 左侧栏入口 | 全局面板图标「网盘备份」（id `dsh-maintenance`，order 40），main 区独立页面 |
| 连接状态 | `get-user-info`：昵称、会员类型、容量/已用、到期；三态「已连接 / 未授权 / 网络异常」；未授权时内联授权码登录，失败给终端兜底命令 |
| 备份范围 | 与备份引擎同源的 Node 统计：本地路径 → 包内路径、文件数、大小、可读性、自动发现 `link:` 插件；可逐项启用/禁用 |
| 立即备份 | 纯 Node 流水线：指纹检测 → 打包 → 敏感信息扫描 → 上传 tar + sidecar → 滚动归档；面板实时显示阶段/日志，可取消 |
| 定时策略 | 开关、15 分钟 / 1 小时 / 6 小时 / 24 小时、保留份数 1–10、文件监听 + 防抖；策略写进 profile 的 `cordis.patch.yml`（因此策略本身也随备份走） |
| 变更即备份 | `fs.watch` 监听 `~/Documents/workspace` 与 `~/.dsh/profiles`，防抖（默认 60s）后同步；Windows 使用 ReadDirectoryChangesW |
| 快照 | 云端 `dsh/` 列表：日期、大小、sidecar 清单标记；预览只下载几十~几百 KB 的 `*.manifest.json`，确认还原才下载 12 MB tar |
| 两阶段还原 | 阶段一：下载 → 校验 → 解压 staging → 差异清单（新增/覆盖/删除 + 样例）→ 二次确认；阶段二：本地安全副本 → 目录镜像落地 → 写 `restore-pending.json` → 提示重启 DSH |
| 重启后收尾 | 插件启动时检测 marker：校验落地、清理 staging、在面板展示「上次还原结果」、删除 marker；中断时提示可回滚 |
| 安全 | 绝不备份 `~/.dsh/.credentials.yaml`；上传前密钥/私钥扫描；所有 HTTP 接口仅 loopback；不要求 Full Disk Access |

---

## 目录结构

```
~/Documents/workspace/dsh-maintenance-backup/
├── package.json            # DSH bundle + client 声明（host + client）
├── cordis.patch.yml        # 插入 Host 行 + 默认策略
├── index.js                # Host 入口：挂路由、定时器、启动收尾
├── client.js               # Client 半：左侧栏入口 + 维护面板（纯 React.createElement）
├── icon.svg / locale/*.json
├── host/
│   ├── core.js             # 运行态目录、原子 JSON、日志、全局锁、子进程、遍历/哈希
│   ├── platform.js         # 跨平台：路径/Node/tar/PATH/路径包含判断（Windows 盘符）
│   ├── mirror.js           # 跨平台目录镜像（替代 rsync -a --delete）
│   ├── quark.js            # 夸克 CLI 封装（NDJSON 解析、字段/错误分类、Node 运行时解析）
│   ├── scope.js            # 范围报告（native scope）
│   ├── backup.js            # 备份任务编排（锁/阶段/日志/取消）
│   ├── schedule.js         # 定时器 + fs.watch + 写 profile cordis.patch.yml
│   ├── restore.js          # 两阶段还原引擎（stage/apply/rollback/finalize；tar + mirror）
│   ├── sync-tools.js       # 仅 POSIX：~/.dsh-sync 旧工具脚本自愈（兼容旧快照）
│   ├── routes.js           # /api/dsh-maintenance/* 本地 HTTP API
│   └── native/             # 跨平台备份引擎（纯 Node）
│       ├── config.js       #   config.json / config.sh / 内置默认 + link: 自动发现
│       ├── scope.js        #   范围统计（文件数/大小/可读性/排除项）
│       ├── backup.js       #   指纹 → 打包 → 扫描 → 上传 → 滚动归档
│       ├── sidecar.js      #   MANIFEST.json / RESTORE.md / 小清单
│       ├── secret-scan.js  #   密钥/私钥扫描
│       └── rotation.js     #   保留份数与归档 FID 计算
├── assets/dsh-sync/        # 旧 bash/Node 工具脚本副本（仅手动排查/旧快照兼容用）
├── docs/
│   ├── CONTRACT.md         # 内部 API 与模块契约
│   ├── WINDOWS-PORT.md     # Windows 兼容改造设计
│   ├── QUARK-CLI-NOTES.md  # 夸克 CLI 实测笔记（字段、坑）
│   └── TEST-REPORT.md      # 端到端测试记录
└── test/
    ├── host-smoke.mjs          # 只读冒烟（连接/范围/策略）
    ├── native-unit.mjs         # native 引擎离线单测（11 组）
    ├── backup-driver.mjs       # 直接驱动备份模块（真实上传）
    ├── restore-unit.mjs        # 还原引擎离线沙箱单测（28 项，含跨平台用例）
    ├── restore-e2e-cloud.mjs   # 真实云端快照 → /tmp 沙箱的两阶段还原 + 回滚
    ├── windows-sim.mjs         # Windows 纯逻辑模拟（路径/环境/镜像）
    └── quark-probe.mjs         # 夸克 CLI 行为探针（只走命令行）
```

运行态目录 **`~/.dsh-maintenance/`**（Windows 为 `%USERPROFILE%\.dsh-maintenance`，可用
`DSH_MAINTENANCE_DIR` 覆盖，不在备份范围内）：

```
state.json              策略副本、最近备份/还原、连接缓存、禁用条目、扫描汇总
state/native-fingerprint.json  原生备份引擎的变更指纹（成功上传后才写）
task.json               当前/最近任务（插件重载后 UI 可恢复）
lock.json               全局任务锁（备份/还原互斥，跨进程）
logs/maintenance.log    插件日志（2 MB 轮转）
native/stage-*          备份打包临时目录（成功/失败后清理）
restore/pending.json    两阶段还原 marker（重启后收尾）
restore/staging-*/      阶段一解压暂存
restore/safety/         还原前本地安全副本（只保留最近 1 套）
disabled-entries.json   UI 禁用条目（旧脚本用户也可复用）
```

---

## 安装

插件通过 DSH 的插件管理器作为 profile bundle 安装（`~/.dsh/profiles/desktop/package.json`
里是 `link:<本目录绝对路径>`，bundle 列表包含 `@local/dsh-maintenance-backup`）。**不要手改
profile 的 package.json / cordis.patch.yml**，安装动作交给插件管理器：

- 在 DSH Web GUI 的「插件」页里选择本地目录安装；或
- 让 DSH 内的 agent 调用 `plugin_manager install_bundle`，target 传本目录绝对路径。

安装后：

1. 左侧栏出现「网盘备份」入口；点击打开维护面板。
2. Host 原生代码更新后，可用 `plugin_manager set_plugin` 对 `include:dsh-maintenance-backup`
   执行 disable → enable 热重载（Client 代码改动刷新页面即可）。
3. 首次打开面板会检查夸克连接；未授权时按面板提示输入授权码（`login --token <授权码>`）。
4. 定时策略默认写在本包 `cordis.patch.yml`；在面板里保存策略后，覆盖值会写进
   `~/.dsh/profiles/desktop/cordis.patch.yml`（profile 层），所以**策略本身也会进快照、并随还原生效**。

### 备份配置来源（跨平台）

备份引擎按以下优先级读取配置，面板与备份使用**同一份**结果：

1. `~/.dsh-sync/config.json`（便携配置，Windows 推荐）；
2. 否则解析 `~/.dsh-sync/config.sh`（macOS 沿用原有自定义；不执行 bash，而是安全的行式解析）；
3. 否则内置默认条目（与现有 `config.sh` 相同的 `dsh-home/*`、`workspace/*`、`dsh-sync`）。

无论来源如何，都会合并 `~/.dsh/profiles/*/package.json` 里 `link:`/`file:` 的本地插件
（dest = `workspace/<basename>`，父目录已覆盖则去重）——新装本地插件无需改配置。

`config.json` 示例：

```json
{
  "dshFid": "210e76226f274d749cfc712725c72c68",
  "archiveFid": "e3462aa31eb849dca82a96d8153dc41e",
  "keep": 5,
  "entries": [
    { "src": "/Users/me/.dsh/profiles", "dest": "dsh-home/profiles" },
    { "src": "/Users/me/Documents/workspace/dsh/plugins", "dest": "workspace/plugins" }
  ],
  "pruneAbs": ["/Users/me/.dsh/skills/quarkclouddrive/deepseek"],
  "excludes": ["node_modules", ".git", ".DS_Store", ".turbo", "*.log", "*.tmp"]
}
```

Windows 上首次运行即使用内置默认值（`src` 为 `%USERPROFILE%\.dsh\...` 与
`%USERPROFILE%\Documents\workspace`，Documents 被 OneDrive 重定向时自动探测）。

> 从 macOS 迁移时**不要直接复用 `config.sh`**（里面是 `/Users/...` 绝对路径）；要么删除它让
> 插件回退到 Windows 默认条目，要么改写为 `config.json`。

---

## Windows 兼容

- **前置条件**：Windows 10 1803+ / Windows 11；DSH Desktop；系统自带 `tar.exe`
  （`C:\Windows\System32\tar.exe`）。不需要 Git Bash、WSL、rsync 或 Python。
- **Node**：插件优先使用 `DSH_DESKTOP_NODE_EXECUTABLE`（DSH 自带），其次 PATH 上的 node，
  最后用 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1` 运行夸克 CLI。
- **路径**：`%USERPROFILE%\.dsh`、`%USERPROFILE%\.dsh-sync`、`%USERPROFILE%\.dsh-maintenance`；
  工作区默认 `%USERPROFILE%\Documents\workspace`，OneDrive 重定向时自动改用
  `%OneDrive%\Documents\workspace`，也可用 `DSH_WORKSPACE_DIR` 覆盖。
- **备份**：纯 Node 复制 + `tar.exe` 打包；不再执行 `sync.sh`/`scope.sh`（它们保留给
  macOS 手动排查/旧脚本用户）。`~/.dsh-sync` 里的 bash 工具在 Windows 上不会被使用或复制。
- **还原**：用 Node 目录镜像替代 `rsync -a --delete`；`tar.exe` 负责解压/安全副本；
  运行态保护、两阶段 marker、`applyPid` 同进程保护与 macOS 完全一致。
- **重启**：Windows 分支用 `ping` 延时 + `taskkill /PID <父进程> /T` 结束应用，再用
  `start "" "<exe>"` 重新启动；也可按面板提示手动重启。
- **已验证/未验证**：全部跨平台逻辑在 macOS 上用 `test/windows-sim.mjs` 与
  `test/restore-unit.mjs` 的 win32 路径用例验证；**真实 Windows 上的 `tar.exe` 行为、
  Electron Node-mode 执行夸克 CLI、盘符/OneDrive 实际读写、junction、taskkill 重启尚未
  在 Windows 机器上运行**（见测试报告）。如遇到问题请把
  `~/.dsh-maintenance/logs/maintenance.log` 与 `/api/dsh-maintenance/health` 输出附上。

---

## 工作方式（关键设计）

### 备份链路（纯 Node，跨平台）

1. **指纹**：对每个条目的文件取「包内路径 + 大小 + mtime」，sha256 后与
   `state/native-fingerprint.json` 比对；一致且非 `--force` 直接跳过（不触碰网盘）。
2. **打包**：把每个条目复制到 `~/.dsh-maintenance/native/stage-*/`，排除
   `node_modules`、`.git`、`.DS_Store`、`.turbo`、`*.log`、`*.tmp` 与运行时目录
   （夸克 Skill 的 `deepseek/`、`browse/`，`dsh-sync/state|logs` 等）；
   写 `MANIFEST.json`、`RESTORE.md`；不可读目录直接失败，不上传残缺快照。
3. **安全扫描**：非测试文件中出现真实密钥/私钥格式即中止上传；测试夹具里的假密钥只告警。
4. **压缩**：`tar -czf`（Windows 用 `System32\tar.exe`）；若系统 tar 不支持 gzip，
   自动退回 `tar -cf` + `node:zlib` 压缩。
5. **上传**：tar 成功后上传 sidecar 小清单（`dsh-snap-<ts>.manifest.json`，sha256/文件清单）；
   sidecar 失败不影响主备份。
6. **滚动保留**：`dsh/` 按 tar 计数保留 5 份；超出的 tar 连同对应/更旧的 sidecar 一起
   `move` 到 `dsh/_archive`（夸克 CLI 无删除能力，归档目录需在夸克 App 内手动清空）。
7. **提交指纹**：仅在上传成功后写入；失败下次自动重试。

旧的 `~/.dsh-sync/sync.sh`、`scope.sh` 不再由插件调用，仅保留给 macOS 手动排查/旧脚本
用户；`assets/dsh-sync/` 是它们的随包副本，供 POSIX 上旧快照还原后自愈。

### 自引用处理（关键）

**备份时**：插件代码在范围内（否则换机没有维护面板）；运行态（日志、任务、暂存、指纹、
连接缓存）统一放在 `~/.dsh-maintenance/`，不在任何同步条目内。备份过程只读源、只写运行态
临时目录，不会在 `~/Documents/workspace` 或 `~/.dsh/profiles` 里写任何东西，因此不会造成指纹抖动。

**还原时**：禁止热替换。

- 阶段一只写 `~/.dsh-maintenance/restore/staging-<id>/`，绝不改目标。
- 阶段二先写 `restore-pending.json`（`phase=applying`），然后对每个目标目录做本地安全副本
  （`restore/safety/<id>/`，只保留最近一套），再用跨平台目录镜像落地（复制 + 删除多余文件，
  保留受保护子树），最后把 marker 改为 `phase=applied` 并提示重启。
- **维护插件自身默认不参与还原**（`workspace/dsh-maintenance-backup`）：避免运行中的代码/UI
  被旧版覆盖。勾选「连同维护插件一起还原」会显示红色警告，重启后生效且可能降级。
- 还原范围只覆盖快照里实际存在的目标，并保护：`sessions`、`attachments`、`storages`、`cache`、
  `page-preview`、`dsh-runtimes`、`.credentials.yaml`、`node_modules`、`.git`、`.playwright-cli`、
  夸克 Skill 的运行时目录、`dsh-sync/state`、`dsh-sync/logs`。
- marker 记录 `applyPid`：同一 Host 进程内（插件热重载）不会提前消费 marker；真正重启后
  `finalizeOnStartup()` 才校验落地、清理 staging、展示结果并删除 marker。中断可回滚到安全副本。

### 重启接口调研结论

DSH Desktop 的 Host 是 Electron 主进程派生的 Node-mode 子进程（`dsh-desktop-host`），
**没有暴露 `app.relaunch()`/宿主重载 API**（Host 只接收主进程的 `shutdown`/`quit-inspection` 消息）。
插件因此提供两种方式：

1. 面板「重启 DSH」按钮（二次确认）：优先尝试 `electron.app.relaunch()`；不可用时
   macOS 用 `kill -TERM <父进程> + open -a`，Windows 用 `taskkill /PID <父进程> /T + start "" <exe>`
   自动退出并重开。
2. 兜底文案：手动退出（macOS `⌘Q`；Windows 关闭窗口/任务管理器）后重新打开 DSH。

该自动重启未在本次任务中做破坏性验证，推荐手动重启。

---

## 卸载

1. 在插件管理器里移除 bundle（或调用 `plugin_manager remove_bundle`，target 为
   `@local/dsh-maintenance-backup`），这会同时撤销 profile 的 bundle 选择与依赖。
2. 删除插件源码目录（可选）：`rm -rf ~/Documents/workspace/dsh-maintenance-backup`
   （Windows：`Remove-Item -Recurse -Force "$env:USERPROFILE\Documents\workspace\dsh-maintenance-backup"`）。
3. 删除运行态（可选，会丢失最近备份/还原记录与指纹）：
   `rm -rf ~/.dsh-maintenance`（Windows：`Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh-maintenance"`）。
4. 若希望恢复旧 launchd 任务（仅 macOS、不推荐）：
   `~/Library/LaunchAgents/com.aesc.dsh-sync.plist.disabled-20261104` 改回 `.plist` 后
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aesc.dsh-sync.plist`。
5. `~/.dsh-sync/` 的脚本与 `config.sh` 可以保留，macOS 上手动
   `bash ~/.dsh-sync/sync.sh --force` 仍可用。

### 已完成的 launchd 卸载（macOS）

原任务 `com.aesc.dsh-sync` 已卸载，plist 已改名为
`~/Library/LaunchAgents/com.aesc.dsh-sync.plist.disabled-20261104`。验证：

```bash
launchctl print gui/$(id -u)/com.aesc.dsh-sync   # => Could not find service
```

---

## 配置项

Profile 层（`~/.dsh/profiles/desktop/cordis.patch.yml`，面板保存时自动写入）：

```yaml
- id: dsh-maintenance-backup
  name: '@local/dsh-maintenance-backup'
  config:
    schedule:
      enabled: true
      intervalMinutes: 15      # 15 / 60 / 360 / 1440
      keep: 5                  # 1–10
      watch: true              # fs.watch 变更即备份
      debounceSeconds: 60      # 15–3600
    autoRestart: false
```

运行态覆盖：`~/.dsh-maintenance/state.json`（策略即时副本、禁用条目、连接缓存）。
还原后以 profile 配置为准。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 面板「未授权」 | 夸克 token 过期。点「重新授权」输入授权码；或在终端跑 `node ~/.dsh/skills/quarkclouddrive/scripts/quark-drive.cjs login --token <授权码>` |
| 面板「网络异常」 | 检查网络后点「重试」；查看 `~/.dsh-maintenance/logs/maintenance.log` |
| 备份报 `tar` 相关错误 | Windows 需系统自带 `tar.exe`（Win10 1803+）；macOS 用 `/usr/bin/tar`。可用 `DSH_MAINTENANCE_TAR` 指定路径 |
| 备份报「不可读」 | 备份范围里有不可读目录；本插件运行在 DSH 进程内，正常应全部可读（Windows 上检查文件 ACL/占用） |
| 备份一直「已有任务在运行」 | 等当前任务结束；陈旧锁在 6 小时后自动失效，或检查 `~/.dsh-maintenance/lock.json` 里 pid 是否仍存活 |
| 还原后没生效 | 必须重启 DSH；面板会显示「需重启」与手动步骤 |
| 还原中断 | 重启后面板显示「上次还原在应用阶段被中断」，可点「回滚」使用本地安全副本 |
| 云端旧快照没有 sidecar | 预览会提示「旧快照无清单」，仍可 stage（下载完整 tar 后计算差异） |
| `_archive` 越来越大 | 夸克 CLI 不支持删除。在夸克 App 里手动清空 `dsh/_archive` |
| 策略保存后显示「本地」 | `configEditor` 不可用（profile 层写不进去）；策略仍保存在 `~/.dsh-maintenance`，可手动写入 profile patch |
| Windows 上找不到 node | 插件会依次用 `DSH_DESKTOP_NODE_EXECUTABLE`、PATH、Electron Node-mode；可在面板 `/health` 查看实际解析结果 |

---

## 测试

```bash
cd ~/Documents/workspace/dsh-maintenance-backup
node test/host-smoke.mjs            # 只读：连接 + 范围（原生）+ 策略
node test/native-unit.mjs           # native 引擎离线单测（11 组，fake quark）
node test/windows-sim.mjs           # Windows 纯逻辑：pathInside/PATH/tar/node/mirror（12 项）
node test/restore-unit.mjs          # 还原引擎离线单测（28 项，含 win32 路径与 mirror）
node test/backup-driver.mjs         # 真实备份一次（会上传，滚动保留 5 份）
node test/restore-e2e-cloud.mjs     # 云端快照 → /tmp 沙箱两阶段还原 + 回滚（不碰真实 ~/.dsh）
node test/quark-probe.mjs --skip-network   # 夸克 CLI 行为结论回放
```

完整记录见 [docs/TEST-REPORT.md](docs/TEST-REPORT.md)；Windows 改造设计见
[docs/WINDOWS-PORT.md](docs/WINDOWS-PORT.md)。

---

## 已知限制

- **真实 Windows 未运行**：跨平台逻辑已在 macOS 上用 win32 路径用例验证，但
  `System32\tar.exe` 的实际 `-czf/-cf/-C` 行为、Electron Node-mode 执行夸克 CLI、
  盘符/OneDrive 实际读写、Windows junction、taskkill 重启仍需在 Windows 机器上实测。
- **重启**：DSH 未暴露重启 API，自动重启是「结束父进程 + 重新拉起」的兜底实现，未做破坏性验证；
  推荐手动重启。
- **超长路径**：Windows 默认 260 字符路径限制可能影响深层 node_modules 之外的工程；
  快照本身排除 node_modules，但如有超深目录请在系统启用长路径支持。
- **sidecar 大小**：当前约 390 KB（约 4.5k 文件），比「几十 KB」大，但仍是 12 MB tar 的 3% 左右。
- **FID 不稳定**：夸克 `browse` 返回的 FID 每次前缀会变；插件只在 30 秒缓存内复用，下载/移动前会重新列目录。
- **还原映射**：`workspace/plugins → ~/Documents/workspace/dsh/plugins` 等映射来自当前
  `scope` 配置；老快照按 basename 唯一匹配兜底，找不到会告警并落到默认路径，需人工核对。
- **绝对路径**：配置里的 `link:/Users/<用户名>/...`（Windows 为 `link:C:\Users\...`）换机后失效，
  还原后需改 profile `package.json`。
- **node_modules 不入快照**：还原插件工程后需在相应目录 `pnpm install`。
- **12 MB 下载**：stage 阶段同步等待（几十秒），UI 只有 loading + 已用时提示，没有服务端阶段进度。
- **GUI 视觉验证**：本次实现通过 Client 模块注册（`sidebar.panellist` / `main` 均 active）与
  API 联调验证；无浏览器控制能力，真实主题观感/窄宽度/浏览器控制台无报错需人工确认。
