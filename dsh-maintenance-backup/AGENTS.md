# AGENTS.md —— 维护约定

本插件同时有 Host（DSH 主进程，Node ESM）与 Client（Web GUI，`window.__ModuleLoader__`）两半。
改动前先读 `docs/CONTRACT.md`，跑 `node test/*.mjs` 自测。

## 不变量（改代码时必须保持）

1. **备份范围 = `~/.dsh-sync/config.sh` 是唯一事实来源**。不要在插件里另写一份路径列表；
   范围展示走 `scope.sh`/`scope-report.cjs`。
2. **备份走 `host/native/` 纯 Node 引擎**（跨平台，macOS/Windows 同一套）：
   指纹 → 打包 → 密钥扫描 → tar → sidecar → 上传 → 滚动归档。不要重新引入 bash/rsync；
   `sync.sh`/`scope.sh` 仅保留给 macOS 手动排查与旧快照兼容，插件不调用它们。
3. **插件运行态只在 `~/.dsh-maintenance/`**。绝不把日志/缓存/暂存写进
   `~/Documents/workspace` 或 `~/.dsh/profiles`（会造成指纹抖动与自激循环）。
4. **备份/还原全局互斥**：任何长任务先 `core.acquireLock(kind)`；HTTP 路由用
   `core.withLock('restore', …)`；不要把锁嵌套进 restore 引擎。
5. **还原两阶段**：`apply()` 只写 marker + 安全副本 + rsync，不清理 staging、不 finalize；
   `finalizeOnStartup()` 只在 Host 进程重启后（`marker.applyPid !== process.pid`）收尾。
6. **维护插件自身默认不参与还原**（`workspace/dsh-maintenance-backup`；`includeSelf=false`）。
7. **运行态保护清单**（diff/apply/rollback 全链路）：`sessions`、`attachments`、`storages`、
   `cache`、`page-preview`、`dsh-runtimes`、`.credentials.yaml`、`node_modules`、`.git`、
   `.playwright-cli`、`skills/quarkclouddrive/{deepseek,browse}`、`dsh-sync/{state,logs}`。
8. **密钥**：绝不备份 `~/.dsh/.credentials.yaml`；上传前扫描；接口只 loopback。
9. **子进程环境**：调用夸克 CLI 必须显式继承 `DSH_HOME` / `DSH_SESSION_ID`，并带
   `--session-input` / `--session-id`（`host/quark.js` 已封装，别绕过）。
10. **策略持久化**：面板保存先写 `~/.dsh-maintenance/state.json`，再通过 `ctx.configEditor`
    写入 profile 的 `cordis.patch.yml`；失败时降级为本地并如实返回 `persistedTo`。

## 文件所有权

| 文件 | 说明 |
|---|---|
| `index.js` | Host 入口：createCore/quark/scope/backup/schedule/restore/routes、启动收尾、定时器 |
| `host/platform.js` | 跨平台路径/Node/tar/PATH/路径包含（Windows 盘符、大小写） |
| `host/mirror.js` | 跨平台目录镜像（替代 rsync -a --delete，还原 apply/rollback 用） |
| `host/core.js` | 路径、原子 JSON、日志、跨进程锁、子进程、遍历/哈希 |
| `host/quark.js` | CLI 封装；改动前先看 `docs/QUARK-CLI-NOTES.md` 的字段实测。CLI 路径按 `core.paths.cliCandidates` 多候选探测（`QUARK_CLI` env → `~/.dsh/skills` → `~/.agents/skills` → `.codeium/windsurf` → `.claude` → `.devin`），缺文件时 call() 直接报错不起子进程 |
| `host/backup.js` | sync.sh 编排：阶段解析、日志 tail、结果归类 |
| `host/schedule.js` | 定时器 + fs.watch + configEditor |
| `host/restore.js` | 两阶段还原引擎（tar + mirror；stage/apply/rollback/finalize） |
| `host/native/*.js` | 跨平台备份引擎：config / scope / backup / sidecar / secret-scan / rotation |
| `host/scope.js` | 范围报告调用与禁用条目 |
| `host/sync-tools.js` | `~/.dsh-sync` 工具脚本自愈（版本标记 `@dsh-maintenance-tools-version 2`） |
| `host/routes.js` | HTTP API + 还原后自愈注册 + 重启 |
| `client.js` | 左侧栏入口与维护面板；只 `require('react')`，主题只用 `--dsw-alias-*` |
| `assets/dsh-sync/` | 脚本随包副本；改 `~/.dsh-sync/*.sh` 后必须同步到这里（版本标记 +1） |

## 测试

```bash
node test/host-smoke.mjs          # 只读
node test/native-unit.mjs         # native 备份引擎离线单测（11 组）
node test/windows-sim.mjs         # Windows 纯逻辑（path/PATH/tar/node/mirror）
node test/restore-unit.mjs        # 还原引擎离线沙箱（28 项，含 win32 用例）
node test/backup-driver.mjs       # 真实备份一次（会上传）
node test/restore-e2e-cloud.mjs   # 云端 → /tmp 沙箱还原 + 回滚（不碰真实 ~/.dsh）
node test/quark-probe.mjs --skip-network
```

改完 Host 原生代码后，记得用 `plugin_manager set_plugin` 对
`include:dsh-maintenance-backup` 执行 disable → enable 热重载（ESM 模块缓存不会自动失效）。

不要在测试/脚本里写死当前机器的用户名路径；需要 HOME 的地方用 `os.homedir()` 或 env。

## 安装/重载

通过 `plugin_manager install_bundle` 安装本目录。Host 代码改动后，用
`plugin_manager set_plugin` 对本行 disable → enable 可让新模块生效（无需重启整个 DSH）；
Client 代码改动后刷新页面即可。**不要手写 profile 的 package.json / cordis.patch.yml**。
