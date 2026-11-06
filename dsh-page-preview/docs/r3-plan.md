# R3 开发计划：业务数据闭环 + 影响分析与触发 + 发布准备

- 编写：2026-11-03（Claude，Aesc 要求）；执行：Devin
- 依据：方案 `dsh-page-preview-development-plan.md` §0.3、§5.2～5.3、§7.2～7.4、§9.1、§10、§14 Phase 2～4、§16 第 7～12 项；
  `docs/development-progress.md`；`docs/review-2026-11-01.md` P2-3
- 骨架已建（本文 §4 每项列出文件）；`grep -rn "TODO(r3-" src scripts docs` 查看全部待办锚点

## 0. 一句话目标

R2 之后，插件能把真实 Vue 页面显示出来，但存在两个缺口：

1. 真实页面拿不到业务数据，fixture 只能手写。
2. 插件不知道"这次改动影响了哪个页面"，Agent 只能自己猜目标。

R3 补这两个缺口，并做发布前的非测试准备。**新测试集中放在最后的 T 阶段**（Aesc 2026-11-03 决定）。

## 1. Aesc 默认决策（未确认；Devin 不得自行改变，只能按此实现，遇到冲突停下来问）

| ID | 问题 | 本轮默认 | 影响范围 |
| --- | --- | --- | --- |
| D1 | 业务数据从哪来 | 根据未命中请求生成 fixture **草稿**。草稿只有请求匹配部分，响应体是占位标记，由 Agent 按项目接口类型填写并写明 `provenance`。项目已有 Mock **只识别和报告，不执行** | R3-1、R3-3 |
| D2 | 自动触发的默认模式 | `smart`：已有预览的只通知刷新；没有预览的只推荐，**不自动启动进程**。`always` 只实现决策，执行时返回 unsupported | R3-5、R3-6 |
| D3 | 第二个真实业务样本 | 暂无。真实样本验收放到 T 阶段，由 Aesc 在本机做 | T 阶段 |
| D4 | 截图给模型 | 维持现状（`capture` 返回 unsupported），本轮不做 | — |

## 2. 工作规则（本轮专用，与 AGENTS.md 冲突时以本节为准，因为它来自 Aesc 当前的明确要求）

1. **开发优先，测试后置。**R3-0～R3-7 期间不编写新的单测或 E2E。每项实现完成后，在代码里留一条
   `TODO(test:r3-N)` 注释，写明要补哪些测试（按本文 §5 的清单），由 T 阶段统一补齐。
   - 这一条覆盖 AGENTS.md §4"完成 TODO 时补单测"的要求；其余规则不变。
2. **回归门槛不放松。**每次提交前：`npm run typecheck` 为 0 错误；`node scripts/check-line-length.mjs` 通过。
   每完成一个工作项，跑一次现有全量 `npm test`，必须保持全绿。现有测试失败说明行为被改坏，要修代码，不能改测试来迁就。
   如果某个现有测试断言的正是本轮有意改变的行为（例如 scenario 切换以前返回 unsupported），可以修改，
   但要在提交信息里逐条说明。
   **已知偶发失败**：`tests/unit/vue-vite-public.test.mjs` 中的"invalid handler exports fail startup visibly…"
   偶尔得到 `cleanup_failed`，而预期是 `failed`。2026-11-03 建骨架时又复现一次（3 次全量运行中 1 次），根因未定位。
   - 它单独出现时不算本轮回归，但要在提交信息中注明
   - R3-2 会改动 Vue worker 的 Mock 与 handler 生命周期，正好经过这条路径；如果复现频率上升，或定位到根因，单独提交修复
3. **状态口径。**每项完成后，在 `docs/development-progress.md` 的 R3 表格里标"🟨 代码完成，测试待补"，**不标 ✅**。
   ✅ 只在 T 阶段补完测试并通过后使用（AGENTS.md §8：未验证不得声称完成）。
4. **TODO 标签。**`TODO(r3-N)` 表示本轮第 N 项的开发锚点，完成后删除，并删除对应的 `notImplemented` 调用。
   `TODO(test:r3-N)` 表示测试债，T 阶段删除。原有 `TODO(phase3)` 已全部改写为 `TODO(r3-4)` 或 `TODO(r3-5)`。
