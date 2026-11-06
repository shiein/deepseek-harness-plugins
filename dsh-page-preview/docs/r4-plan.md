# R4 计划：首版收尾（技术债 + 文档）→ T 阶段集中测试

- 编写：2026-11-03（Claude，Aesc 要求）；执行：Devin
- 前置：R3-0～R3-7 代码完成（🟨）。Claude 复核后修正了写工具白名单（`52520ea`，真实工具是 `write` / `search_replace`）
- 依据：`docs/review-2026-11-01.md` §5（P2-5～P2-10）、`docs/r3-plan.md` §5（T 阶段）、方案 §14 Phase 4、§15
- 骨架与锚点：`grep -rn "TODO(r4-" src docs tools`

## 0. 结论先行

按方案 §1.3 的首版范围和 §14 的首个可用里程碑，**新功能已经基本做完**。剩下的开发工作分两类：

1. **收尾（本计划 R4-1～R4-7）**：第一轮 review 遗留的可维护性问题，加上文档整理。规模小，不改变产品行为。
2. **需要 Aesc 先做决定的功能（§5）**：Devin 不做。

R4 完成后进入 **T 阶段**（§4）。T 阶段要补齐 R3 和 R4 的全部测试债，并跑真实工具链，这是首版能否被称为"完成"的关键一步。

## 1. 工作规则

沿用 `docs/r3-plan.md` §2 的全部规则（测试后置、回归门槛、🟨/✅ 口径、本地提交、禁止 push 和发布、契约同步、环境限制）。补充三条：

- TODO 标签：`TODO(r4-N)` 是开发锚点，`TODO(test:r4-N)` 是测试债。
- R4 不得改变任何对外行为（工具参数、输出字段、诊断码、能力等级）。唯一的例外是 R4-1 给意外失败诊断的 hint 追加日志路径，这一点要同步方案 §4.2。
- 删除或移动文件前，先 `grep -rn` 找出所有引用（代码、`package.json`、文档、AGENTS.md），在同一个提交内一并更新。

## 2. 顺序

R4-4 → R4-2 → R4-1 → R4-3 → R4-7 → R4-5 → R4-6 → T

先做纯机械的 R4-4，最后做文档。文档放最后，是为了让它反映收尾之后的最终代码。

## 3. 工作项

### R4-1 结构化调试日志取代 `lastError`（P2-8）

- **现状**：`host/session-registry.ts` 和 `runner/controller.ts` 的意外失败只写进公共字段 `lastError`，只有测试读得到。用户和 Agent 都看不到失败原因。
- **做法**：实现 `src/shared/debug-log.ts`（骨架已建，设计写在文件头），Host 和 Runner 各写一份 JSONL，脱敏策略与诊断相同，有大小上限。
  意外失败诊断的 hint 追加"详细信息见 <日志路径>"。
- **测试**：读 `lastError` 的现有测试改为注入 DebugLog 或读日志文件。这属于"本轮有意改变"，要在提交信息里逐条列出。
- **同步**：方案 §4.2 诊断说明、§13 第 8 条（日志也受脱敏约束）、`docs/limitations.md` §6。
- **测试债**：脱敏（env 值、nonce 不进日志）；超限滚动；dataDir 缺失；写入失败不影响预览；hint 中带路径。

### R4-2 Host 缓存回收（P2-9）

- **现状**：`host/runner-client.ts` 的 `snapshots`、`diagnostics` 按 previewId 只增不减。每次 open 都生成新的 ID，长会话下持续增长。
- **做法**：`src/host/snapshot-retention.ts`（骨架已建）。每个 owner 保留最近 16 个终态预览，`cleanup_failed` 和非终态一律保留。被回收的 ID 再查询返回 `not_found`。
- **测试债**：上限边界；cleanup_failed 不被回收；回收后 status 返回 not_found；多 owner 互不影响。

### R4-3 pageText 采集降频（P2-10）

- **现状**：`src/browser/bootstrap.js` 在每次 DOM 变化后 100ms 读一次 `innerText`，会强制重排。
- **做法**：首帧立即采集，之后节流到 ≥1000ms。`attributeFilter` 保留不变，因为 class/style/hidden/open 会改变可见文本。
  浏览器侧只能写 ES2018，改完后用 `node --check` 检查。
- **不得破坏**：open 在侧边栏加载后附带 pageText；`text-present` 断言（它在 bootstrap 中独立轮询，不依赖这个节流）。
- **测试债**：首帧立即上报；连续变化被合并；页面卸载时清理定时器。

### R4-4 删除 core 转发层（P2-5）

- `src/core/config/{fingerprint,loader,paths,schema}.ts` 和 `src/core/profile/detect.ts` 都是两行的兼容转发，项目未发布，不需要兼容层。
  删除后，所有调用方改为直接 import `shared/`。
- 同步 AGENTS.md：§6.3 依赖图、§7 表格中的 `core/config/schema.ts` 改为 `shared/config/schema.ts`。
  方案中提到这些路径的地方也一并更新。
- 只做删除和改 import，不搬迁 `shared/` 中的领域逻辑（review 提到的"shared 名不副实"不在本轮）。

### R4-5 一次性探针归档（P2-7）

- 按 `tools/probes/README.md` 的规则处理 `dev/` 和 `scripts/` 中的 probe/verify 脚本，逐个登记"删除（被哪个测试覆盖）"或"归档（用途）"。
- 构建和测试链路依赖的脚本，以及 `dev/cordis.*.example.yml`、`dev/bridge`（`package.json` 引用了它），不动。
- 判断"已被测试覆盖"时，必须指出具体的测试文件与用例名，不能凭脚本名推断。

