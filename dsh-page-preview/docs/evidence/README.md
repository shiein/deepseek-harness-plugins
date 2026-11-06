# 运行证据归档（R4-6）

> 专题验证文档原样迁自 `docs/`，按 `<归档日期>-<主题>.md` 命名；运行期 PID/端口已替换为
> `<pid>`/`<port>` 占位符，它们不构成可复现结论。原路径保留一行指针文件。
> 现行行为结论以 `docs/guide.md`、`docs/config-reference.md`、`docs/architecture.md`、
> `docs/limitations.md` 为准；兼容矩阵以 `tests/fixtures/README.md` 为准。
> T 阶段的实机验收证据也放这里（`docs/dsh-e2e-acceptance.md`）。

| 文件 | 主题 | 原路径 |
| --- | --- | --- |
| 2026-10-31-parser-dependencies.md | 只读解析依赖确认清单 | docs/parser-dependencies.md |
| 2026-10-31-phase0-host-client-dependencies.md | Phase 0 Host/Client 依赖核对 | docs/phase0-host-client-dependencies.md |
| 2026-10-31-target-resolution.md | 目标选择器解析 | docs/target-resolution.md |
| 2026-11-01-browser-source-packaging.md | 浏览器源码跟踪修正 | docs/browser-source-packaging.md |
| 2026-11-01-http-fixture-matching.md | HTTP fixture 匹配语义 | docs/http-fixture-matching.md |
| 2026-11-01-http-mock-middleware.md | 同源 HTTP Mock 中间件 | docs/http-mock-middleware.md |
| 2026-11-01-planner.md | 通用执行计划预检 | docs/planner.md |
| 2026-11-01-project-handler-loader.md | 项目 handler 授权加载 | docs/project-handler-loader.md |
| 2026-11-01-vue-browser-network.md | Vue 浏览器网络边界 | docs/vue-browser-network.md |
| 2026-11-01-vue-detection.md | Vue 只读检测 | docs/vue-detection.md |
| 2026-11-01-vue-element-pinia.md | Element Plus/Pinia 场景验收 | docs/vue-element-pinia.md |
| 2026-11-01-vue-entry-replay.md | Vue 入口注册重放 | docs/vue-entry-replay.md |
| 2026-11-01-vue-named-sfc-antdv.md | 命名 SFC 与 ant-design-vue 验收 | docs/vue-named-sfc-antdv.md |
| 2026-11-01-vue-navigation.md | Vue 导航验收 | docs/vue-navigation.md |
| 2026-11-01-vue-preflight.md | Vue 预检 | docs/vue-preflight.md |
| 2026-11-01-vue-websocket-boundary.md | HMR WebSocket 边界 | docs/vue-websocket-boundary.md |
| 2026-11-01-vue-worker-foundation.md | Vue worker 基础设施 | docs/vue-worker-foundation.md |
| 2026-11-01-vue3-toolchain-proposal.md | Vue 3 自包含工具链提案 | docs/vue3-toolchain-proposal.md |
| 2026-11-02-execution-approval-dependency.md | 批准接缝依赖确认 | docs/execution-approval-dependency.md |
| 2026-11-02-execution-approval.md | 执行指纹与用户批准 | docs/execution-approval.md |
| 2026-11-02-static-initial-scenarios.md | 静态初始场景验收 | docs/static-initial-scenarios.md |
| 2026-11-02-vue-initial-scenarios.md | Vue 初始场景验收 | docs/vue-initial-scenarios.md |
| 2026-11-02-vue-node-handlers.md | Vue Node handlers 验收 | docs/vue-node-handlers.md |
| 2026-11-02-vue-test-toolchain-dependencies.md | 测试工具链依赖确认 | docs/vue-test-toolchain-dependencies.md |
| 2026-11-03-configuration.md | 配置协议历史记录（已被 config-reference.md 取代） | docs/configuration.md |
| 2026-11-03-existing-server.md | attach 已有服务验收 | docs/existing-server.md |
| 2026-11-03-network-boundary.md | static 浏览器网络边界（真实浏览器 CSP） | docs/network-boundary.md |
| 2026-11-03-open-tool.md | 公共 open 工具验收 | docs/open-tool.md |
| 2026-11-03-phase0-desktop-and-overview.md | Phase 0 桌面载体与 overview 只读识别 | docs/phase0-desktop-and-overview.md |
| 2026-11-03-phase0-hmr.md | Phase 0 真实浏览器 HMR | docs/phase0-hmr.md |
| 2026-11-03-phase0-non-vite-demo.md | Phase 0 非 Vite 演示样本 | docs/phase0-non-vite-demo.md |
| 2026-11-03-phase0-storage.md | Phase 0 浏览器存储边界 | docs/phase0-storage.md |
| 2026-11-03-phase0-verification.md | Phase 0 验证总记录 | docs/phase0-verification.md |
| 2026-11-03-project-command.md | project-command 验收 | docs/project-command.md |
| 2026-11-03-project-detection.md | 只读应用识别 | docs/project-detection.md |
| 2026-11-03-runner-ipc.md | Host/Runner 执行链路 | docs/runner-ipc.md |
| 2026-11-03-runner-managed-process.md | Runner 托管进程验收 | docs/runner-managed-process.md |
| 2026-11-03-runner-session.md | RunnerSession 生命周期 | docs/runner-session.md |
| 2026-11-03-static-preflight.md | static 预检验收 | docs/static-preflight.md |
| 2026-11-03-static-runtime.md | static 运行时验收 | docs/static-runtime.md |
| 2026-11-03-static-target-assertions.md | 静态目标断言（真实浏览器） | docs/static-target-assertions.md |
| 2026-11-03-status-tools.md | status/stop 工具验收 | docs/status-tools.md |
| 2026-11-03-target-assertions.md | Vue 目标断言验收 | docs/target-assertions.md |
| 2026-11-03-vue-browser-lifecycle.md | Vue 浏览器生命周期 | docs/vue-browser-lifecycle.md |
| 2026-11-03-vue-public-open.md | Vue 公共 open 验收 | docs/vue-public-open.md |
| 2026-11-03-vue-vite-runtime.md | vue-vite 适配器运行时 | docs/vue-vite-runtime.md |
| 2026-11-03-linux-toolchain-scenario.md | Linux Docker 工具链场景链路（HTTP/进程级） | （新建） |
| 2026-11-03-cli-toolchain-scenario.md | Vue 2 CLI 工具链场景链路（无场景段通过，场景准入卡点记录） | （新建） |