5. **提交。**每个工作项至少一个本地提交，消息格式沿用仓库习惯（`feat(impact): ...`）。**禁止 push 或发布**，
   禁止新增运行时依赖，禁止升级 DSH（AGENTS.md §9）。
6. **契约同步**（AGENTS.md §7）：改 `shared/contracts.ts`、`shared/config/schema.ts`、工具参数、IPC 时，
   同一次提交内同步方案对应章节、`schema/page-preview.config.schema.json` 和 `shared/plan-schema.ts`。
7. **产品硬约束**（AGENTS.md §5）全部有效。本轮最容易被违反的几条：
   - fixture 草稿不得伪造业务数据（§5 第 1 条）
   - 影响分析只读，不执行项目代码（第 3 条）
   - 自动触发不能放宽约束，也不能绕过审批（第 2、9 条）
   - 诊断里不出现 query 值、请求体或凭据（第 10 条）
   - core 和适配器契约中不出现组件库分支（第 8 条）
8. **环境。**Devin 的环境里没有 Aesc 的 DSH desktop，也没有 `~/Documents/workspace/overview/web`，所以不要尝试访问它们。
   需要真实 DSH 或 overview/web 的验证一律写进 T 阶段清单，交给 Aesc。可用的样本是 `tests/toolchains/` 下的六套工具链和 `tests/fixtures/`。

## 3. 顺序与依赖

```text
R3-0 结构债 P2-3（小，先做，给后续适配器扩展铺路）
  ├─ R3-1 未命中请求汇总 + fixture 草稿 ──┐
  │    └─ R3-2 场景重新加载/切换 ─────────┤（R3-1 草稿填好后靠 R3-2 免重开生效）
  ├─ R3-3 项目已有 Mock 只读识别          │
  └─ R3-4 影响分析（只读候选）            │
       └─ R3-5 轮次触发（smart）          │
            └─ R3-6 面板展示 ←────────────┘
R3-7 发布准备（文档、打包检查；可与以上任意项穿插）
T   集中测试（最后）
```

建议顺序：R3-0 → R3-1 → R3-2 → R3-3 → R3-4 → R3-5 → R3-6 → R3-7 → T。
R3-1/R3-2 排在影响分析之前，理由是"有数据"直接决定真实页面能不能用；影响分析只是省去 Agent 选目标的一步。

## 4. 工作项

### R3-0 适配器特性声明取代 ID 分支（P2-3）

- **现状**：`src/runner/controller.ts` 按 `adapter.id` 写死 `vue`/`static` 分支，决定是否接受 scenario、断言和 isolated-target。
- **做法**：`src/adapters/types.ts` 已加 `AdapterFeatures` 和可选的 `features`。五个适配器都补上声明后，把字段改为必填，
  controller 改为读取 `adapter.features`，删除 ID 分支。
- **行为不变**：每个适配器声明的值必须与现在分支的效果完全一致（static：scenarios、targetAssertions 为 true，
  isolatedTarget 为 false；vue-*：全部为 true；其余全部为 false）。
- **文件**：`src/adapters/types.ts`、`src/runner/controller.ts`、五个 `src/adapters/*/index.ts`。
- **测试债**：每个适配器的特性与旧分支逐一对照，确认拒绝路径不变。

### R3-1 未命中请求汇总与 fixture 草稿（Phase 2；D1）

- **目标**：Agent 调用 `page_preview_status { previewId, detail: true }` 时，能拿到"这个页面请求了哪些没被 Mock 的接口"，
  以及一段可以直接粘贴的 fixtures 配置骨架。
- **数据流**：worker 的 `onUnmatched`（vite/cli 两个 worker 已带 method/url，origin 需补上）→ adapter emit 诊断
  → `RunnerSession` 持有的 `UnmatchedRequestLog` 汇总 → `RunnerSnapshot.unmatched` → Host `status` 投影
  → `draftFixtures()` 生成草稿。
