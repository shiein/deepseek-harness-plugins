# AGENTS.md：dsh-page-preview 开发约束

本文件约束所有接手本项目的 AI 和开发者。优先级：用户当前的明确要求 > 本文件 > 个人习惯。与方案文档冲突时，先停下来指出冲突，不要自行选择其中一边。

## 1. 先读什么

1. `dsh-page-preview-development-plan.md`（下称“方案”）。它是产品与架构的唯一依据。至少读 §0.1.1、§1、§4、§6.2、§6.8、§6.9、§9.2、§14 至 §16。
2. 本文件。
3. 要改哪个模块，就先读该模块文件头的注释。每个文件头都标注了对应的方案章节。

## 2. 当前状态（2026-11-04，R6 已完成 r6-cp0～r6-cp3）

- **R6 已落地（`docs/r6-plan.md`，检查点 `r6-cp0`～`r6-cp3`）**：无 Mock 项目的一轮补数据——real-traits 样本、场景 `envelope`（`__DSH_PREVIEW_DATA__` 展开 + `envelopeHint` 只读建议）、`fixtureDraft.contexts` 调用点上下文（只读有界、脱敏、`context_incomplete` 不阻断）、`write_scenario { mode:'merge', applyTo }`（只追加新键、冲突整体拒绝、写后 refresh+scenario 就地生效）、`unmatched.sinceLastNewEntryMs` 稳定信号 + 可执行 hint。合成数据模式（R6-5）待 Aesc 决策未做；overview/web 实机验收见 r6-plan §6 清单。
- 2026-11-04 修复：生成 setup 按入口语言参与 Vite 解析（`.js→.ts`），已解析绝对路径不再用 `/@fs/`（f21777c）。

- **当前轮（R5）计划：`docs/r5-plan.md`**（2026-11-03）：上一轮复核修复（R5-0）+ 剩余全部工作（数据 Mock、CLI 对齐、浏览器证据、路由与视口、截图、一键打开、React、Tier 2、收口）。上一轮（R4）：`docs/r4-plan.md`。
- **R5-0（复核修复）已落地**：R5-0a open 的 pageText 只投影挂载后观测、无则 `page_text_pending`（0a5b4a8）；R5-0b CLI 场景更新入口未生效不换绑、回滚入口、如实 compile-error（067bb8b）；R5-0c Vite worker 失败面三例真实工具链实测、TODO(test:r3-2) 清除（945ced2）。
- **R3-0 至 R3-7、R4-1 至 R4-7 全部 ✅**：fixture 草稿/场景重载/项目 Mock 识别/影响分析/轮次触发/面板建议/调试日志/缓存回收均已实现并有测试；真实 DSH 事件流与业务样本验收仍在 Aesc 实机清单。发布准备完成（`scripts/pack-check.mjs` 通过、`docs/limitations.md` 定稿），发布动作本身未授权。

