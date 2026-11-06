# Host 与 Runner 执行链路

对应方案 §6.2、§6.5、§9.2、§15.3。已接通内部 API：`RunnerClient → fork → RunnerController → RunnerWorkspace → RunnerSession → static.start`。原文件由独立 Node Runner 提供 HTTP，Host 不调用 Adapter.start 或执行项目代码。公共 status/stop 已接通，见 [工具验收](2026-11-03-status-tools.md)；public open、Planner、Client 展示仍未接通，产品仍不可用。

## 行为与边界

- RunnerClient 按 realpath 后的规范工作区保存启动任务；并发与符号链接别名复用一个 Runner。启动前对账旧 Runner，活资源或无法核对的记录阻止新建，不自动结束其他 Host 的 Runner。这是单 Client 内调度和持久记录检查，不是多 Host 的原子全局锁。
- Node 使用明确配置的绝对路径，否则从用户 PATH 选择；以独立环境运行 --version 核对 Node ≥22.18 / 23.6 的原生类型擦除支持。Runner 不继承 Host 环境或 NODE_OPTIONS；握手记录实际 Node 路径与版本，不默认使用桌面 Electron 可执行文件。
- 插件配置新增 dataDir 与可选 nodeExecutable。dataDir 必须显式为绝对路径，不猜测 DSH profile，示例见 dev/cordis.dev.example.yml。按规范工作区 SHA-256 分开 `<dataDir>/runners/<hash>/ledger` 的 Runner PID 记录与 `<dataDir>/runtime/<hash>/ledger` 的服务资源。配置/路径、账本及端口查询共用 shared 实现，core/runner 原路径兼容导出。
- Runner 先完成服务账本对账，再发 ready-for-commands；Host 核对 fork PID，且 Runner 登记完成后才发 start。start 带 ownerSessionId、workspaceRoot、可选 configFile 与完整计划。Runner 重新读同一配置来源，以 fingerprintJson(project) 比较 plan.fingerprints.config。确认受理只返回 starting 等实际状态，不生成 ready 证据。
- 当前执行分派只支持 static/in-runner 的原文件文档。command/env/setup/handlers 一律返回 config_changed_needs_approval；批准存储尚未接通，不能执行或自行批准。场景、目标断言、额外 entry/styles、其他适配路径明确不支持。
- status 只查询调用者快照，不启动 Runner、不修复或重新执行。省略 previewId 列出该调用者预览。stop 只接受拥有者；其他会话的活动目标返回 busy，不替换资源。同一拥有者与相同完整计划复用实际 previewId。
- shutdown 等待会话清理，再确认与退出；IPC 断连、SIGTERM/SIGINT、未捕获异常也走清理。Parent 只在核对 PID/启动时间后升级终止其直接 Runner；服务进程树仍由服务自己的账本负责，不能仅凭 Root 退出宣称所有后代消失。
- Runner 异常退出后，Host 检查服务记录再把缓存状态改为 failed 或 cleanup_failed；停止事务且确实无残留时才 stopped。检查失败保留可观察的残留，不再返回旧 ready。Host SIGKILL 后 Runner 通过实际 IPC 断开自清理，下次 Host 对账已退出的 Root 记录；活资源仍保留并提示。

## IPC 契约与兼容性

每条请求有唯一 requestId；仅 inputs-changed 是单向通知，Phase 3 自动刷新尚未实现。新增 status；shutdown 现在也是请求。start/stop/refresh/switch-scenario 带 ownerSessionId。确认可带 `result: {status, previewId?, previews?, residual?}`，其中 previews 是无消息封套的快照；ok 必须与 status=ok 一致。负确认通过 RunnerConnectionError 保留实际 diagnostics 和 result。

双向数据严格校验，未知字段/非法嵌套字段明确拒绝，不回显原载荷。RunnerConnection 检查握手 PID、顺序与重复握手，按 requestId 关联乱序响应；迟到响应不完成其他请求。取消/超时只结束等待，保留可能已受理的绑定供 status/stop 找回，不冒充 stopped。断连/退出拒绝全部等待者。异步 fork 错误监听保留到实际退出/启动失败；Node 24 显式 disconnect 后不保证发 close，不能仅等待 close。

这些是未发布的内部接口变更，两端必须同步构建和重启，不支持新旧协议混用。配置 JSON、账本 JSON、对外工具参数未改变；没有持久数据迁移。回滚使用对应 Git 提交，并保留未确认回收的账本。

## 实际验证

macOS 15.7.7 arm64、Node v24.13.1。测试只运行临时原文件副本、测试专有进程和回环服务，不访问模型/真实后端，不写批准记录。

- runner-connection：10 项真实 fork 通信回归，含乱序/迟到确认、取消、负确认、退出、非法载荷、握手和缺失可执行文件。
- runner-client：6 项真实产品执行回归，含原文件 HTTP 与 PID 归属、Owner 隔离/复用/并发、另一个 Host 不接管活 Runner、坏账本初始化失败及修复后重试、配置变更/未批准执行/非法嵌套字段、Runner SIGKILL，以及单独 Host 进程 SIGKILL 后清理和下次启动对账。
- node-runtime 与 runner-protocol：3 项检查 Node 来源/版本、调用者身份、请求 ID、嵌套快照与确认一致性。

集成时发现并修正：Session.snapshot 带有 state 消息封套，不能直接当作确认结果中的裸快照，否则 Host 会正确拒绝；现于命令边界显式取出快照字段，有嵌套未知字段回归。

实际检查输出：

```text
npm run typecheck → 退出 0
npm test          → tests 119; pass 119; fail 0; skipped 0
npm run build     → 退出 0
node --check      → 两个 IPC/执行烟测脚本通过
git diff --check  → 退出 0
```

自动化覆盖（R4-5 起取代原编译产物烟测）：`tests/unit/runner-connection.test.ts`（握手、"wrong PID, pre-handshake messages and missing handshake fail explicitly"、"a repeated handshake is a protocol failure"、"unexpected peer exit rejects every pending waiter and reports failure once"）、`tests/unit/session-registry.test.ts`（public open→static.start→清理）。原 `scripts/verify-runner-ipc.mjs` 与 `scripts/verify-host-runner.mjs` 已随 R4-5 删除。

历史记录：第二个脚本曾直接调用编译后的 RunnerClient、真实 main 与产品 static.start——五个原文件 SHA-256 前后相同；监听 PID 属于 Runner，其他会话无法停止；同计划复用；未知 JS 返回 404；重复 stop 和 dispose 后无端口、PID 或账本残留。结果写入 output/host-runner-static.json，不输出 HTML 或 nonce。HTTP 请求没有执行浏览器脚本，所以 targetMounted/freshness 仍为 unverified，state 为 reachable；没有做 DSH 载体或模型验收。

本次编译烟测实际记录：Host PID <pid>、Runner PID <pid>，Node v24.13.1；originalFilesUnchanged=5，ownerIsolation/samePlanReuse=verified，stoppedPort=no-listener，shutdown=no-process-or-ledger-residual。入口烟测另验证未知 preview 返回 not_found、空会话 shutdown 退出 0。

公共 open、检测与计划、批准交互、project/attach/Vue 适配器、Client 联动与目标断言仍待后续开发。上文 119 项为 IPC 提交时的历史结果；后续状态工具集成后完整回归为 129 项。其他平台尚未实测，当前进程归属基础设施对非 macOS 明确失败。
