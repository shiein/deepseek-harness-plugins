# R5 复核修复报告（F1–F10，tag `r5-fix1`）

范围：`1c30ce4..r5-fix1`（Claude 对 R5 CP4 `957ee31..1c30ce4` 复核发现的 10 项）。
环境：macOS arm64，Node 24.13.1。每项一个本地 commit，提交信息含问题→根因→修复→已验证→未验证。

## F1 fixture 草稿禁止合成值顶替占位标记（`5b7ec7c`）

- **问题**：`fixture-sources.ts` 在只有 TS 类型或 OpenAPI schema 时用 `sampleObject`/`sampleSchema`
  生成 `"example"`、`0`、`false` 等示例值替换 `FIXTURE_PLACEHOLDER`，绕过 `containsPlaceholder`
  保护——编出来的数据可被当作 Mock 写回配置（违反 AGENTS.md §5 第 1 条、方案 §7.2）。
- **根因**：草稿来源分层把"类型/schema 推断"与"真实数据"放在同一替换通道。
- **修复**：真实可替换来源只剩两类——项目 mock 目录 JSON 原文、OpenAPI 显式 `example`/`examples`；
  schema 取样降级为 `shapeHint`/`shapeHints`（注明来源与"值为示例"），响应体保持占位；
  删除 `typeNameCandidates`/类型扫描层（按 URL 猜 TS 类型名）。方案 §7.2 R5-1b 描述同步。
- **改动文件**：`src/scenario/fixture-sources.ts`、`src/scenario/fixture-draft.ts`、
  `src/shared/fixture-draft.ts`、`src/host/session-registry.ts`（注释）、方案文档、相关测试。
- **已验证**：schema 取样不替换占位、带 shapeHint 的草稿写回被拒、mock JSON 与显式 example
  正常替换——`fixture-draft` 相关单测通过；`npm run typecheck` 0 错误。
- **未验证**：真实业务 OpenAPI 文档的 example 覆盖率（合成 fixture 已覆盖机制路径）。
- **剩余风险**：shapeHint 字段为新增对外契约，按 AGENTS.md §7 已同步方案文档。

## F2 测试失败后挂死（`21325ac`）

- **问题**：`vue-cli-runtime.test.ts` 的 webpack-dev-server v3 用例在全量并发下偶发 150s 超时，
  超时后该文件进程连同无头 Chrome 不退出，`npm test` 永久挂起不报失败（2026-11-04 macOS
  arm64 复现：477 项后挂住 ~1.5h）；单独运行 4s 即过。
- **根因**：①`launchChrome` 只经 try/finally 关闭，测试超时杀死用例时 Chrome 泄漏；
  ②helper 内 CDP 调用无超时；③`node --test` 无全局 `--test-timeout`；④9 路文件并发时
  多个真实编译链+Chrome 争 CPU，用例内固定等待窗口超时。
- **修复**：`headless-chrome.ts` 内 `launchChrome` 接受 test context 自注册 `t.after`、
  全部 CDP 调用包超时；37 个调用点更新。`package.json` `npm test` 改为 `node scripts/test.mjs`：
  全部文件 `--test-timeout 300000`；12 个重量级文件（真实工具链/Chrome）单独
  `--test-concurrency 2` 压尾，其余默认并发先跑。
- **已验证**：注入 30s sleep 的用例 3s 报失败、进程干净退出；连续全量回归见文末。
- **未验证**：CLI4 用例并发下变慢的精确分量（编译/端口/CPU 的占比未逐一测量）；
  并发限制是按证据的工程化措施而非根因精确切分。
- **剩余风险**：极端慢机器上个别编译链用例仍可能接近 300s 上限。

## F3 配置写回 TOCTOU（`9780cac`）

- **问题**：`config-write.ts` 在审批前算好合并内容，`commitScenarioWrite` 直接写入；
  审批窗口内文件被改则改动被覆盖。
- **根因**：plan 与 commit 之间无原文件完整性核对。
- **修复**：`ScenarioWritePlan` 记录所依据的原文件 SHA-256（新文件记"不存在"）；
  commit 前重读比对，不一致返回 `stale` 什么也不写，诊断提示重新调用生成新 plan。
- **已验证**：plan 后改文件/新建已有文件两条路径均拒绝且零写入——`config-write`
  相关测试通过（新增 2 例），全量 600/600。
- **未验证**：多并发写回进程下的真实竞态（单进程内串行接口，机制级测试已覆盖窗口）。
- **剩余风险**：无已知。

## F4 备份文件移入插件 dataDir（`95d33ba`）

- **问题**：`page-preview.config.json.bak-<ts>` 写在工作区根目录，不断累积污染项目。
- **根因**：备份路径锚在项目目录而非插件数据目录。
- **修复**：备份改为 `<dataDir>/config-backups/<workspace-hash>/`，每工作区隔离、
  保留最近 10 份；`dataDir` 缺失时如实拒绝写回（与 approval 的 dataDir 要求一致），
  不回退写项目目录；写回结果返回备份路径。方案 §7.2 与 `docs/guide.md` 同步。