- **进度口径以 `docs/development-progress.md` 为准（第二轮 review：`docs/review-2026-11-02.md`），R2 全部完成，P2 未动**；Aesc 决策见方案 §0.3（v1.4），优先于方案正文。
- 进度文档每项一行状态加证据；本节同样只写要点，不写长段落。
- 已实现：配置/schema/来源/路径、只读识别、指纹 v2、官方确认接缝、Planner、Runner IPC/会话/账本。
- static、existing-server、project-command 已接公开 SDK（真实进程/端口/失败/清理），Linux 生命周期已实测。
- Vue 只读检测/AST 重放、Vite+CLI 预检已实现；未配置 setup 时自动使用入口生成的 setup（计入执行指纹审批，§0.3 第 10 条）；产品注册 vue-vite + vue-cli。
- React 适配器（R5-7）已注册 `react-vite`：React 18/19 安装元数据检测、`createRoot().render(JSX)` 入口静态重放（StrictMode/Provider 链保序、BrowserRouter/HashRouter/RouterProvider→MemoryRouter、叶组件替换、props 顶层 const 依赖入生成 setup）、Vite worker 同 Vue 分层复用 `adapters/worker-host.ts` 与 `adapters/vite/*` 通用件；React 18.3.1/Vite 5.2.12/plugin-react 4.7.0 + headless Chrome 实测 4/4（含 antd/MUI Provider 冒烟与 Fast Refresh），React 19/webpack/CRA 与 data-router 完整路由表保持 `unknown`/`unsupported`；`/@react-refresh` 已准入（plugin-react preamble 真实需求）。
- verified 仅限 macOS + Vue 3.4.27/Vite 5.2.12/plugin-vue 5.1.4 实测组合；其余按 unverified_toolchain 如实执行。
- vue-cli：worker 内跑项目 cli-service、`VUE_CLI_SERVICE_CONFIG_PATH` 包装、devServer 接管、.env* 拦截、wds v3/v4 已验；公开 open 路径已验；CLI scenario 准入已按 §0.3 第 11 条放行；R5-2 起 assertions/navigation 与 Vite 同一机制放行（navigation 仍需显式 setup.navigate），vue26-cli + headless Chrome 与 Linux Chromium 均有实测（`docs/evidence/2026-11-03-linux-browser-evidence.md`）；SUPPORTED_CLI_SERVICE='>=4 <6'（4.5.19 wds3、5.0.9 wds4 均验）。
- 场景：props/identity/permissions/state/locale 经 reviewed setup、同源 HTTP fixtures、Node handlers（import 前等 Root 复核）；`scenarioReset` 在已验证 Vite 组合为 `supported`（HTTP 级 coverage 如实标注）；`refresh` 已升回 `supported`（R5-3 headless Chrome 实测 HMR 就地应用；载体未验）；CLI 侧全项保持 `unknown`。
- 路由/视口（R5-4）：`target.kind:'route'` 经只读 route-map 解析叶子组件（未匹配/歧义如实报），`layout:true` 渲染静态父链（router-view 宿主），导航仍须显式 setup.navigate 且项目内导航保留在预览内（跨应用 unsupported）；`viewport` 经插件自有框架页（固定尺寸 iframe，内层取证）在 isolated 路径可用，static/attach/project 仍 `unsupported`。
- 就绪三层（service/document/target 全 proven 才 ready）；freshness 需「编译成功+浏览器证明同版本已应用」才 current。
- 网络：同源响应层受控、未命中 `unmatched_request`；业务 devServer proxy/hook 不执行；R5-1e 起 Vite 下选项可静态求值的 vite-plugin-mock 在 Runner 执行（temporaryRoot 副本、只应答 businessPaths 外同源路径）、MSW 经入口重放的 worker.start() 启用（检出时 bootstrap 放行 SW，否则屏蔽 navigator.serviceWorker）；R5-1g 起场景可声明 `ws`/`sse` 固定序列通道（Vue worker 准入并播放，未声明仍 block/unmatched，static 声明 ws 如实拒绝）；HMR Upgrade 仍归 Vite/CLI 自有监听。
- 批准：会话级（同会话同指纹有效，§0.3 第 8 条）；指纹经 `start` IPC 传 Runner、执行前重核，内存不落盘；测试批准均为合成答复。
- Client：面板列预览/诊断/停止，`--dsw-alias-*` 主题变量，URL 经 DSH Browser 页签打开；Aesc 本机 DSH desktop 已部分实测（overview/web open→侧边栏，逐项证据待 T 阶段归档）。
- 平台：macOS arm64 实测；Linux（Docker `node:24-slim`，arm64，Node 24.22.2）工具链全链路 + Debian Chromium 156 浏览器两条腿（vite refresh、CLI navigation/assertions）通过（`docs/evidence/2026-11-03-linux-browser-evidence.md`）；早前"全 E2E 面 135/135 + Chromium 156"无归档运行记录——未核实；Windows 已实现（2026-11-10，Aesc 决定列入支持矩阵）：`shared/runner/winproc.ts` + `platform-env.ts`，组归属按后代+创建时间，只有合成单测，未实机验收（`docs/limitations.md` §2）。
- 样本：tests/toolchains/ 七套已批准安装（install-toolchains.mjs 幂等；react18-vite 为 R5-7 新增）；Tier 1 矩阵 R5-2 跑齐（`vue-uikit-matrix.test.ts`）：element-plus/antdv `verified:true`，element-ui 矩阵齐但按决策 S 保持 false；Tier 2 冒烟 R5-8 七库全过（`vue-uikit-tier2.test.ts`，软链显式安装版）：naive-ui/tdesign-vue-next/vant/arco/vuetify/primevue@4.2.5（Vite）+ view-design（Vue 2.6 + cli 5）；按方案 R5-8 冒烟不升 `verified`（保持 false，条目注释记实测组合）。注意：Docker 内 npm ci 会覆盖宿主 node_modules 的平台可选依赖，跨平台跑批后需在本机 `npm ci` 恢复。
- 最新检查（2026-11-04）：Node 24.13.1/macOS arm64，typecheck 0，`check-line-length` 通过，全量 `npm test` 598/598/0 跳过（含三套 vue-cli、vue3-self-contained 与 react18-vite 工具链 E2E）；`npm run build` + `pack-check` 通过（539 文件/2476.5 KiB）；worker SIGTERM 优雅退出已修复为真实路径（vite.close() 不返回的根因，关闭有界化）。
- R5-9 收口：`npm pack` 干净目录安装验证通过（main/typert/remote 导出 3/9/9 可加载，`browser/react` 入包；`client.js` 为浏览器产物不以裸 Node 验证）；`session-registry` 运行时引用的 `dsh-llm`（ToolCallId brand 函数）已按锁定版补入 peers/devDeps；zod 4.4.3 告警已调查——锁定线（next=0.2.1-rc.5）全链含 `zod<4.6.6`，alpha 线 0.2.2-alpha.3 已重构但不属锁定范围，保持 pin 不升级、登记发布风险（`docs/r5-blockers.md` §2）。
- Phase 0 记录见 `docs/phase0-verification.md`；overview/web 仅只读识别；图片模型调用按用户决定不执行。
- 授权边界：本地 commit 已授权，禁推送/发布；产品安装/重启需新授权；zod 4.4.3 审计告警保留发布风险。