### R4-6 文档整理（P2-6）

- 新建（骨架已建）：`docs/guide.md`（使用指南）、`docs/config-reference.md`（取代过时的 `docs/configuration.md`）、
  `docs/architecture.md`、`docs/evidence/`（运行证据，PID 和端口替换为占位符）。兼容矩阵仍以 `tests/fixtures/README.md` 为准。
- 专题文档（`docs/vue-*.md`、`docs/static-*.md`、`docs/phase0-*.md` 等）：结论并入上面三份，运行细节移进 `docs/evidence/`，
  原文件删除或缩成一行指向新位置。**`dsh-page-preview-development-plan.md` 不动**（它是产品依据，改动需 Aesc 同意）。
- AGENTS.md §2 已经过时，需要更新：
  - 原文"scenarioReset 未实现"，实际已实现，能力等级为 unknown
  - 原文"函数包裹入口仍需手写 setup"，220a06a 之后已能自动生成
  - 原文"397/397"，应改为最新的实际数字
  - 原文"Client 原生实测待授权"，Aesc 本机已部分实测
- `docs/development-progress.md` 压缩为当前状态加 T 阶段清单；历史移到 `docs/progress-log.md`。
- 只写有证据的内容。所有链接在改完后要逐个检查可达（用 `grep -o '](.*\.md)'` 列出后核对文件存在）。

### R4-7 清理过时的 TODO

- `src/browser/vue/mount-vue2.js` 的 `TODO(phase1)`：逐项核对 `lifecycle.js` 是否已实现，删掉已实现项；"清理挂到 body 的残留节点"若未实现则补上，与 Vue 3 路径行为一致。
- 其余 `TODO(phase0)`、`TODO(phase1)`（output 诊断条数调参）、`TODO(sample)` 需要真实 DSH 或样本，保留，并列入 T 阶段。

## 4. T 阶段：集中测试（R4 完成后开始）

T 阶段要写测试，这是 Aesc 定下的"开发完成后集中测试"的那一步。完成 R4 后，Devin 直接进入 T 阶段，除非 Aesc 另有安排。

1. **测试债清零**：`grep -rn "TODO(test:r3-\|TODO(test:r4-" src` 逐条补测试，每补完一条删掉对应注释。
   每个工作项的测试清单见 `docs/r3-plan.md` §4 与本文 §3。失败路径优先（方案 §15.2）。新增的判定用例补进方案 §15.3。
2. **已知偶发失败**：`vue-vite-public.test.mjs` 的"invalid handler exports"偶尔得到 `cleanup_failed`。T 阶段要么定位根因并修复，
   要么写清楚复现概率和观察到的时序，不能用重试掩盖。
3. **真实工具链链路**：用 `tests/toolchains/` 的 Vue 3 Vite 样本和 Vue 2 CLI 样本各跑一遍以下链路：
   R3-1 草稿 → 填写 → refresh 后数据生效 → 切换场景 → 改样式后出现正确候选 → 已有预览收到 inputs-changed。
   macOS 与 Linux（Docker `node:24-slim` + Chromium）都要跑。
4. **能力等级**：只有通过样本验证的项，才能把 `scenarioReset` 等能力改为 supported，并同步 `tests/fixtures/README.md` 和方案 §6.9。
   `refresh`（`mode: 'hmr'`）2026-11-03 已按 Aesc 决定退回 `unknown`：HTTP 级证据只证明服务器供出新内容。
   升回条件——浏览器实测页面已应用新版本后再改回 `supported`。
5. **全量回归**：`npm run typecheck`、`npm test`、`npm run build`、`node scripts/pack-check.mjs`，附实际输出。
6. **交给 Aesc 的实机清单**（Devin 只整理，不执行）：
   - DSH desktop 中的面板建议与未命中区块、轮次触发、调试日志位置
   - overview/web 只读复核（影响分析候选、Mock 识别、fixture 草稿）
   - 按 `docs/dsh-e2e-acceptance.md` 归档到 `docs/evidence/`
7. 全部通过后，各项在进度文档中改为 ✅。

## 5. 需要 Aesc 决定后才开工的功能（Devin 不做）

| 项 | 现状 | 需要的决定 |
| --- | --- | --- |
| D1 执行项目自带 Mock | 只识别和报告 | 是否允许在 Runner 中执行项目 Mock（会成为新的执行项，需要审批） |
| D2 自动打开 / 面板一键打开 | 只推荐 | 自动打开没有 Agent 工具调用的审批上下文，需要定审批方式 |
| D4 截图 | `capture` 返回 unsupported | 截图只给用户看，还是也要给模型（需要先在 DSH 实测图片能否到达模型） |
| 视口控制 | `viewport` 参数在所有路径都返回 unsupported | 是否要做。正确做法是插件自有的外层页面加固定尺寸 iframe，因为用容器宽度模拟会让媒体查询失效，等于伪造 |
| D3 第二个真实业务样本 | 没有 | 能否提供 Vue 2 + Element UI 的真实项目 |
| React 适配器、Tier 2 组件库 | 方案列在里程碑之后 | 首版发布之后再定 |

## 6. 必须停下来问的情形

与 `docs/r3-plan.md` §6 相同。另外：

- 文档整理中发现方案正文与代码行为冲突
- 探针脚本找不到对应的测试覆盖，又看不出它的用途
