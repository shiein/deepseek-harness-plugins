# R5 计划：剩余全部工作（数据 Mock 闭环、路由与视口、截图与自动打开、React 适配器、发布）

- 编写：2026-11-03（Claude，Aesc 要求"把所有剩余任务都写进去"）；执行：Devin
- 状态：**已定稿，可执行**（2026-11-03）。Aesc 授权一次性完成全部任务、中途不需要 Aesc 操作或确认：
  §1 的决策按 Claude 建议执行；无法在 Devin 环境完成的事项记入阻塞清单后跳过，继续做其他任务（§2）
- 前置：上一轮（1d6e68b、ee07ac2、b2a45f9、697d121）已由 Claude 复核，复核中要修的问题列为 R5-0（§3.0）
- 依据：方案 §1.3、§7、§9.3、§14～§16，`docs/r4-plan.md` §5，`docs/limitations.md`，代码中剩余的
  `TODO(phase0)`、`TODO(phase1)`、`TODO(phase2)`、`TODO(sample)`

## 0. 结论先行

按方案，首个可用里程碑是 Phase 0～2 的手动预览与场景能力，再加 Phase 4 的验证和打包。代码层面基本已齐，
剩下三类工作：

1. **首版补完**：让真实业务页"有样式、有数据、能切换角色"，并让 Vue 2 与 Vue 3 能力对齐。
   主要是数据 Mock 闭环、登录前置的入口、路由与视口、各项能力的样本证据。
2. **曾被搁置的功能**：截图（D4）、自动打开（D2）、执行项目自带 Mock（D1）、视口。§1 中已给出建议默认做法。
3. **里程碑之后的扩展**：React + Vite 适配器、Tier 2 组件库冒烟，最后是发布准备。

规模估计：§3.0 的复核修复加上 §3 的 9 条工作流，React 一项就约等于当初 Vue 3 + Vite 的工作量。
Devin 一次性做完，按 §4 的 5 个检查点提交并打本地 tag；全部完成后，Claude 按检查点逐段复核。

## 1. 决策（2026-11-03 已定：Aesc 授权按 Claude 建议执行）

| # | 事项 | 选项 | 采用（Claude 建议） |
| --- | --- | --- | --- |
| D1 | 项目自带 Mock（vite-plugin-mock、mockjs、MSW 等）能否在预览中执行 | a 只识别、提示改写；b 作为新执行项经审批后在 Runner 中执行 | **b，但只做 MSW 和 vite-plugin-mock 两类**：它们有明确的加载边界；mockjs 拦截的是 XHR 全局，做成只读转换建议 |
| D2 | 自动打开预览 | a 只推荐；b 面板一键打开（用户点击即授权）；c 轮次结束自动打开 | **b**：点击本身就是用户授权，不需要另造审批；c 没有审批上下文，不做 |
| D4 | 截图 | a 不做；b 只给用户看；c 也交给模型 | **先做 b，c 依据实测决定**：DSH 注释写明当前只有 user content 能携带图片，先实测，能到达模型再开 c |
| V | 视口控制 | a 不做；b 插件自有外层页面 + 固定尺寸 iframe | **b**：只有真实 iframe 宽度才能让媒体查询生效；用容器宽度模拟等于伪造 |
| N | Vue CLI 的 assertions、navigation | a 保持拒绝；b 补实现 | **b**：老项目同样需要确认元素已显示、自动跳路由，与 Vite 行为对齐 |
| R | React 适配器范围 | a 不做；b React 18 + Vite，JS/TS；c 再加 CRA / webpack | **b**：CRA 已停止维护；webpack 路径留待有真实项目时再做 |
| S | 第二个真实业务样本 | 由 Aesc 提供 Vue 2 + Element UI 项目（只读） | 本轮没有。element-ui 保持 `verified: false`，用测试工具链补齐其余矩阵，在 limitations 中写明 |
| P | pageText 早于挂载（上一轮任务 D） | A 如实标注"尚未采集到"；B open 等待首个文本；C 不采首帧 | **A**：与既定决策"open 不等首次渲染文本"一致，不等待、不伪造 |
| W | Windows | a 继续返回 unsupported；b 实现 | **a**：进程组和 PID 核对需要另一套实现，没有真实需求前不做 |
| T | 测试方式 | a 沿用"开发完再集中测"；b 每个工作流自带测试 | **b**：本轮规模大，集中测试会积压数百条测试债，R3 就出现过测试暴露 4 处缺陷的情况 |