## 3. 常用命令

```bash
npm install            # 依赖锁定在 DSH 0.2.2-rc.1（next 标签）
npm run typecheck      # tsc --noEmit，必须为 0 错误
npm test               # node --test，直接运行 .ts（Node ≥ 22.18 / 23.6 原生类型擦除）
npm run build          # tsc 输出到 lib/，并把 src/browser/ 复制到 browser/
# 在 DSH 中试运行：复制 dev/cordis.dev.example.yml 为 dev/cordis.dev.yml 并改成绝对路径，然后
pnpm dsh web --patch /abs/path/dev/cordis.dev.yml   # 在 DSH 仓库中执行，UI 地址为 http://127.0.0.1:3080
```

## 4. 工作顺序与 TODO 约定

- 按方案 §16 的工作项顺序推进。手动预览链路已跑通；R3 起按 `docs/r3-plan.md` 的顺序推进影响分析、触发与面板。
- TODO 标签的含义：
  - `TODO(phase0)`：必须先在真实 DSH 或浏览器中实测的事项，结论回写到方案 §4.1 或能力表。
  - `TODO(phase1)` 至 `TODO(phase3)`：对应方案的开发阶段。
  - `TODO(r3-N)`：R3 第 N 个工作项的开发锚点（`docs/r3-plan.md` §4）；`TODO(test:r3-N)`：该项留给 T 阶段的测试债。
  - `TODO(r4-N)` / `TODO(test:r4-N)`：同上，对应 `docs/r4-plan.md` §3。
  - `TODO(r5-N)`（含 `TODO(r5-0a)` 等复核修复项）：R5 开发锚点，对应 `docs/r5-plan.md` §3；R5 起测试随工作项完成，不再留测试债。
  - `TODO(r6-N)`：R6 开发锚点，对应 `docs/r6-plan.md` §3；测试随工作项完成。
  - `TODO(sample)`：必须用 `tests/fixtures/` 中登记的样本验证之后才能改的数据，例如 `verified: true` 和支持的版本范围。