- **文件（骨架已建）**：
  - `src/runner/unmatched-log.ts`：汇总键、上限、只保留 query 键名
  - `src/scenario/fixture-draft.ts`：草稿生成、`FIXTURE_PLACEHOLDER`、`containsPlaceholder`
  - 锚点：`shared/ipc.ts`、`shared/contracts.ts`（StatusResult）、`runner/session.ts`、`host/session-registry.ts`（status）、
    `shared/config/schema.ts`（HttpFixture）、两个 worker 的 mock 创建处
- **配置 schema**：
  - 新增 `HttpFixture.provenance?: string`
  - `validateConfig` 拒绝仍含占位标记的响应体，返回 `config_invalid`，路径指到对应 fixture
  - 同步 JSON Schema 和方案 §8
- **类型位置**：`UnmatchedSnapshot` 等类型被 IPC 使用，要移到 `shared/`。shared 不能 import runner（AGENTS.md §6.3）。
- **输出预算**：默认 status 输出不带草稿，只在 `detail: true` 时附带。默认输出最多加一行"N 个未命中请求，detail 可取草稿"。
- **脱敏**：不记录 query 值、请求体、headers；path 本身按现有 `redact` 规则处理（路径里可能带 token）。
- **方案同步**：§4.2 status 行、§7.2 增加"草稿与占位标记"一段。
- **测试债**：汇总去重与上限；query 值不进入输出；草稿排序与截断；占位标记被 validateConfig 拒绝；
  跨源请求带 origin；detail 与非 detail 的输出差异。

### R3-2 场景重新加载与切换（Phase 2；§7.4）

- **目标**：
  1. Agent 按草稿改完 fixture 后，调用 `page_preview_refresh { previewId }`，预览就用新数据，不需要重开。
  2. `page_preview_refresh { previewId, scenario: "readonly" }` 可以切换角色场景。
- **语义**：默认"重建本预览拥有的上下文"，即替换 Mock 中间件和 ScenarioStore、更新入口里的场景数据，然后整页重载。
  不原地修改 Store，也不清理用户的 Cookie/Storage。
- **执行项不变**：handlers、setup、command、env 有任何变化，都返回 `config_changed_needs_approval`，要求重新 open。
  refresh 不承担审批。
- **文件（骨架已建）**：
  - `src/runner/scenario-reload.ts`：`prepareScenarioUpdate`
  - `src/adapters/vue/scenario-swap.ts`：两个 worker 共用的可替换场景
  - 锚点：`runner/controller.ts`（switch-scenario）、`runner/session.ts`、`adapters/types.ts`（switchScenario 签名）、
    `shared/ipc.ts`（refresh 加 scenario）、`host/tools/refresh.ts`、两个 worker、各自的 `protocol.ts`（新增 worker 消息）
- **Vite 与 CLI 的差异**：Vite 侧让虚拟模块失效后重载；CLI 侧重写本预览临时目录里的文件后重载。
  两条路径都要接上，不能只做一边。
- **static 适配器**：可选。不做时 static 的 `switchScenario` 保持缺失，由核心统一报 unsupported。
- **能力声明**：做完后 `scenarioReset` 只能写 `unknown`，并说明原因"已实现，样本未验证"。T 阶段验证后才能改为 supported。
- **方案同步**：§4.2 refresh 行、§7.4 增加实现说明、§11 的 switchScenario 签名。
- **测试债**：同场景重载后新 fixture 生效；切换场景后 setup 收到新的 identity/permissions；handlers 变化被拒绝；
  未知场景名；切换期间 stop；切换后 unmatched 清空；freshness 回到 unverified。

### R3-3 项目已有 Mock 的只读识别（Phase 2；D1）

- **目标**：计划阶段告诉 Agent"这个项目自带 mockjs/vite-plugin-mock/MSW，数据可以参考 X"，避免 Agent 从零编造数据。
- **范围**：只读 `package.json` 和文件是否存在，结果进入 `knownDifferences`，并附一条信息性诊断，
  hint 写成可执行动作（参考 `mock/` 目录填写 fixture，或改写为场景 handlers 模块）。**不 import、不执行、不读 `.env*`**。