## 2. 工作规则（在 R4 规则基础上调整）

- 每个工作流完成时，其测试同时完成（决策 T-b）。不再留 `TODO(test:r5-N)`，除非需要真实 DSH 或真实项目。
- 锚点：`TODO(r5-N)` 是开发锚点。需要实机验证的事项列入 `docs/development-progress.md` §2.4 的实机清单。
- 能力等级规则不变：`supported` 必须同时有实现和样本证据；只有 HTTP 层证据不算浏览器端证据；
  无头 Chrome 的证据算浏览器端证据，但不等于 DSH 载体中的证据（两者分别写明）。
- 新增诊断码、工具参数、输出字段、工具时，按 AGENTS.md §7 同步方案。本轮 Aesc 已授权对外契约的新增，
  但已有工具参数和输出字段的**语义不得改变**（只能新增，不能改义）；设计写进方案对应章节和提交信息。
- **本轮授权（Aesc 2026-11-03）**：
  - 可以新增**测试用**工具链：清单写在 `docs/toolchains/`，精确版本，安装到 `tests/toolchains/<组合>/`，
    由 `scripts/install-toolchains.mjs` 幂等安装。React、Tier 2 组件库、MSW、vite-plugin-mock 的样本都走这条路。
  - 仍然禁止：新增插件**运行时**依赖（`package.json` 的 `dependencies`）、升级 DSH、push、发布、
    在任何 DSH profile 中安装插件、访问 Aesc 的业务项目。
- **不等待**：遇到 §6 所列情形，写进 `docs/r5-blockers.md`（现象、已尝试、需要谁做什么），跳过该子项，
  继续后续任务。只有违反 AGENTS.md §5 硬约束才能"跑通"的事，一律不做。
- 提交：每个子项至少一个本地 commit；每个检查点结束打本地 tag（`r5-cp0`～`r5-cp4`），
  并在 `docs/development-progress.md` 记录该检查点的提交范围和全量回归结果。

## 3. 工作流

### 3.0 R5-0 上一轮复核需要修的问题（Claude 2026-11-03 复核 3c0233c..697d121）

复核结论：typecheck 0、line-length ok、`npm test` 531/531/0 跳过（macOS arm64，Node 24.13.1，Claude 本机复跑）。
`setup_missing_styles` 在 Aesc 的真实业务项目上只读复跑过，能正确列出漏掉的 4 个以上样式。以下是要修的问题：

| ID | 问题（已核实） | 要求 |
| --- | --- | --- |
| R5-0a | open 返回的 pageText 是挂载前的首帧空文本，输出成 `pageText: ''`，读起来像"页面没有文字"（`697d121` 已复现，根因为采集时机） | 按决策 P-A：早于 mounted 信号的 pageText 不当作页面文本输出，改为如实标注"尚未采集到"，hint 指向 `page_preview_status`。不增加等待。`tests/unit/taskd-pagetext.test.mjs` 由"现状刻画"改为断言新语义，并改名为 `open-pagetext-timing.test.mjs`。同步方案 §4.2 中 open 输出的说明 |
| R5-0b | CLI 场景更新在入口未生效时（编译失败或 30s 超时）仍执行 `swappable.replace`，Runner 随后把 `plan.scenario` 改为新场景名（`src/adapters/vue/cli/worker.ts` 场景更新段、`src/runner/session.ts` 约 227 行）。结果：Mock 数据是新场景，页面 props 仍是旧场景，status 显示新场景名。代码注释"入口重写/编译失败不动服务中场景"与行为不符 | 二选一并写明理由：① 入口未生效时不换绑，返回错误，保持旧场景，status 仍是旧场景名；② 换绑但 status 明确标注"数据已切换、入口待生效"。推荐 ①，与注释和 Vite 路径"异常不动服务中场景"一致。补失败路径测试（编译失败、超时），在 vue26-cli 上跑 |
| R5-0c | `src/adapters/vue/vite/worker.ts:330` 剩余的 `TODO(test:r3-2)`：`invalidateAll` 缺失时如实拒绝、编译失败时 ack stale、`docBuild` 不随 HMR 变化 | 在 vue3 自包含工具链上补齐这三项测试后删除锚点；确实无法构造的，写清原因 |
| R5-0d | AGENTS.md §2 有过时描述：标题日期仍是 2026-11-02；"R3-0 至 R3-7 … 🟨 测试待补"和"416/416"已过时（R3 已全部 ✅）；"scenarioReset … 能力等级保持 unknown"与 Vite 已验证组合为 supported 不符；"最新检查 … 416/416" | 按当前事实改写 §2，只写要点；每完成一个检查点再更新一次 |
| R5-0e | `docs/development-progress.md` 的"待 Aesc 确认"第 1 条（"全部批准"的范围）已过时 | 改为引用本计划 §2 的本轮授权；第 2、3 条（DSH profile 安装、真实 Vue 2 样本）仍然保留 |

