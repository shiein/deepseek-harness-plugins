你接手 dsh-page-preview 仓库（DeepSeek Harness 插件：用项目的原代码、原编译器和场景数据预览真实业务页面）的第六轮工作（R6）。
本轮目标：项目里没有任何 Mock、OpenAPI 或响应类型时，让 Agent 用**一轮**工具调用就能补齐页面数据，且不伪造、不连真实后端。

## 先读（按顺序，读完再动手）

1. `AGENTS.md`：全部内容，尤其 §5 产品硬约束（第 1、5、10、12 条与本轮直接相关）、§6 代码约定、§7 契约同步、§9 需要先问的事
2. `docs/r6-plan.md`：本轮计划（§1 决策、§2 规则、§3 工作项 R6-0～R6-4、§5 不做的事）
3. 方案 `dsh-page-preview-development-plan.md` §7.2（Mock 来源与缺失处理）、§4.2（工具契约）、§8（配置协议）
4. 骨架与锚点：`grep -rn "TODO(r6-" src tests docs`。新模块 `src/scenario/envelope.ts`、`src/scenario/call-site-context.ts`、
   `tests/helpers/real-traits-fixture.ts` 的文件头写了约束，实现时必须满足
5. 与本轮相关的现有代码：`src/scenario/fixture-draft.ts`、`src/scenario/fixture-sources.ts`（注意文件头 R5-fix1 的说明）、
   `src/scenario/mock-middleware.ts`、`src/host/session-registry.ts`（`status` 草稿段与 `writeScenario`）、
   `src/host/tools/write-scenario.ts`、`src/shared/config/schema.ts`、`src/shared/fixture-draft.ts`

## 任务

按 `docs/r6-plan.md` §3 的顺序实现：R6-0 → R6-1 → R6-2 → R6-3 → R6-4，按 §4 打检查点 tag（`r6-cp0`～`r6-cp3`）。
每项完成后删掉对应的 `notImplemented` 和 `TODO(r6-N)`；测试随工作项一起完成，不留测试债。

## 规则

- 每次提交前：`npm run typecheck` 为 0 错误，`node scripts/check-line-length.mjs` 通过。每完成一个工作项跑一次全量 `npm test`，必须全绿。
- 现有测试失败时修代码，不改测试迁就；确属有意的行为变化，在提交信息中逐条说明理由。
- 对外契约**只能新增**：新参数、新字段都是可选的，缺省行为与现在完全一致（`write_scenario` 缺省仍是 create、同名不覆盖）。
  新增 schema 字段、工具参数、输出字段、诊断码时，同一提交内按 AGENTS.md §7 同步：
  `schema/page-preview.config.schema.json`（用 `scripts/generate-config-schema.mjs` 生成）、方案 §4.2、§7.2、§8、`shared/errors.ts`。
- 端到端证据用 `tests/toolchains/vue3-self-contained` + headless Chrome（`tests/helpers/headless-chrome.ts`）。
  只有 HTTP 层证据不算浏览器端证据；headless Chrome 证据不等于 DSH 载体证据，两者分开写。
- 浏览器侧 `src/browser/**` 只能写 ES2018 普通 JavaScript，改完用 `node --check` 检查。新增和修改的代码行不超过 120 字符。
- 每个工作项至少一个本地 commit。**禁止 push 或发布**，禁止新增运行时依赖，禁止升级 DSH，禁止在任何 DSH profile 中安装。
- 进度：每个检查点在 `docs/development-progress.md` §2.0 加一行（提交范围、tag、全量回归数字）；CP3 时更新 AGENTS.md §2 的要点。

## 本轮最容易踩的线（违反即缺陷）

- **不合成数据**：typeHint、shapeHint、envelopeHint、调用点上下文只进 `fixtureDraft`，永远不进响应体。
  不得为未命中请求生成任何成功响应、空对象或空数组。"合成数据模式"（plan R6-5）本轮不做。
- **不按名字猜**：R5-fix1 删除了"按 URL 猜 TS 类型名"，不得恢复。`typeHint` 只来自调用点显式写出的泛型实参或返回值注解。
- **不执行项目代码**：调用点收集与包装线索识别都在 Host 侧只读完成（AST/checker），不 import、不求值项目模块；不读 `.env*`、不进 `node_modules`。
- **有界且可见**：文件数、字节、时间、条数都有上限；触顶时 `limited: true` 并产生可见诊断，不静默截断。
- **转发与脱敏并存**：代码片段是 Agent 补数据需要的信息，必须转发；但要经共享脱敏（疑似凭据字面量），每类去除内容都要有单测。
- **merge 不覆盖**：与已有 fixture 冲突时整体拒绝并列出冲突键；审批、dataDir 备份、TOCTOU 哈希比对流程原样保留。
- **hint 可执行**：新诊断的 hint 必须是 Agent 能直接做的下一步（调用哪个工具、改哪项配置）。

## 证据要求

- 声称"已核实 / 已验证 / 来自某版本"的地方，写明具体依据（文件路径与行号、命令及其输出摘要、测试用例名）；做不到就写"未核实"。
- 每个工作项的端到端用例，先在不含该项实现的代码上确认它会失败，再确认实现后通过，并在提交信息里写明。

## 环境说明

- 你的环境里没有 Aesc 的 DSH 桌面应用，也没有 `overview/web` 或任何业务项目，不要尝试访问。
- 可用样本：`tests/toolchains/`（`pretest` 幂等安装）、`tests/fixtures/`，以及你在 R6-0 建的真实特征样本。
- 需要真实 DSH 或真实业务项目的验证，只整理进 `docs/r6-plan.md` §6 的实机清单，不要声称已验证。

## 遇到以下情况停下来，写清楚问题后等待 Aesc

- 想做 `docs/r6-plan.md` §5 中的任何事（尤其合成数据、HAR、代理录制、按名字猜类型）
- 实现某项必须改变已有参数、字段或诊断码的语义
- 方案、AGENTS.md、计划文档之间有冲突
- 现有测试因你的改动失败，且它断言的是产品约束
- 调用点收集在样本上的耗时超过预算的一半，需要调整默认预算

## 每个工作项完成时的汇报格式（中文）

目标 → 设计 → 改动文件 → 已验证（命令与输出摘要）→ 未验证 → 剩余风险。
区分已验证的事实、推断和未知。
