你接手 dsh-page-preview 仓库，修复 R6 复核（Claude，2026-11-05，复核范围 `a185d07..5261c50`）发现的问题。
复核时的基线：typecheck 0、line-length ok、`npm test` 539/539 + 99/99、0 跳过（macOS arm64，Node 24.13.1）。

## 先读

1. `AGENTS.md`（§5 硬约束、§6 代码约定、§7 契约同步、§8 验证与交付）
2. `docs/r6-plan.md`：R6-2b、R6-3c、R6-4 的完成标准
3. `src/scenario/call-site-context.ts`、`src/host/session-registry.ts`（status 的草稿段与 unmatched 输出）、
   `tests/unit/call-site-context.test.ts`、`tests/unit/real-traits.test.ts`、`tests/helpers/real-traits-fixture.ts`

## 要修的问题（按顺序，每项一个本地 commit）

### R6-F1 后缀匹配误配（缺陷，已复现）

现象：计划 R6-2b 要求"不确定时不给，不误配"，但单段后缀会命中无关字面量。复核用最小样本实测：

```
未命中 GET /api/menu/list
  → src/api/menu.ts      suffix  getRequest('/menu/list')        正确
  → src/router/index.ts  suffix  { path: '/list', component: … } 误配
未命中 GET /api/user/info
  → src/router/index.ts  suffix  localStorage.getItem('/info')   误配
```

根因：`call-site-context.ts` 构建 suffix 索引时，未命中路径在每个 `/` 处切出的后缀都会入索引，包括 `/list`、`/info`
这样的单段后缀；匹配时也不检查字面量所处的语法位置。误配条目会占用每个接口的 `perEntry` 名额，把真实请求点挤出去，
还可能从错误的函数取到 typeHint。

要求：
- suffix 至少两段（如 `/menu/list`）；单段后缀一律不匹配。
- 同一条目已有 exact 或 template-prefix 命中时，不再返回 suffix 命中。
- 字面量必须是函数调用的实参（含 `getRequest('/x')`、`request({ url: '/x' })` 这类对象实参里 `url` 属性的值）；
  对象字面量里的其他属性（如路由表的 `path`）、`localStorage.getItem` 一类明显不是请求的调用怎么判定，
  由你按"宁可不给也不误配"的原则定规则，并在文件头写明。
- 补单测，至少覆盖：路由表 `path: '/list'` 不命中；`localStorage.getItem('/info')` 不命中；
  两段后缀 `getRequest('/menu/list')` 仍命中且标 `suffix`；exact 与 suffix 同时存在时只返回 exact；
  误配候选不再占用 `perEntry` 名额。
- 先在不含修复的代码上确认新用例失败，再确认修复后通过，并写进提交信息。

### R6-F2 R6-3c 端到端证据补齐（证据缺口）

现象：计划 R6-3c 要求"R6-0 样本：open → status → 一次 merge+applyTo，页面显示 fixture 数据"。
现有证据只在 `tests/unit/toolchain-scenario.test.mjs` 中，是 HTTP 层 fetch 断言，不是 real-traits 样本上的浏览器证据。

要求：
- 在 `tests/unit/real-traits.test.ts` 新增一例，走公开工具链路（参照 `tests/unit/vue-vite-public.test.mjs` 的 setup：
  SDK `ToolRuntime` + `SessionRegistry` + 合成审批答复），全部特征开启：
  `open` → `status { detail: true }`，断言未命中列表包含登录与页面接口，`fixtureDraft.contexts` 能指到 API 模块，
  `envelopeHint` 给出 `code:0` 包装建议 → 用建议的 envelope 加只写 data 的 fixture 先 create 一个场景，再用
  `write_scenario { mode:'merge', applyTo }` 追加剩余接口 → headless Chrome 断言页面进入成功分支、显示 fixture 数据，
  并且 status 的未命中列表清空。
- 先在不含修复的代码上确认这条用例是否通过；如果失败，说明暴露了什么问题，修复后在提交信息中写明。
- 进度文档中这一项写明是 headless Chrome 证据，不是 DSH 载体证据。

### R6-F3 `unmatched.hint` 按条件给出（小问题）

现象：`session-registry.ts` 的 status 输出中，只要有 `lastNewEntryAt`，hint 就固定为"Call page_preview_status again shortly…"，
与 `sinceLastNewEntryMs` 的实际值无关。R5-F7 修过同类的"hint 与状态不符"问题。

要求：
- 定一个稳定阈值（常量，写明取值依据）。低于阈值时，hint 建议稍后再调 `page_preview_status`；
  达到阈值时，hint 改为可执行的下一步：按 `fixtureDraft` 填数据后调 `page_preview_write_scenario`
  （有 previewId 时提示带 `mode:'merge'` 与 `applyTo`）。
- 补单测覆盖两个分支（用可注入的时间源，不要真等）。hint 文案仍须满足 AGENTS.md §5 第 12 条。

### R6-F4 status detail 的扫描耗时（先测量，再决定）

现象（推断，未实测）：每次 `status { detail: true }` 都会重新做三遍源码扫描（`collectFixtureSources`、
`collectEnvelopeHint`、`collectCallSiteContext`，后者默认预算 1.5s），而 R6-4 的 hint 会引导 Agent 多次调用 status。

要求：
- 先测量：在 real-traits 样本和一个合成大树（约 3 万个文件，参照 `src/core/change/baseline.ts` 注释中 R5-9 的测法）上，
  记录单次 `status detail` 中三项各自的耗时，写进提交信息。
- 只有单次合计超过 500ms 时才加缓存：按预览缓存，以"未命中键集合 + 源码树变更"作为失效条件（可复用已有的
  change tracking，不要新写一套文件监听）。不超过就不改代码，只记录测量结论。
- 无论是否加缓存，都确认三项是否共享同一个时间预算，并在 `session-registry.ts` 的注释里如实写明。

## 规则

- 不改变对外契约：工具参数、输出字段名、诊断码保持不变。F3 只改 hint 文案的生成条件。
- 每次提交前：`npm run typecheck` 0 错误，`node scripts/check-line-length.mjs` 通过；每项完成后跑全量 `npm test`，必须全绿。
- 现有测试失败时修代码，不改测试迁就；确属有意的行为变化（如 F1 让既有用例的匹配结果变少），在提交信息中逐条说明。
- 每项至少一个本地 commit，全部完成后打本地 tag `r6-fix1`，并在 `docs/development-progress.md` §2.0 加一行
  （提交范围、tag、全量回归数字）。
- **禁止** push、发布、新增运行时依赖、升级 DSH、在 DSH profile 中安装、访问任何业务项目（含 overview/web）。

## 遇到以下情况停下来，写清问题后等 Aesc

- 修复需要改变已有参数、字段或诊断码的语义
- F1 的规则在现有用例上会漏掉 Devin 认为合理的真实请求写法，且无法在"不误配"前提下兼顾
- F2 暴露的问题需要改变产品行为才能修

## 汇报格式（中文，每项一段）

问题 → 根因 → 修复 → 已验证（命令与输出摘要，含"修复前失败、修复后通过"）→ 未验证 → 剩余风险。
区分已验证的事实、推断和未知。