### R5-1 数据 Mock 闭环（首版核心）

目标：一个真实业务页从"有样式、没数据"变成"有数据、能切角色"，过程中不伪造、不连真实后端。

| 子项 | 内容 | 完成标准 |
| --- | --- | --- |
| 1a 草稿可写回 | 现在 `fixtureDraft` 只是给 Agent 抄的文本。增加经确认写回配置的路径：复用 `setup-write-approval` 的确认机制，Agent 提交填好的 fixtures，用户确认后插件写入 `page-preview.config.json`。仍含占位标记的拒绝写入 | 写回只改配置文件、经用户确认、可回滚（写前备份）；不写业务源码 |
| 1b 数据来源 | 按方案 §7.2 的顺序起草响应：项目已有 fixture/Mock 数据 → OpenAPI / JSON Schema → TypeScript 接口类型。都只读解析，起草结果标明 `provenance` | 每条草稿都写明来源；只有类型定义时明确标注"字段来自类型，值为示例" |
| 1c 跨源 API 基址 | 项目通过 axios `baseURL` 或环境变量指向其他 origin 时，bootstrap 已把它改写到同源 Mock 层。补齐：fixtures 按原 origin 匹配、未命中诊断带原 origin、草稿带 origin | overview/web 这类项目的接口在 status 中能看到原 origin |
| 1d 登录前置入口 | 入口先调登录接口、再 `initVue()` 的项目（overview/web 就是这样），自动生成的 setup 会照搬这段初始化。场景提供 `identity` 时，让登录接口的 fixture 按场景返回，用原业务流程完成"已登录"；没有 fixture 时如实报 unmatched | 不绕过、不伪造业务鉴权逻辑；绕过点写进 knownDifferences（方案 §7.1） |
| 1e 执行项目自带 Mock（D1-b） | MSW：复用项目的 `mockServiceWorker.js` 和 handlers，先在 iframe 中实测 Service Worker 能否注册（方案 §7.2），不能注册就如实 unsupported。vite-plugin-mock：在 worker 内按项目配置加载。都作为执行项计入指纹并经审批 | 未命中仍是 `unmatched_request`；Mock 的覆盖面在 `NetworkCoverage` 中如实报告 |
| 1f 写操作 | 已有 ScenarioStore + handlers。补齐草稿：写请求（POST/PUT/DELETE）生成 handler 模板，注明"写操作不会反映到后续读取，除非 handler 读写 store" | 没有 handler 的写请求维持现有诊断 |
| 1g 非 HTTP 通道 | WebSocket、SSE：现在是阻断。增加声明式 fixture（固定消息序列），仍是同源受控 | 未声明的连接仍阻断，并有诊断 |

测试：每个子项都要覆盖失败路径（占位未填、来源冲突、Service Worker 注册失败、审批被拒）。
1d 和 1e 都要在 tests/toolchains 样本上跑真实链路。

### R5-2 Vue CLI 与 Vite 能力对齐（决策 N-b）

- CLI 路径补齐 assertions（显式选择器和文本断言）和 navigation（`setup.navigate`，核对最终 fullPath），
  机制与 Vite 路径一致，不另立语义。
- Tier 1 UI 组件库 profile 的 `verified`：
  - element-ui：本轮没有真实样本（决策 S），用 vue26-cli 工具链补齐其余矩阵项，`verified` 保持 false
  - element-plus、ant-design-vue：用 tests/fixtures 的完整样本补齐矩阵（按需引入、全局 API、完整重置）
  - 通过后才改 `verified: true`，并同步方案 §6.9 和 fixtures README