- **文件（骨架已建）**：`src/core/profile/project-mocks.ts`。在 `adapters/vue/preflight.ts` 和 `adapters/static/preflight.ts`
  的 plan 中调用（只读阶段）。
- **诊断码**：如需新增（例如 `project_mock_detected`），登记到 `shared/errors.ts` 并同步方案 §4.2。
- **测试债**：每种识别依据的正例和反例；不读取 `.env`；证据只用相对路径。

### R3-4 影响分析：只读候选（Phase 3 第一步；§5.2、§5.3）

- **目标**：插件能回答"本轮改动影响了哪些可预览目标"，并把答案用在三处：
  1. `page_preview_open` 不带 target 时，优先返回本轮候选（仍然只返回候选，不自动选）
  2. `page_preview_status` 不带 previewId 时附 `suggestions`
  3. 轮次结束时交给 R3-5
- **前提已验证**：`turn/start`、`turn/end` 能触发；写工具的 `arguments.file_path` 和 `meta.path` 能拿到
  （`docs/phase0-verification.md:44`）。**写工具名白名单必须对照锁定版本核实**，不能凭记忆。
- **文件（骨架已建）**：
  - `src/core/change/baseline.ts`：元数据基线与 diff，对选定文件预先计算哈希（设计说明见文件头）
  - `src/core/change/ignore.ts`：.gitignore 常见子集
  - `src/core/change/agent-writes.ts`：写工具路径提取
  - `src/core/impact/types.ts`、`analyzer.ts`、`rank.ts`：编排与排序（core 不 import adapters/registry，适配器调用由 Host 注入）
  - `src/adapters/vue/impact/{module-graph,route-map,index}.ts`：Vue 依赖图与路由表
  - `src/adapters/static/impact.ts`：HTML 引用
  - `src/host/impact-service.ts`：每个会话的轮次状态与按需分析
  - 锚点：`host/turn-tracker.ts`、`host/plugin.ts`、`host/session-registry.ts`（open 不带 target 的分支、status）、
    `adapters/types.ts`（`impact?`）
- **解析器**：只用已有的 `typescript`（`shared/javascript.ts`）和 `parse5`（`shared/vue-sfc.ts`），不新增依赖。
  别名复用 `adapters/vue/readonly-config.ts`。
- **证据规则**（Candidate.evidence）：
  - strong：改动即目标，或经唯一 import 链到达路由页
  - medium：共享模块到达多个页面中的一个
  - weak：仅凭目录或命名
  - 共享改动最多推荐 3 个代表页，其余计入 `omitted`
- **来源标签**：写工具证据对应 `agent-confirmed`，其余为 `workspace-observed`。不声称能可靠区分作者（§5.3）。
- **AGENTS.md §6.3 补充**：Host 可以调用适配器的 `impact`（只读，与 probe/discover/plan 同级），仍不得调用 `start`。本次已写入 AGENTS.md。
- **方案同步**：§4.2（open 省略 target 的行为、status suggestions）、§5.3（基线实现定稿、时间预算实测值）。
- **测试债**：基线与 diff 的新增、修改、删除、重命名；已有未提交改动不算本轮；超预算降级；.gitignore 子集；
  写工具白名单与越界路径；SFC 与样式的 import 链；字面量与正则别名；动态 import 进 gaps；路由表各形态；
  共享样式最多 3 个代表页；后端或文档改动进 unrelated；重放事件不触发。

### R3-5 轮次触发：smart（Phase 3 第二步；§9.1；D2）

- **目标**：`turn/end` 时按模式决策：
  - 已有预览且项目受影响：发 `inputs-changed`，由 Runner 按能力刷新或报告 restart-required
  - 没有预览：只推荐
  - `always` 模式的 auto-open：本轮返回 unsupported 诊断
- **文件（骨架已建）**：`src/host/trigger.ts`（纯决策）、`core/impact/rank.ts` 的 `singleConfidentCandidate`。
  锚点：`host/session-registry.ts`（onTurnAnalyzed）、`runner/controller.ts`（inputs-changed）、`host/plugin.ts`（`Config.trigger`）。
