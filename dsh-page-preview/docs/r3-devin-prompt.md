你接手 dsh-page-preview 仓库（DeepSeek Harness 插件：用项目的原代码、原编译器和场景数据预览真实业务页面）的第三轮开发（R3）。

## 先读（按顺序，读完再动手）

1. `AGENTS.md`：全部内容，尤其 §5 产品硬约束、§6 代码约定、§7 契约同步、§9 需要先问的事
2. `docs/r3-plan.md`：本轮计划，包括工作规则、默认决策 D1～D4、工作项 R3-0～R3-7 和 T 阶段
3. `dsh-page-preview-development-plan.md` 中的 §0.3、§4.2、§5.2～5.3、§7.2～7.4、§9.1、§10、§11
4. 每个要改的文件的文件头注释。骨架和待办锚点用 `grep -rn "TODO(r3-" src scripts docs` 列出

## 任务

按 `docs/r3-plan.md` §3 的顺序实现 R3-0 → R3-1 → R3-2 → R3-3 → R3-4 → R3-5 → R3-6 → R3-7。
每项都要把对应的 `notImplemented` 和 `TODO(r3-N)` 换成真实实现，并完成计划里写明的契约和方案文档同步。
**T 阶段（集中测试）不在本次任务范围内**，除非 Aesc 另行要求。

## 本轮工作规则（Aesc 的明确要求，优先于 AGENTS.md §4 的"完成即补单测"）

- 不写新的单测或 E2E。每项完成后，在相关代码处留 `TODO(test:r3-N)` 注释，按计划里该项的"测试债"写明要补哪些测试。
- 每次提交前：`npm run typecheck` 为 0 错误，`node scripts/check-line-length.mjs` 通过。
- 每完成一个工作项，跑一次现有全量 `npm test`，必须全绿。现有测试失败时修代码，不改测试迁就。
  只有当失败的断言正是本轮有意改变的行为时才可以改测试，并在提交信息里逐条说明。
- 每项完成后，在 `docs/development-progress.md` §2.5 中标"🟨 代码完成，测试待补"，附提交号。**不要标 ✅。**
- 每个工作项至少一个本地 commit，提交信息说明：目标、设计、改动点、已验证项（typecheck/test 的实际结果）、未验证项。
  **禁止 push 或发布**，禁止新增依赖，禁止升级 DSH。

## 硬约束提醒（违反即缺陷）

- 不伪造：fixture 草稿的响应体只能是占位标记，`validateConfig` 必须拒绝未填写的草稿；没有证据的能力写 `unknown`
- 只读：影响分析、Mock 识别只读文件，不执行或 import 项目代码，不读 `.env*`；Host 只调用适配器的 probe/discover/plan/impact
- 不放宽：触发与场景切换不改变 scope、strategy、requirements，不绕过执行审批；handlers、setup、command、env 变化一律要求重新 open
- 诊断与输出中不出现 query 值、请求体、headers、凭据；method、origin、path 照常转发
- core、`adapters/types.ts`、`adapters/vue/{vite,cli}/` 中不出现针对某个 UI 组件库的分支
- 浏览器侧 `src/browser/**` 只能写 ES2018 普通 JavaScript
- 新增和修改的代码行不超过 120 字符；可擦除 TS 语法；相对导入带 `.ts` 后缀

## 环境说明

你的环境里没有 Aesc 的 DSH 桌面应用，也没有 `overview/web` 业务项目，不要尝试访问。
可用的样本是 `tests/toolchains/`（六套已批准的工具链，`pretest` 会幂等安装）和 `tests/fixtures/`。
需要真实 DSH 或真实业务项目的验证，写进 `docs/r3-plan.md` §5 T 阶段的清单，不要声称已验证。
DSH 的 API 行为以 `node_modules` 中锁定版本 0.2.1-rc.5 的类型定义为准，不凭记忆。
写工具名白名单（`core/change/agent-writes.ts`）必须从锁定版本的源码或类型中核实。

## 遇到以下情况停下来，写清楚问题后等待 Aesc，不要自行决定

- 需要改变 D1～D4 中的任何一项，或者发现默认决策实现不了
- 方案、AGENTS.md、`r3-plan.md` 之间有冲突
- 需要新增依赖、升级 DSH、push、发布，或在 DSH profile 中安装
- 某个现有测试因你的改动失败，且它断言的是产品约束

## 每个工作项完成时的汇报格式（中文）

现象或目标 → 设计 → 改动文件 → 已验证（typecheck/test 的实际输出摘要）→ 未验证 → 留下的 `TODO(test:r3-N)` 清单 → 剩余风险。
区分已验证的事实、推断和未知。
