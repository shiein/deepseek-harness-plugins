# R5 总汇报（2026-11-03）

计划：`docs/r5-plan.md`。范围：数据 Mock 闭环 → CLI 对齐 → 浏览器/Linux 证据 → 路由与视口 →
截图边界 → 面板一键打开 → React 适配器 → Tier 2 冒烟 → 首版收口。
检查点：CP0 `r5-cp0`（540/540）→ CP1 `r5-cp1`（568/568）→ CP2 `r5-cp2`（577/577）→
CP3 `r5-cp3`（587/587）→ CP4 `r5-cp4`（见下）。全部 typecheck 0、line-length 通过、0 跳过。

## 1. 各工作项结果

| 项 | 结果 | 证据边界 |
| --- | --- | --- |
| R5-1 数据 Mock 闭环 | 草稿写回、来源分层、跨源基址、登录前置、项目 Mock 只读识别、写操作模板、WS/SSE 受控响应 | 自有 fixture + headless Chrome / HTTP 级；业务真实后端不转发（设计边界） |
| R5-2 CLI 对齐 | Vue CLI 三工具链 scenario/assertions/navigation 放行并实测；Tier 1 矩阵 element-plus/antdv4 `verified: true` | macOS + headless Chrome；CLI 侧 scenarioApply/Reset/refresh 保持 `unknown` |
| R5-3 浏览器/平台证据 | Vite 浏览器端 refresh 实证（freshness→current）；Linux Docker 全链路 HTTP/进程级；CSP Worker/SW 边界记录 | Linux 无浏览器（Chromium 156 另在 `docs/evidence/2026-11-03-linux-browser-evidence.md`） |
| R5-4 路由与视口 | 路由目标、父布局、视口框架页、in-app 导航真实浏览器证据 | static/attach 路径 viewport 如实 `unsupported` |
| R5-5 截图 | 锁定 SDK 无载体截图 API → `captureCurrentView` 保持 `unsupported`，不以 ImageBlock 伪造 | 待 DSH 载体 API 或 Aesc 实机（r5-blockers §1） |
| R5-6 一键打开 | 建议行 `open` 载荷 → `pagePreview/open` → 复用 `openAttempt` 全路径含官方审批 | 面板真实点击未验；审批接缝由真实 ApprovalService+open turn 覆盖 |
| R5-7 React 适配器 | `react-vite`：检测/静态 Vite 分析/入口重放（Provider 链保序、Router→MemoryRouter、叶替换）/生成 setup/生命周期/路由/HMR/影响分析/antd+mui profile；按 Vue 分层落地，core 零 React 分支 | `react18-vite` 工具链 + headless Chrome（runtime 4/4、entry-replay 7/7）；README 27 行 |
| R5-8 Tier 2 冒烟 | 七库真实包冒烟 7/7（naive-ui/tdesign/vant/arco/vuetify/primevue@4.2.5 Vite 侧 + view-design Vue2/CLI 侧） | 按方案只记冒烟通过，不标 verified；primevue 4.5.5 因 Vue 3.5 `useId` 依赖降 4.2.5 |
| R5-9 收口 | 调参实测（baseline 1500ms≈15 万文件、MAX_DIAGNOSTICS 8）；resume 语义按锁定 SDK 类型定论；zod 告警调查（锁定线无修复版本，不升级，登记风险）；干净安装验证（补 `dsh-llm` peer 后 main/typert/remote 导出 3/9/9 可加载，`browser/react` 入包）；guide「真实项目接入」章；兼容矩阵定稿（每条 supported 挂 README 样本行） | DSH profile 安装、resume 实测、面板点击、业务样本验收仍属实机清单 |

## 2. 根因级修复（本轮定位并修复的实质缺陷）

- **worker 优雅关闭失效**（CP2）：`vite.close()` 永不 resolve，SIGTERM 实质失效、全靠 2s
  宽限后 SIGKILL 兜底 → `finish` 有界化 + 主动断连，各 stop 明显加快。
- **React Fast Refresh preamble 被拦**（CP4）：`/@react-refresh` 未进资源准入白名单 →
  preamble 404 → 组件模块抛错；准入与 `/@vite/client` 同级修复。
- **入口重放两处缺陷**（CP4）：`RouterProvider` 作叶子不产生路由层 → 叶子路由组件转为
  MemoryRouter 层；不合格 style/side-effect 导入仍写入生成 setup → `excluded` 标记跳过。
- **包级运行时依赖缺口**（CP4）：`session-registry` 运行时引用 `dsh-llm` 的 `ToolCallId`
  brand 函数但未声明 → 按锁定版补入 peers/devDeps，干净安装验证通过。
- **primevue/Vue 版本硬冲突**（CP3）：`@primevue/core`（primevue 4.5.5 依赖）用 Vue 3.5
  才有的 `useId`，与工具链 Vue 3.4.27 不兼容并导致 optimizeDeps 崩溃 → 钉 4.2.5。

## 3. 证据边界与未决事项

- verified 口径：仅矩阵级证据（Tier 1 规格 + README 通过行）；Tier 2 冒烟不升级。
- 平台：macOS arm64 实测基准；Linux Docker HTTP/进程级 + Chromium 浏览器证据；
  Windows 无实现。
- 实机清单：`docs/r5-blockers.md` §1（截图到模型、DSH profile 安装、resume 实测、
  面板点击、overview/web 业务样本、DSH 载体 SW）。
- 发布风险：zod 4.4.3（GHSA-mrhx-c7xc-m3w5）锁定线无修复版本，不升级、登记在案；
  发布/安装动作本身需单独授权。