- 完成一个 TODO 时：删掉对应的 `notImplemented` 调用，补上单测，跑 `typecheck` 和 `test`，再删除该 TODO 注释。R3 期间单测改为留 `TODO(test:r3-N)` 后在 T 阶段集中补（Aesc 2026-11-03），typecheck 与现有全量测试仍须保持通过。查看剩余工作：`grep -rn "TODO(phase1)" src`。

## 5. 产品硬约束（违反即视为缺陷）

以下规则来自方案，实现时最容易被“为了跑通”而破坏：

1. **不伪造结果。**不用生成的 HTML 冒充项目页面；不把业务组件替换成空壳来制造成功；超时后不自动标为 `ready`；没有证据时就写 `unverified` 或 `unknown`。
2. **不静默降级。**不得隐式改变 `scope`、`strategy`、`requirements`。`auto` 不能放宽约束。隔离失败可以给出 `project` 方案作为备选，但不能自动切换过去。
3. **项目代码只在 Runner 子进程中执行。**`probe`、`plan`、`detect`、入口注册重放都只读文件，不执行项目代码；Host 进程内不得调用 `createServer()`、加载 `vue.config.js` 等（方案 §6.5）。
4. **不改目标项目。**不修改业务源码、`package.json`、锁文件、构建配置；不自动安装依赖。临时文件放在插件临时目录并登记资源账本。
5. **网络。**未命中的业务请求必须明确失败（`unmatched_request`），不转发真实后端，不静默返回空对象。不能用“放行所有同源请求”来实现隔离。Mock 覆盖面按通道如实报告（`NetworkCoverage`）。
6. **所有权。**`stop` 只释放调用者拥有的资源（例外：`open` 可按账本完整清理并接管同工作区另一 DSH 会话的预览，带 `preview_taken_over` 诊断，方案 §0.3 第 9 条）；`attach` 只脱离，不停止用户服务，也不清理用户的 Cookie、Storage 或缓存。终止进程时按账本里的 PID 加启动时间核对，不按进程名或命令行模糊匹配。有残留时状态为 `cleanup_failed`，不是 `stopped`。已记录失败的会话清理完成（含迟到重试和显式 stop）后终态仍为 `failed`，不改写为 `stopped`——清理成功只证明资源已释放。
7. **能力声明与允许执行分开（v1.4）。**适配器的声明只是候选能力。`supported` 必须同时有实现和样本证据；UI 组件库 profile 的 `verified: true` 必须对应 `tests/fixtures/README.md` 中状态为“通过”的样本。**但"未验证"不等于"不能运行"：**未验证的版本、平台或组合照常执行，能力保持 `unknown`，并附带 `unverified_toolchain` 诊断。执行代码中禁止写死版本字面量来做门禁。只有 `unsupported`、明确不满足的硬性 `requirements`、未批准的执行项或无效配置，才阻断执行（方案 §0.3 第 1 条）。
8. **UI 组件库中立。**`core/`、`adapters/types.ts`、`adapters/vue/{vite,cli}/` 中不得出现针对某个组件库的代码分支，例如 `if (pkg === 'element-ui')`。组件库差异只写在 `adapters/vue/ui-kits/*.ts` 的 profile 数据中，并通过通用机制（按需引入原样保留、入口注册重放、setup）生效。
9. **执行授权。**配置中的 `command`、`env`、`setup`、`handlers` 以及应用根下的构建配置（`vite.config.*`、`vue.config.*`，会作为 Node 代码加载）指纹变化后，返回 `config_changed_needs_approval`；批准只能来自用户，Agent 不能自己写入批准记录。官方 `allowed-once` 按会话级授权使用（方案 §0.3 第 8 条，2026-11-03）：只在同一 DSH 会话、同一执行指纹内有效，只存 Host 内存、不落盘、不跨会话；执行项变化、换会话或重启必须重新询问；审批策略为 `never` 且沙箱不是完全访问时如实提示，不得绕过；会话沙箱为 `danger-full-access`（Full access / Auto）时按用户的权限选择放行并带 `approved_by_permission_preset` 诊断（§0.3 第 9 条）。
10. **凭据与诊断（v1.4）。**不复制浏览器登录状态；不把 `.env` 内容或凭据放进诊断、日志或工具输出。回传通道的 nonce 不得明文出现在日志和模型可见的输出中。**同时，Agent 修复代码需要的信息必须转发**：编译错误（message、文件、行列、code frame）、运行时错误（message、源码映射后的堆栈）、被拦截请求（method、origin、path）。不得用"raw project values are excluded"之类的理由整体丢弃。具体规则以方案 §13 第 8 条为准，每一类"必须去除"的内容都要有单测。
11. **资源回收（v1.4）。**账本对账必须回收能核对归属的资源（自己登记的临时路径；PID 加启动时间一致的进程组），并提供用户恢复入口。只有确实无法核对时才保留残留。任何情况下都不能让工作区因为历史残留而永久不可用（方案 §9.2 补充条款）。
12. **hint 必须可执行。**诊断里的 hint 必须是 Agent 能直接执行的下一步（调用某个工具、修改某项配置、修改某个文件），不能写成 "Inspect the local browser" 这类 Agent 做不到的动作。