- **已验证**：备份位置、10 份保留、工作区隔离、无 dataDir 拒绝——相关测试通过。
- **未验证**：真实插件 dataDir 下的长期使用（测试用临时 dataDir 同路径机制）。
- **剩余风险**：无已知。

## F5 面板一键打开合成执行上下文（`cdb2081`）

- **问题**：`session-registry.ts` `panelOpen` 用 `as unknown as ToolRunContext` 合成 exec，
  signal 为 `AbortSignal.timeout(60000)`——审批等待超 60 秒被中断。
- **根因**：面板路径绕过了 openAttempt 的官方审批调用，伪造了执行上下文。
- **修复**：核对锁定版 `dsh-user-approval@0.2.1-rc.5`：`ApprovalService.request` 读取
  `exec.agent`（session/scope 依据），改为真实 agent 作用域；取消信号改为
  `setTimeout + AbortController` 实现的可测上限（默认 10 分钟）并与面板取消合并，
  取消信号不进入 wire args；新增 `panelOpenBoundMs` 注入便于测试。协议文档同步。
- **已验证**：审批等待 >60s（假时钟 4s×可注入上限）不中断、取消与超时两条路径——
  `project-command.test.mjs` 39/39 通过；全量 512/512 + 91/91。
- **未验证**：真实 DSH 面板 UI 中点击打开→审批弹窗全流程（`docs/r5-blockers.md` §1
  R5-6 项已登记，属 Aesc 实机清单）。
- **剩余风险**：官方 `allowed-once` 仅同会话同指纹有效，重启/换会话需重新询问（设计如此）。

## F6 vite-plugin-mock 覆盖面虚报（`d7e760c`）

- **问题**：`project-mock.ts` 只复制 mockPath 目录；mock 文件 import 目录外模块时插件
  静默加载为空表，但计划仍声明 `browser-http` 覆盖为 `mock/project`。
- **根因**：锁定版 `vite-plugin-mock@3.0.2` 的 `mockData` 为模块级私有变量无路由表可读；
  `bundleRequire` 失败整体返回空数组但中间件照常注册——无法运行时区分。
- **修复**：复制前 `projectMockEscapes(appRoot, mockPath)` 静态扫描插件实际枚举的
  `.ts/.mjs/.js` 文件：静态 import/export-from、字面量 dynamic import/require；
  type-only 忽略、非字面量不猜；相对导入越出 mock 根即记录。越界时 `loadProjectMock`
  返回 undefined，preflight 不声明 project 覆盖，追加非阻断 `project_mock_unavailable`
  诊断（hint：把共享模块移回 mock 目录或改写为 scenario handlers）。
- **已验证**：越界/清洁/type-only/裸导入/动态参数/确定性排序——`project-mocks.test.ts`、
  `vue-preflight.test.ts` 通过；全量 514/514 + 91/91。
- **未验证**：`vite-plugin-mock` 其它版本的行为差异（锁定 3.0.2 已实测源码核对）。
- **剩余风险**：非字面量动态导入按设计不静态猜测，运行时仍可能空表但无虚报覆盖。

## F7 诊断互相矛盾（`cb5127d`）

- **问题**：同一结果中 `page_text_pending` 的 hint 是 "Call page_preview_status ..."，
  `preview_shown_in_sidebar` 的 hint 是 "do not ... poll status"——互相矛盾。
- **修复**：`page_text_pending` 改条件化表述 "Only if you need to verify page content,
  call page_preview_status once with this previewId"；`preview_shown_in_sidebar`
  措辞对齐。按有意语义调整相应断言。
- **已验证**：`response-layer` 相关断言通过；全量 515/515 + 91/91。
- **未验证**：无。
- **剩余风险**：无。

## F8 WS 超大帧（`ae55e3e`）

- **问题**：`ws-fixture.ts` `decodeFrame` 遇 >1 MiB 帧静默吞掉，连接悬挂无诊断。
- **修复**：按 RFC 6455 以 close code `1009` 关闭连接；新增 `protocol_violation`
  诊断码经 `http-diagnostic` 上报（接入三个 worker 协议枚举与 `worker-host` 文案）。
  不扩展 ws-fixture 功能范围。
- **已验证**：裸 TCP 发送"声明 >1 MiB 的掩码帧头"触发 1009 关闭与诊断——
  `response-layer.test.ts` 7/7、ws 相关测试通过；全量 515/515 + 91/91。
- **未验证**：业务真实超大 WS 载荷场景（机制已覆盖：帧头到达即关闭，无需完整载荷）。
- **剩余风险**：无已知。

## F9 React/Vue 适配器重复代码抽取（`1fae9b8`）

- **问题**：`react/vite/worker.ts` 与 vue 版 77% 行重复，module-graph 82%、
  setup-styles 79%、preflight 60%、readonly-config 52%（difflib LCS 匹配行口径）。
