# R6 计划：无 Mock 项目的一轮补数据（通用、快速、少调用）

- 编写：2026-11-04（Claude，按 Aesc 要求"尽可能通用、适用各种项目、快速响应、减少 Agent 调用"）；执行：Devin
- 状态：**已执行完成（R6-0～R6-4，检查点 `r6-cp0`～`r6-cp3`）**。本文件与骨架（`TODO(r6-N)` 锚点、两个新模块）同一提交落地
- 前置：`f21777c`（生成 setup 的 `.js→.ts` 解析修复）；R5 全部检查点与 fix1 已完成
- 依据：方案 §7.2、§4.2、§8、§13 第 8 条；AGENTS.md §5 硬约束 1、5、10、12；R5-fix1 关于占位保护的决定

## 0. 结论先行

overview/web 这类项目没有 mock 目录、没有静态 OpenAPI，接口函数也没有响应类型
（2026-11-04 只读核实：`web/src/api/` 31 个 `.ts`，带响应类型的引用 0 处）。
现有机制下每个未命中接口都要 Agent 自己翻代码、猜字段、逐个写回、再手动刷新，调用多、命中率低。

R6 不引入新的数据来源去"猜"数据，而是做三件确定性的事，把 Agent 的工作压到**一轮**：

1. **响应包装只写一次**（R6-1）：场景声明 `envelope`，fixture 只写 `data`；最常见的"拦截器判成功码失败"一次解决。
2. **草稿自带调用点上下文**（R6-2）：status 一次返回每个未命中接口的请求函数、调用方读取的字段、显式类型。
3. **一次写回并就地生效**（R6-3、R6-4）：merge 追加 + 写后自动切换场景；status 告诉 Agent 未命中列表是否已稳定。

目标循环：`open` → `status detail`（等列表稳定）→ Agent 一次填好 → `write_scenario { mode:'merge', applyTo }`。
每轮 2～3 次工具调用，不再随接口数量线性增长。

## 1. 决策

| # | 事项 | 结论 |
| --- | --- | --- |
| H | HAR 导入 | **不做**（Aesc 2026-11-04） |
| E | 包装模板标记 | 专用标记 `__DSH_PREVIEW_DATA__`（`scenario/envelope.ts` 的 `ENVELOPE_DATA_TOKEN`），不复用 `FIXTURE_PLACEHOLDER` |
| C | 调用点上下文的边界 | 插件只做确定性收集（位置、片段、属性链、显式类型）；**不做**按名字猜类型、不做跨函数数据流推断 |
| M | 写回合并 | 新增 `mode:'merge'`，只追加新键；与已有 fixture 冲突时整体拒绝并列出冲突键，**不覆盖** |
| S | 合成数据模式（用类型或字段结构直接生成响应） | **待 Aesc 决策，本轮不做**。它与 R5-fix1 的占位保护决定冲突，属产品边界变更（AGENTS.md §9） |

## 2. 工作规则

- 沿用 R5 规则：每个工作项自带测试，不留 `TODO(test:r6-N)`（需要真实 DSH 或业务项目的除外，列入实机清单）。
- 锚点：`grep -rn "TODO(r6-" src docs tests`。完成一项就删掉对应的 `notImplemented` 和锚点。
- 对外契约只能**新增**，已有参数、字段、诊断码的语义不得改变；新增项按 AGENTS.md §7 同步方案与 JSON schema。
- 禁止：新增运行时依赖、升级 DSH、push、发布、在 DSH profile 中安装、访问 Aesc 的业务项目（含 overview/web）。
- 每个工作项至少一个本地 commit；每个检查点打本地 tag（`r6-cp0`～`r6-cp3`），
  并在 `docs/development-progress.md` §2.0 记录提交范围与全量回归结果。

## 3. 工作项

### R6-0 真实特征样本（先做，后续各项的回归底座）

R5 期间多次出现"单测全过、真实项目才暴露"（入口 `initVue` 包裹、内联脚本、`root: process.cwd()`、
2026-11-04 的 `.js→.ts`）。先建一个**仿真实特征、不含任何业务代码**的测试样本。

| 内容 | 完成标准 |
| --- | --- |
| 新建 `tests/helpers/real-traits-fixture.ts`（骨架已建）：Vue 3 + Vite，复用 `vue3-self-contained` 工具链 | 特征逐条可开关：TS 入口；`/@/` 正则别名；入口 `import … from '/@/x.js'` 指向 `.ts`；入口先请求登录信息再 `initVue()`；`index.html` 内联脚本；axios 风格请求层与拦截器（`res.data.code !== 0` 即报错，**自写最小实现，不新增依赖**）；无类型的 API 模块 |
| 用它跑通一次"无数据 → 报 unmatched"的基线 E2E | 断言未命中列表包含登录信息与页面接口，页面走拦截器错误分支（这是 R6-1～R6-3 要改善的起点） |

### R6-1 场景级响应包装（envelope）