- `src/adapters/vue/cli/index.ts` 的支持版本范围（`TODO(sample)`）：按 vue26-cli、vue26-cli4、vue27-cli 的实测结果填写。

### R5-3 浏览器端证据（让能力等级如实升级）

- 在 tests 中加入真实浏览器（已有 headless Chrome 用例的基础上），证明 refresh 和 HMR 在浏览器中**确实应用**了新版本：
  页面上出现新标记，且 bootstrap 报告的 build 号一致。证据充分后才把 Vite 的 `refresh` 改回 supported。
- 同样为 CLI 路径和 Linux（Docker + Chromium）收集浏览器端证据，替换之前未归档的"135/135"说法。
- `src/runner/response-layer/csp.ts` 的 `TODO(phase0)`：Worker / Service Worker 数据边界的实测（与 1e 一起做）。

### R5-4 路由与视口（决策 V-b）

- **路由发现**：只读读取项目 router 配置（已有 route-map），在 `page_preview_open` 中支持 `target.kind: 'route'`：
  按路由找到组件和父布局。找不到或有歧义时如实报告，不猜。
- **父布局**：可选择把目标放在原布局组件中渲染（布局本身来自项目代码），默认仍只渲染目标。
- **视口**：插件自有外层页面加固定尺寸 iframe，`viewport` 参数从 unsupported 变为可用。
  断言、pageText、截图都在内层文档中取。外层页面不能影响内层页面的样式。
- 跨页导航（在预览中点链接跳到别的页面）：仅在项目路由内导航，跨应用导航继续 unsupported。

### R5-5 截图（决策 D4）

- 先做 Phase 0 实测：在 DSH 中让工具返回 `image` 块，确认模型能否看到。结论写入方案 §4.1。
- 用户侧：面板展示截图，来源必须是当前浏览器的实际画面（current-view），不用重放渲染冒充
  （`session-registry.ts:429` 的 `TODO(phase2)`）。
- 截图必须标明对应的 build 号和场景名，旧画面不得被当作本轮结果（方案 §14 Phase 4）。
- 实测证明图片能到达模型后，才开放给模型。

### R5-6 面板一键打开（决策 D2-b）

- 面板中的推荐候选可以点击。点击视为用户授权，调用与 open 相同的路径（执行项仍按指纹审批，点击不跳过审批）。
- 不做轮次结束后的自动打开（D2-c）。

### R5-7 React + Vite 适配器（决策 R-b）

按 Vue 适配器的分层复制一遍，不在 core 中写 React 分支：

| 子项 | 内容 |
| --- | --- |
| 7a 检测 | 只读识别 react、react-dom 版本、`@vitejs/plugin-react` / `plugin-react-swc`、入口 |
| 7b 入口重放 | 从入口识别 `createRoot(...).render(<Providers><App/></Providers>)` 的 Provider 链（Router、Redux / Zustand、QueryClient、ThemeProvider、i18n），生成 setup：保留 Provider，把 App 换成目标组件。业务路由换成内存路由 |
| 7c 浏览器侧挂载 | `src/browser/react/*.js`（ES2018 ESM，react 从目标项目解析），处理挂载、卸载重挂、错误边界上报 |
| 7d 场景 | props、identity、state 经 setup 传给原 Provider；HTTP fixtures 与 Vue 共用响应层 |
| 7e HMR 与 freshness | react-refresh 的更新证据，与 Vue 路径相同的"浏览器证明同版本已应用"规则 |
| 7f 影响分析 | 复用模块图，补齐 JSX/TSX 和 React Router 路由表的识别 |
| 7g UI 组件库 | Tier 1 先选 Ant Design（antd 5）、MUI 两个 profile，数据写在 profile，不写分支 |
| 7h 样本 | 新增测试工具链清单 `docs/toolchains/react18-vite.md`（本轮已授权，见 §2），精确版本 |

React 18 + Vite 5 一个组合有样本证据后，才在 macOS 上标 supported。React 19 和其他构建器按 unverified_toolchain 照常执行。

### R5-8 Tier 2 组件库冒烟