- **根因**：R5-7 引入 react-vite 时逐文件复制，框架无关机制与框架差异混在同一文件。
- **修复**（行为不变，差异全部经参数/钩子注入；core、adapters/types.ts 无框架分支）：
  - `adapters/shared/readonly-config.ts`：`readBuildConfig(appRoot,{names,flavorOf})`
    参数化 Vite/CLI 宿主；两侧薄包装各绑 names/flavor。
  - `adapters/shared/module-graph.ts`：`ModuleGraphHooks`（scriptExt/resolveExts/
    expandFile/readConfig/scriptGap）；Vue 以 expandFile 展开 .vue SFC，React 无钩子。
  - `adapters/shared/setup-styles.ts`：`SetupStylesHooks`（parseEntry/resolveSpecifier/
    scriptModule）。
  - `adapters/vite/worker-protocol.ts`：完全一致的 zod schema；adapter id 参数化。
  - `adapters/vite/worker-core.ts`：`runViteWorker(hooks)`——工具链核对、默认编译插件、
    虚拟模块裸说明符规则（vue 只锚 'vue'、react 锚全部裸说明符）、optimizeDeps.include、
    `/@react-refresh` 准入全部为钩子。
  - `sources.ts`/`preflight.ts` 保持框架侧（route-root/setup 生成与逐字段计划组装为真实差异）。
- **已验证**：typecheck 0；check-line-length 通过；vue-vite-protocol/websocket/runtime、
  react-vite-runtime、vue-impact/static-impact、entry-replay、preflight、route-viewport
  等全部相关测试通过；全量 `npm test` 515/515 + 91/91（含真实工具链 worker E2E）。
- **重复比例（重构前→后，Python difflib `SequenceMatcher` 匹配行数 ÷ max(两侧行数)）**：
  worker 77.0%→32.3%、module-graph 82.3%→48.3%、setup-styles 78.7%→76.5%（两侧同形薄包装）、
  readonly-config 51.6%→43.8%、preflight 60.2%→57.4%（未抽取：差异交织在逐字段
  计划组装中，强制抽取需逐分支回调、回归风险高于收益）；protocol 新增对 73.3%（薄包装）。
  六对总计 ~56.7% 匹配行，剩余主要为两文件的职责注释与参数化调用形态。
- **未验证**：抽取未触及 `cli/worker.ts`（CLI worker 本就独立）。
- **剩余风险**：worker-core 单文件 546 行集中度高，后续框架差异新增钩子需保持克制。

## F10 vue26-cli route 目标与 layout:true 测试（本提交）

- **问题**：R5-4 注明"CLI 侧 layout/route-root 走同一共享实现未单测"——只有 Vite 侧证据。
- **修复**：新增 `tests/unit/vue-cli-route.test.ts`（vue26-cli + vue-router 3.6.5）：
  plan 级 route 目标解析与 layout 传递；无匹配（`unsupported_capability`）、
  歧义（`ambiguous_target`）、非具体（`config_invalid`）失败路径；
  真实 webpack 编译 + headless Chrome 的 `layout:true` 父链渲染与项目内导航留内。
  登记进 `scripts/test.mjs` 重量级名单。
- **已验证**：3/3 通过（plan 级 ~70ms/30ms；E2E ~2.9s 真实浏览器证据：
  ORDER-SHELL-MARKER 父链、id=42→43 导航、`{residual:[]}` 干净回收）。
- **未验证**：CLI 侧无匹配/歧义的运行时等价形态（plan 层失败路径已是诚实拒绝面）。
- **剩余风险**：vue-router 3 仅 vue26-cli 覆盖；vue27-cli 路由形态未单测（同一共享实现）。

## 收尾验证

- `npm run typecheck`：0 错误（每提交前执行）。
- `node scripts/check-line-length.mjs`：通过（每提交前执行）。
- 连续 3 次全量 `npm test`（`node scripts/test.mjs`，两段执行：常规文件默认并发 +
  重量级 `--test-concurrency 2`，全部 `--test-timeout 300000`）：
  | 轮次 | 常规 | 重量级 | 结果 |
  | --- | --- | --- | --- |
  | 1 | 515/515，17.4s | 94/94，128.9s | 全绿 |
  | 2 | 515/515，17.4s | 94/94，129.2s | 全绿 |
  | 3 | 515/515，17.4s | 94/94，129.7s | 全绿 |
  重量级 94 项含新增 `vue-cli-route.test.ts` 3 例；无跳过、无失败。
- `npm run build`：`tsc -p tsconfig.build.json && copy-browser && build-client`
  通过，输出「Client bundle and wire descriptors built; client requires: ["zod","react"]」。
- `node scripts/pack-check.mjs`：全项 ok——build artifacts、8 项 required entries、
  schema dir、excluded paths、`dsh.bundle.patch`、engines.dsh 覆盖锁定 0.2.1-rc.5、
  peerDependencies 全锁、client bundle 纯 JS；**554 文件 / 2382.2 KiB**。
- Docker 验证：本轮未执行（无新增运行时依赖、无平台相关变更，无必要）；
  宿主机 `node_modules` 未受任何容器操作影响。
- 未 push、未发布、未新增运行时依赖、未升级 DSH、未访问任何 DSH profile/桌面应用/业务项目。
