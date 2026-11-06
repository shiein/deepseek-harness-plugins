# 架构

> 面向开发者：描述当前代码结构与边界，不写历史过程（历史在 `docs/progress-log.md`、
> `docs/evidence/`）。模块文件头注释标注对应方案章节；硬约束见 `AGENTS.md` §5。

## 1. 进程模型

```text
DSH Host（插件进程，src/host/）
  └─ Runner（每工作区一个子进程，src/runner/main.ts；IPC 协议 src/shared/ipc.ts）
       ├─ RunnerSession：static / project-command / existing-server 预览直接在 Runner 内运行
       └─ Vue worker（每预览一个：Vite dev server 或 cli-service，项目自己的构建器编译）
```

- Host 只调用适配器的 `probe`/`discover`/`plan`/`impact`（全部只读）；`start` 只能经 `RunnerClient`
  在 Runner 内执行。项目代码（vue.config.js、vite.config、cli-service）只在 Runner/worker 进程执行。
- 所有模块 import 时无副作用；`browser/` 下文件被目标构建器编译或内联注入，必须是普通 JS。
- 资源所有权：账本（`runner/ledger.ts`）登记进程（PID+启动时间）、端口、临时目录、监听器；
  `stop` 只释放调用者拥有的资源；无法核对的残留如实 `cleanup_failed`，`stop {recover:true}` 对账回收。

## 2. 模块与依赖方向

与 `AGENTS.md` §6.3 一致：

```text
shared    ← 所有模块；自身不 import 其他模块（contracts、errors、redact、fingerprint、config/*、ipc、debug-log）
core      → shared；对 adapters/types、runner 只 import type（plan、target、impact、profile）
runner    → shared；基础设施不得 import adapters（ledger、process-tree、port-ownership、response-layer）
adapters  → shared、core（类型）、scenario、runner 基础设施（registry、static、project-command、
            existing-server、vue/{vite,cli}、vue/ui-kits/* 纯数据 profile）
runner 编排 → adapters、runner 基础设施（main.ts、session.ts、controller.ts）
host      → shared、core、adapters/registry（仅 probe/discover/plan/impact）；经 shared/ipc.ts 通信
browser/  → 不 import src 任何 TS（bootstrap.js 经典脚本 IIFE；vue/* ES2018 ESM）
```

## 3. 状态与证据

- `SessionState`：`preparing → starting → reachable → ready`；另有 `degraded`、`updating`、
  `failed`、`stopping`、`stopped`、`cleanup_failed`（终态：`stopped`/`failed`；`cleanup_failed` 非终态）。
- `readiness` 三层：`service`/`document`/`target`，各自 `unverified`/`proven`；三层全 proven 才 `ready`。
- `freshness`：`unverified`/`stale`/`current`；`current` 需「编译成功 + 浏览器证明同版本已应用」。
- `SessionState` 与工具结果 `ResultStatus` 严格分离（`shared/contracts.ts`）。
- pageText 是浏览器上报的可见文本观察（限长、脱敏），不改变 readiness/freshness 语义。
- Host 缓存：每 owner 保留最近 16 个终态预览（`MAX_TERMINAL_PER_OWNER`，`host/snapshot-retention.ts`）。

## 4. 受控响应层与回传通道

- `runner/response-layer/`：预览自有 loopback 服务；同源请求按 fixture/handler 匹配，未命中如实
  `unmatched_request`（404）；CSP 分指令约束 script/style/img/frame/worker/font/media/connect；
  跨源请求改写为显式失败；`/__dsh_preview/report` 携带 nonce 的浏览器上报通道（document-loaded、
  assertions、runtime-error、page-text 等）。
- `src/browser/bootstrap.js`：注入页面的 IIFE；DOM 断言、错误回传、pageText（首帧立即、之后 1s 节流）、
  HMR 边界协作；`pagehide` 清理 observer/timer。
