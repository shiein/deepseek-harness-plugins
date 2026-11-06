# 一次性探针归档（R4-5，review-2026-11-01 P2-7）

规则（docs/r4-plan.md R4-5）：

- 已被 `tests/` 覆盖同一行为的脚本：删除，并写明覆盖它的测试文件。
- 仍有复现价值、但没有测试覆盖的脚本（需要真实 DSH 或真实浏览器人工观察的探针）：移到本目录，
  写明用途、运行前提和对应的文档。
- 构建和测试链路依赖的脚本（`scripts/build-client.mjs`、`copy-browser.mjs`、`check-line-length.mjs`、
  `install-toolchains.mjs`、`generate-config-schema.mjs`、`pack-check.mjs`、`build-phase0-bridge.mjs`）
  以及 `dev/bridge`、`dev/cordis.*.yml` 不动。

## 本目录脚本（归档：需要真实 DSH 或人工浏览器观察，自动化测试不覆盖）

| 脚本 | 用途 | 运行前提 | 对应文档 |
| --- | --- | --- | --- |
| `phase0-host-plugin.mjs` | 在真实 DSH Host 内加载探针插件，观察 overlay/工具注册 | 真实 DSH 桌面 + 隔离 web profile | docs/evidence/2026-11-03-phase0-verification.md |
| `phase0-server.ts` | 自建 loopback 响应层，供真实 DSH Browser 打开观察 | 真实 DSH 桌面 | docs/evidence/2026-11-03-phase0-verification.md |
| `phase0-process.ts` | Host 被 SIGKILL 后按 PID+启动时间回收进程组 | 真实进程/账本 | docs/evidence/2026-11-03-phase0-verification.md |
| `phase0-storage.mjs` + `phase0-storage-server.mjs` | 同工作区/跨工作区 Cookie/localStorage 边界样本 | 真实 DSH Browser | docs/evidence/2026-11-03-phase0-storage.md |
| `phase0-hmr.mjs` + `phase0-hmr-boundary.ts` + `phase0-hmr-step.mjs` | 固定版本 Vite 样本的 HMR 更新/错误/恢复人工步骤 | 真实 DSH Browser + 已装 Vite 5.2.12 | docs/evidence/2026-11-03-phase0-hmr.md |
| `verify-phase0-bridge.mjs` | 校验 dev/bridge 探针的载体操作与 document-loaded 记录 | 先跑 `npm run build:phase0-bridge` + 真实 DSH | docs/evidence/2026-11-03-phase0-verification.md、docs/evidence/2026-11-03-phase0-desktop-and-overview.md |
| `verify-phase0-hmr-cleanup.mjs` | 真实 Vite 子进程 SIGTERM 清理回归（无需 DSH） | 已装 Vite 5.2.12 | docs/evidence/2026-11-03-phase0-hmr.md |
| `verify-phase0-storage.mjs` | 校验 storage-observations.json 完整序列 | 先跑 phase0-storage.mjs | docs/evidence/2026-11-03-phase0-storage.md |
| `prepare-phase0-desktop.mjs` | 生成隔离 profile 快照（origin/output/Browser 启用层） | 不安装、不写用户 profile | docs/evidence/2026-11-03-phase0-desktop-and-overview.md |
| `prepare-phase0-non-vite.mjs` | 复制非 Vite 演示样本到独立目录 | 目标目录不存在 | docs/evidence/2026-11-03-phase0-non-vite-demo.md |
| `probe-static-network.mjs` | 真实浏览器中 static 受控响应层的 CSP/网络边界（JSONP、跨源 Worker/img/iframe） | `npm run build` + 独立浏览器 | docs/evidence/2026-11-03-network-boundary.md |
| `static-assertions-probe.mjs` | 完整 apply→静态目标断言的真实浏览器人工探针 | `npm run build` + 独立浏览器 | docs/evidence/2026-11-03-static-target-assertions.md |

## 已删除（行为已被自动化测试覆盖）

| 原路径 | 覆盖它的测试 |
| --- | --- |
| `scripts/verify-runner-ipc.mjs` | `tests/unit/runner-connection.test.ts`（握手、重复握手、意外退出、PID 校验）、`tests/unit/runner-protocol.test.ts` |
| `scripts/verify-runner-session.mjs` | `tests/unit/runner-session.test.ts`、`runner-workspace.test.ts`、`ledger.test.ts`、`port-ownership.test.ts`、`state-machine.test.ts` |
| `scripts/verify-managed-process.mjs` | `tests/unit/runner-session.test.ts` 真实托管服务用例、`process-tree.test.ts`、`port-ownership.test.ts` |
| `scripts/verify-host-runner.mjs` | `tests/unit/session-registry.test.ts` public open/status/stop 用例、`static-runtime.test.ts`、`runner-client.test.ts` |
| `scripts/verify-existing-server.mjs` | `tests/unit/session-registry.test.ts` attach 用例、`existing-server-preflight.test.ts` |
| `scripts/verify-project-command.mjs` | `tests/unit/project-command.test.mjs`、`execution-approval.test.mjs`、`session-registry.test.ts` |
| `scripts/verify-config-preflight.mjs` | `tests/unit/config-loader.test.ts`、`config-fingerprint.test.ts`、`planner.test.ts` |
| `scripts/verify-vue-public.mjs` | `tests/unit/vue-vite-public.test.mjs`、`vue-cli-public.test.mjs`、`setup-write-approval.test.ts` |
| `scripts/verify-vue-vite.mjs` | `tests/unit/vue-vite-runtime.test.ts`、`vue-vite-public.test.mjs` |
| `dev/vue-browser-probe.mjs` + `scripts/vue-browser-step.mjs` | `tests/unit/vue-browser-lifecycle.test.mjs`、`vue-vite-public.test.mjs` 真实 headless Chrome 用例 |
| `dev/vue-vite-adapter-probe.mjs` + `scripts/vue-vite-adapter-step.mjs` | `tests/unit/vue-vite-runtime.test.ts`、`vue-vite-public.test.mjs` 真实 headless Chrome 用例 |

说明：删除的 `verify-*.mjs` 曾验证 `lib/` 编译产物；`tests/` 直接跑 `src/` 源码，覆盖相同行为。
编译产物的打包完整性由 `scripts/pack-check.mjs` 负责；上述真实浏览器人工探针仍需本目录脚本复现。