| 子项 | 内容 | 完成标准 |
| --- | --- | --- |
| 1a 配置 | `scenarioConfigSchema` 新增 `envelope: { template }`，fixture 新增 `envelope: false` 逐条退出 | schema、类型、`schema/page-preview.config.schema.json`、方案 §8 同步；模板零处或多处标记为 `config_invalid`，hint 可执行 |
| 1b 展开 | `scenario/envelope.ts` 的 `validateEnvelope`/`applyEnvelope`；在物化 Mock fixtures 处统一展开 | bodyFile、204/205/304、`envelope:false` 原样；data 为数组/null/原始值都正确；展开后残留占位标记仍拒绝；**未命中请求行为不变** |
| 1c 草稿 | 场景已声明 envelope 时，`fixtureDraft` 的响应体只写 data 占位，`configSnippet` 不重复包装 | 单测：有/无 envelope 两种草稿 |
| 1d 包装线索 | 只读识别请求层拦截器中的成功码判断（如 `res.data.code !== 0`、`code === 200`），给出 `fixtureDraft.envelopeHint`（模板建议 + 文件/行/片段依据） | 只是建议，**不自动写入场景**；识别不到就不给，不猜默认值；R6-0 样本上能给出正确建议 |
| 1e 端到端 | R6-0 样本 + headless Chrome | 声明 envelope 后，fixture 只写 data，页面越过拦截器进入成功分支 |

### R6-2 草稿附调用点上下文

| 子项 | 内容 | 完成标准 |
| --- | --- | --- |
| 2a 收集 | `scenario/call-site-context.ts` 的 `collectCallSiteContext`（骨架已建，约束见文件头） | 同一次 status 只扫一遍源码；字面量与模板字符串静态前缀能命中；`.vue` 取 `<script>`；预算触顶 `limited:true` |
| 2b 前缀不一致 | 请求层带 `baseURL` 前缀、未命中路径带前缀而源码字面量不带（或反之） | 只按"未命中路径以字面量结尾且边界在 `/`"匹配，并在 context 中标注匹配方式；不确定时不给，不误配 |
| 2c 显式类型 | 调用点有泛型实参或返回值注解时，用已依赖的 `typescript` checker 展开为 `typeHint` | 只认显式类型；`any`/`unknown` 不给；展开深度、字段数有界；provenance 写类型名与位置；**不进响应体** |
| 2d 接入 status | `status detail` 的 `fixtureDraft.contexts` / `contextLimited`；收集失败或触顶产生可见诊断 | 不阻断 status；耗时计入预算；方案 §4.2、§7.2 同步 |
| 2e 安全 | 片段经共享脱敏；不读 `.env*`、不进 `node_modules` | 每类"必须去除"的内容有单测（AGENTS.md §5 第 10 条） |

### R6-3 一次写回并就地生效

| 子项 | 内容 | 完成标准 |
| --- | --- | --- |
| 3a merge | `write_scenario` 新增 `mode:'create'\|'merge'`（缺省 create = 现有语义） | merge 只追加 (method, origin, path, query) 不存在的 fixture；冲突整体拒绝并列出冲突键；envelope 等场景级字段在 merge 中只能新增不能改写（改写需显式 create 新场景） |
| 3b applyTo | 新增 `applyTo: previewId`：写入成功后走既有 `refresh` + scenario 路径就地切换 | 审批、备份、TOCTOU 哈希比对流程不变；预览不属于调用者或已停止时写入照常、应用部分如实报错；结果合并返回 |
| 3c 端到端 | R6-0 样本：open → status → 一次 merge+applyTo | 页面显示 fixture 数据；status 未命中列表清空（或只剩故意未填的条目） |

### R6-4 未命中列表稳定信号

| 内容 | 完成标准 |
| --- | --- |
| `unmatched` 汇总新增"距最近一次新增未命中条目的毫秒数"（字段名由实现定，只新增） | Agent 据此判断首屏请求是否已发完，不必轮询；方案 §4.2 同步；hint 写成可执行的下一步（例如"稍后再调一次 page_preview_status"） |

### R6-5 合成数据模式（不做）

待 Aesc 决策。Devin **不得**实现任何"未填数据时自动生成响应"的逻辑，也不得让 typeHint/shapeHint 进入响应体。

## 4. 检查点

| 检查点 | 内容 | tag |
| --- | --- | --- |
| CP0 | R6-0 | `r6-cp0` |
| CP1 | R6-1 | `r6-cp1` |
| CP2 | R6-2 | `r6-cp2` |
| CP3 | R6-3、R6-4，AGENTS.md §2 与进度文档收口 | `r6-cp3` |

## 5. 不做的事

- HAR 导入、插件代理录制真实后端（违反 mock-only）
- 合成数据模式（R6-5）
- 按 URL 或名字猜 TS 类型（R5-fix1 已删除，不得恢复）
- 跨函数数据流推断（"响应 → 变量 → 组件 → 模板"的追踪）
- 未命中请求返回空对象、空数组或任何兜底成功响应

## 6. 实机清单（Devin 不做，留给 Aesc）

- overview/web：声明 envelope、读取 contexts、一轮 merge+applyTo 后的页面效果
- DSH 审批弹窗中 merge 写回的差异展示是否可读