- `src/adapters/vue/ui-kits/tier2.ts` 中列出的 7 个组件库（Vant、Naive UI、Arco Design Vue、TDesign、View UI / iView、
  Vuetify、PrimeVue）各做一次冒烟：能渲染、样式加载、无运行时错误。新测试工具链按 §2 的本轮授权添加。结果只写"冒烟通过"，不标 verified。

### R5-9 首版收口与发布准备（发布动作本身需要单独授权）

- 遗留调参：`src/host/output.ts` 的诊断条数（`TODO(phase1)`）、`src/core/change/baseline.ts` 的时间预算，
  在 tests/toolchains 上测定取值；真实项目上的复核写进实机清单。
- `src/host/turn-tracker.ts` 的 `TODO(phase0)`：DSH 会话恢复（resume）时的事件语义。
- 干净环境安装验证：从 `npm pack` 的产物在全新临时目录安装，验证能被 Node 加载、导出完整。
  在隔离的 DSH profile 中加载这一步需要 Aesc 授权，写进实机清单。
- zod 4.4.3 的审计告警：只调查 DSH 是否有修复版本并记录结论，不升级。
- 文档：`docs/guide.md` 加"真实项目接入"一章，以 overview/web 的经验为例（不含项目代码和数据）。
- 兼容矩阵定稿：每项 supported 都能链接到 fixtures README 中的样本行。

## 4. 检查点与顺序

按顺序连续执行，不等复核。每个检查点结束时：全量回归通过（typecheck、line-length、`npm test`），
打本地 tag，在进度文档记录提交范围和回归结果，然后直接进入下一个检查点。

| 检查点 | 内容 | tag |
| --- | --- | --- |
| CP0 | R5-0（上一轮复核修复） | `r5-cp0` |
| CP1 | R5-1（数据 Mock 闭环）、R5-3 中 Vite 的浏览器端证据 | `r5-cp1` |
| CP2 | R5-2（CLI 对齐）、R5-3 其余部分、R5-4（路由与视口） | `r5-cp2` |
| CP3 | R5-5（截图）、R5-6（一键打开）、R5-8（Tier 2 冒烟） | `r5-cp3` |
| CP4 | R5-7（React 适配器）、R5-9（收口）、最终回归（含 `npm run build`、`pack-check`）与总汇报 | `r5-cp4` |

需要 Aesc 或真实 DSH 才能完成的部分（截图能否到达模型、Service Worker 在 DSH 载体中能否注册、面板点击、
overview/web 实机验证、干净 DSH profile 安装）：Devin 做完能在本环境做的部分（实现、无头 Chrome 证据），
能力等级保持 unknown，剩余步骤写进实机清单，不阻塞后续检查点。

为什么数据 Mock 排第一：Aesc 当前的真实使用卡在"有页面没数据"。
为什么 React 排最后：方案把它定为里程碑之后的扩展，并且它依赖前面沉淀下来的通用机制（Mock、视口、截图）。

## 5. 明确不做

- Svelte、Angular、SSR / Next.js / Nuxt 的隔离适配（方案 §1.3、§16：先有真实需求，再进支持矩阵）。
- Windows 支持（决策 W-a）。
- 轮次结束后自动打开预览（D2-c）。
- 复制用户浏览器的登录状态；清空用户 Cookie / Storage 来"重置"场景（AGENTS.md §5 第 6、10 条）。
- 为了跑通而改写业务鉴权逻辑或替换业务组件。

## 6. 记入阻塞清单并跳过的情形（本轮不停下等待）

写进 `docs/r5-blockers.md`（每条：子项 ID、现象、已尝试、需要谁做什么、对能力等级的影响），然后跳过该子项继续：

- 需要改变现有工具参数或输出字段**语义**（新增可以，改义不行）。
- 需要新增插件运行时依赖，或升级 DSH。
- Service Worker 在无头 Chrome 的 iframe 中无法注册（MSW 路径如实 unsupported，并记录）。
- 方案、AGENTS.md、进度文档之间有冲突：按"Aesc 决策 > 方案 §0.3 > 方案正文 > AGENTS.md"取舍，
  并在阻塞清单中写明冲突点和取舍，由 Claude 复核。
- 某项能力只能靠伪造、静默降级、改业务代码或在 Host 中执行项目代码才能"跑通"：不做，记录原因。
- 测试工具链安装失败（网络、版本不存在）：换同主版本的最近精确版本，仍失败则记录。