- `src/browser/vue/`：preview-entry 模板 + lifecycle 编排 + mount-vue2/mount-vue3 + setup-contract；
  Vue 从目标项目解析，业务模块一律动态 `import()`。

## 5. 执行批准

- 执行指纹 v2（`shared/config/fingerprint.ts`）：`command`/`env`/`setup`/场景 `handlers` 的文件字节 +
  入口自动生成 setup 的哈希。变化 → `config_changed_needs_approval`。
- 批准只来自官方 `allowed-once` 答复：同 DSH 会话 + 同指纹内有效、仅存 Host 内存、不落盘；
  执行项变化/换会话/重启须重问。`danger-full-access` 会话按权限预设放行并带 `approved_by_permission_preset`。
- 指纹经 `start` IPC 传 Runner，执行前重核；Host 内存 `grants` 表维持有效期。

## 6. 脱敏与日志

- 唯一脱敏策略 `shared/redact.ts`：env 值、`.env*` 文件值、回传 nonce 按值替换 `[redacted]`；
  Cookie/Authorization 头去除；转发 URL 去 userinfo/query/fragment；堆栈限 5 帧。
- 结构化调试日志（`shared/debug-log.ts`）：Host `<dataDir>/logs/host.jsonl`，
  Runner `<dataDir>/logs/runner-<工作区 sha256 前16位>.jsonl`；单行 JSON、2MB 滚动 `.1`、
  与诊断同一脱敏策略；意外失败诊断 hint 附日志路径，写失败如实说明。
  条目按归属脱敏：可归属预览用该会话密钥（env 值 + 通道 nonce），Runner 级条目用存活会话
  密钥并集，Host 侧用工作区项目 env 并集；nonce 经内部 `channel-secrets` 消息上报 Host，
  只进 `RunnerClient` 脱敏密钥集，不进任何输出。
- 诊断码登记在 `shared/errors.ts`；hint 必须是 Agent 可执行的下一步。

## 7. 适配器与能力

| 适配器 | 策略 | 说明 |
| --- | --- | --- |
| `static` | static | 原文件 HTTP + 注入 bootstrap；SPA 可选回退。 |
| `project-command` | project | 批准后按 command/env 托管进程；服务探针就绪。 |
| `existing-server` | attach | 观察用户已有的 loopback 服务；脱离不停止、不注入。 |
| `vue-vite` | isolated | Vite dev server worker；入口注册重放/setup、HMR、freshness。 |
| `vue-cli` | isolated | cli-service worker；devServer 逐字段接管、`.env*` 拦截、wds v3/v4。 |

能力声明与允许执行分开：`supported` 需实现+样本证据；未验证组合照常执行、能力 `unknown`、
附 `unverified_toolchain`；组件库差异只在 `adapters/vue/ui-kits/*.ts` profile 数据。
兼容矩阵以 `tests/fixtures/README.md` 为准。

## 8. 场景与影响分析

- 场景：`identity`/`permissions`/`state`/`props`/`route`/`locale` 经 reviewed setup 生效；
  同源 HTTP fixtures + `bodyFile` 二进制 + 项目 `handlers`（import 前等 Root 复核）；
  `fixtureDraft` 草稿由 `status detail` 的未命中汇总生成，占位标记未清即 `config_invalid`。
- `turn/end` 影响分析（`core/impact`）只读：文件/样式改动映射到目标候选与面板建议；
  `inputs-changed` 通知到已有预览；`trigger: always` 的 auto-open 未实现（D2）。

## 9. 面板（Client）

`client/`：会话目录流 + 面板（预览列表、诊断、停止、未命中区块、建议）+ 主题 `--dsw-alias-*`；
URL 经 `sidebarRight.openTab('browser', {params:{url}})` 在 DSH Browser 页签打开。
`dev/bridge` 是独立的 phase0 载体探针包（`npm run build:phase0-bridge`），不属于产品链路。