- **Runner 侧**：Vite 的 HMR 已经覆盖普通改动，`inputs-changed` 主要处理以下情况：
  - 入口、setup、构建配置或 `page-preview.config` 变化：报告 restart-required 或 config_changed_needs_approval
  - CLI 路径未被 watch 的文件：refresh
- **配置**：插件配置 `trigger: off | smart | always`，默认 smart。同步 `cordis.patch.yml` 示例、`dev/cordis.dev.example.yml` 和方案 §9.1。
- **测试债**：三种模式的决策表；unrelated 不触发；已有预览不换目标；inputs-changed 的三种结果；非法 trigger 配置报错。

### R3-6 面板：建议与未命中请求（§10）

- **目标**：面板展示本轮建议（关系链、证据、来源）和每个预览的未命中请求数。只展示，不提供一键打开（D2）。
- **文件（骨架已建）**：`src/client/suggestions.ts`。锚点：`client/protocol.ts`（schema 扩展）、`host/session-registry.ts`（panelSnapshot）。
  渲染在 `src/client/panel.ts`，颜色沿用 `--dsw-alias-*` 主题变量。
- **约束**：协议字段要有长度上限；数据与 status 同口径，不建立第二份事实源；`npm run build` 后检查 client bundle 规则
  （`scripts/build-client.mjs` 会拦截非平台依赖）。
- **测试债**：schema 编解码的边界；行投影；空状态；面板不调用 open。

### R3-7 发布准备（Phase 4 中不属于测试的部分）

- `scripts/pack-check.mjs`（骨架已建）：打包清单与元数据检查，只读，不发布。
- `docs/limitations.md`（骨架已建）：限制与故障排查，只写有证据的内容。
- `docs/development-progress.md` 与 AGENTS.md §2：R3 结束时更新为真实状态。
- zod 4.4.3 审计告警：只在文档中记录风险评估，不升级（升级 DSH 需授权）。
- **测试债**：pack-check 在干净 clone 上 build 后运行；Aesc 授权后在干净 DSH profile 中安装验收（`docs/dsh-e2e-acceptance.md`）。

## 5. T 阶段：集中测试（全部开发项完成后）

按顺序执行。全部通过后，各项才能在进度文档中标 ✅。

1. **补单测**：逐条清理 `grep -rn "TODO(test:r3-" src`，按 §4 各项的"测试债"补齐，失败路径优先（AGENTS.md §8、方案 §15.2）。
   新增的判定用例补进方案 §15.3 表格。
2. **真实工具链**：用 `tests/toolchains/` 的 Vue 3 Vite 与 Vue 2 CLI 样本跑通以下链路：
   R3-1 草稿 → 填写 → R3-2 refresh 后数据生效 → 切换场景 → R3-4 改样式出现正确候选 → R3-5 已有预览收到 inputs-changed。
   macOS 和 Linux（Docker `node:24-slim` + Chromium）各跑一遍。
3. **全量回归**：`npm run typecheck`、`npm test`，附实际输出。
4. **Aesc 本机（需授权）**：
   - DSH desktop 实机：面板建议与未命中区块、主题、轮次触发
   - overview/web 只读复核：影响分析候选、项目 Mock 识别、草稿
   - 按 `docs/dsh-e2e-acceptance.md` 归档证据到 `docs/evidence/`
5. **能力等级**：只有通过样本验证的项，才能把 `scenarioReset` 等能力改为 supported，并同步 `tests/fixtures/README.md` 和方案 §6.9。

## 6. 必须停下来问 Aesc 的情形

- 需要改变 D1～D4 中的任何一项，或者实现中发现默认决策行不通
- 需要新增依赖、升级 DSH、push 或发布、在任何 DSH profile 中安装
- 方案与本计划冲突，或方案与 AGENTS.md 冲突（AGENTS.md §1：先指出冲突，不要自己选一边）
- 现有测试因本轮改动失败，而失败的断言体现的是产品约束（不是有意改变的行为）