## 6. 代码约定

### 6.1 TypeScript（`src/**/*.ts`）

- 只使用可擦除语法（`erasableSyntaxOnly`），不用 `enum`、`namespace`、参数属性。枚举一律写成 `as const` 对象加类型，参考 `shared/errors.ts`。
- 相对导入写 `.ts` 后缀，构建时由 `rewriteRelativeImportExtensions` 改写为 `.js`。纯类型导入用 `import type`。
- 风格：2 空格缩进、单引号、不加分号、尾随逗号。跟随周围代码，不引入格式化差异。
- **可读性（v1.4）：**新增或修改的代码单行不超过 120 字符；三元表达式不嵌套超过一层，多分支映射用 `switch` 或查找表；一个函数只承担一件事。修改既有的超长行时，顺手拆开。
- `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 均已开启。不要用 `any` 或 `as unknown as` 绕过类型；确实需要时写注释说明原因。
- 每个文件开头写一段注释，说明职责和对应的方案章节；函数注释只写约束和意图，不复述代码。

### 6.2 浏览器侧代码（`src/browser/**`）

- **必须是普通 JavaScript（ES2018），不能写 TypeScript。**原因：这些文件会被目标项目的构建器编译（Vue 2 + Vue CLI 的 JS 项目可能没有 TS loader），或者直接内联注入页面。
- `bootstrap.js` 是经典脚本加 IIFE，不能使用 `import`；`vue/*.js` 是 ESM，`vue` 从目标项目解析，不打包插件自带的 Vue。
- 预览入口中的业务模块（setup、目标组件）一律动态 `import()`，保证 bootstrap 和 Mock 先就绪（方案 §6.3）。
- tsconfig 不检查这个目录；修改后至少用 `node --check` 检查 bootstrap，用 `node --input-type=module --check < file` 检查 ESM 文件的语法。

### 6.3 模块依赖方向

```text
shared            ← 所有模块；自身不 import 其他模块
core              → shared；对 adapters/types、runner 只用 `import type`
runner 基础设施   → shared（ledger、process-tree、port-ownership、response-layer）；不得 import adapters
adapters          → shared、core（类型）、scenario、runner 基础设施
runner 编排       → adapters、runner 基础设施（main.ts、session.ts）
host              → shared、core、adapters/registry（仅用于 probe/discover/plan/impact）；通过 shared/ipc.ts 与 Runner 通信
browser/          → 不 import src 中的任何 TS
```

规则的出发点是行为，而不只是 import 关系：**Host 进程只能调用适配器的 `probe`、`discover`、`plan`、`impact`（只读），不得调用 `start`**；所有模块在被 import 时都不能有副作用（不能启动进程、监听端口或读写文件）。

### 6.4 错误与诊断

- 诊断码登记在 `shared/errors.ts` 的 `DiagnosticCode` 中，不要在调用处临时拼字符串。新增诊断码时，同时更新方案 §4.2 的错误码列表。
- 工具结果用 `ResultStatus`，会话状态用 `SessionState`，两者不得混用（方案 §4.2）。
- 不吞异常：fallback 只有在属于方案声明的降级路径时才允许，并且必须产生可见的诊断。

## 7. 契约变更的同步规则

修改以下任一项时，必须在同一次变更中同步其余各项：

| 变更对象 | 需要同步 |
| --- | --- |
| `shared/contracts.ts` 的字段或枚举 | 方案 §4.2、§6.2、§9.2 中的对应描述 |
| `shared/config/schema.ts` | `schema/page-preview.config.schema.json` 与方案 §8 |
| 工具参数（`host/tools/*.ts`） | 方案 §4.2 的工具表 |
| UI 组件库 profile 的支持层级 | 方案 §6.9 的表格与 `tests/fixtures/README.md` |
| DSH 版本或 API 用法 | 方案 §4.1 的核对表（注明是文档、类型定义还是实测得出的结论） |

## 8. 验证与交付

- 声称“完成”或“可用”之前，`npm run typecheck` 和 `npm test` 必须通过，并附上实际输出。涉及运行时行为（进程、端口、iframe、CSP、HMR）的改动，需要在真实样本或 DSH 中跑过，并写明平台和版本。
- 测试覆盖失败路径，不只验证 happy path，参见方案 §15.2 和 §15.3。新增判定用例时补到 §15.3 的表格。
- 每次交付说明：现象或目标、根因或设计、改动点、已验证项、未验证项、剩余风险；改变既有接口时，说明兼容性和迁移方式。
- 区分已验证的事实、合理推断和未知。DSH 的行为以锁定版本的类型定义和实测为准，不要凭记忆假设。

## 9. 需要先问用户的事

- 提交、推送、发布 npm 包、对外上传任何内容。
- 新增运行时依赖（需要说明理由；优先使用 Node 内置能力），或升级 DSH 依赖版本。已批准、无需再问的：`docs/toolchains/` 下三份测试工具链清单，安装到 `tests/toolchains/<组合>/`（2026-11-01）。清单以外的新工具链（例如自包含的 Vue 3、非精确版本的 Vue 3 + Vite 样本）仍需申请。
- 改变方案中的产品边界，例如放宽硬约束、修改首版范围或支持矩阵。
- Phase 0 某个判定项不通过时采用哪种降级方式。

## 10. DSH 事实速查（依赖已升至 `0.2.2-rc.1`，以下内容核对于 `0.2.1-rc.5`；来源为类型定义或文档，尚未实测）

- 插件导出 `name`、`inject = ['tools']`、`apply(ctx)`；用 `ctx.tools.register(defineTool({...}))` 注册工具；`ctx.effect(() => dispose)` 用于清理。
- `defineTool` 的参数 DSL 为 `{ type, required: true, description, enum, items, properties, additionalProperties }`；`execute(args, exec)` 中的 `exec.signal` 是取消信号；可声明协作式超时 `timeoutMs`。
- `output.render` 返回 `ContentBlock[]`。`image` 块类型存在，但 dsh-llm 注释写明当前生产适配器只有 user content 携带图片。截图能否交给模型，要以 Phase 0 实测为准。
- 事件：`ctx.on('session/event', (session, event) => …)`，`event` 的结构为 `{ type, seq, time, data }`，其中包括 `turn/start { turn }` 与 `turn/end { turn, reason }`；`ctx.on('tools/result', (exec, result) => …)`，`exec.arguments` 是 `unknown`。
- 打包：`package.json` 中的 `dsh.bundle.patch`、`engines.dsh`；`cordis.patch.yml` 中的行通过包名引用插件。独立探针已验证 `dsh.client` 的 `platform`、`inject`、`./client` export 和 ModuleLoader factory；产品 Client 尚未接入。
