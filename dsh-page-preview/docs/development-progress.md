# 开发进度与 TODO

目标：按方案首版范围持续完成全部阶段和对应 TODO，每完成一项功能就本地提交。不能因为已完成的子集通过了验收，就重新定义完成标准；React 等明确排在首版之后的扩展仍按方案边界处理。

**写法约定：**每项只写一行状态加证据链接。详细的完成说明写进提交信息或 `docs/progress-log.md`，不要再在本文件里写长段落。

- **当前轮计划：[`r6-plan.md`](r6-plan.md)（R6，2026-11-04，已完成 r6-cp0～r6-cp3；R6-5 合成数据待 Aesc 决策未做）**；上一轮 [`r5-plan.md`](r5-plan.md)
- 2026-11-04 修复：生成 setup `.js→.ts` 解析（f21777c；Vue/React 各一条 headless Chrome E2E，`npm test` 515+96/0）
- 最新 review：[`review-2026-11-02.md`](review-2026-11-02.md)（第二轮）；上一轮见 [`review-2026-11-01.md`](review-2026-11-01.md)
- 逐项完成说明与各轮历史（归档）：[`progress-log.md`](progress-log.md)

## 1. 当前真实状态

- **能用的部分（仅 macOS 实测）：**
  - static、attach、project-command 三条通用路径；
  - Vue 3 + Vite 隔离预览，未验证的版本会带 `unverified_toolchain` 提示照常运行；
  - Vue 2 / Vue CLI：devServer 接管、编译后自动刷新与 .env 拦截已落地并经真实 worker 验收；Tier 1 样本已复验；
  - 编译错误带文件、行号和 code frame；
  - 崩溃后可以回收资源，也可以手动 `recover`；
  - 修改代码后 `freshness` 能达到 `current`（Vite/CLI 路径）；
  - 入口没有 setup 时会生成草稿（含顶层函数包裹入口）；
  - fixture 草稿、场景重载、项目 Mock 只读识别、影响分析、面板建议、未命中区块（R3）；
  - 结构化调试日志（`<dataDir>/logs/*.jsonl`）与终态预览回收（每 owner 16 条）（R4）。
- **真实 DSH 端到端：**Aesc 本机 DSH desktop 已部分跑通 overview/web open→侧边栏（R2-P0-4 🟡，逐项证据未归档，见 T 阶段）；审批弹窗、Client 其余路径只有代码和单测。
- **平台：**macOS arm64 实测；Linux（Docker `node:24-slim`，arm64，Node 24.22.2）工具链全链路
  1/1 通过（[evidence/2026-11-03-linux-toolchain-scenario.md](evidence/2026-11-03-linux-toolchain-scenario.md)，
  HTTP/进程级、无浏览器）；早前"全 E2E 面 135/135 + Chromium 156"无归档运行记录——**未核实**；
  Windows 返回 `unsupported`。
- **最近一次检查（2026-11-03）：**Node 24.13.1/macOS arm64，typecheck 0、全量 525/525/0 跳过（a908e62）；
  Linux Docker `node:24-slim`（Node 24.22.2）工具链全链路 1/1 通过（见上方证据文件）。
- **偶发 `cleanup_failed` 已定位修复（8ab7006）：**被信号终止的 worker 在父进程 reap 前以 zombie 留在进程表，`stopGroup`/ledger 把它计为残留；两平台 `processTable`/`readProcessStartTime` 现排除 Z/X 状态。macOS 用真实 zombie 验证不进表；修复后该用例以 ~1s 干净通过（此前复现路径恒 ~3.7s 满等待）。

## 2. 本轮 TODO

### 2.0 R6（[`r6-plan.md`](r6-plan.md)；检查点记录）

| 检查点 | 内容 | 提交范围 | tag | 回归（macOS arm64, Node 24.13.1） |
| --- | --- | --- | --- | --- |
| CP0 | R6-0 真实特征样本（`real-traits-fixture` 七特征开关 + `real-traits.test` 基线 E2E：无场景登录/页面接口全落 unmatched、code!==0 错误分支、内联脚本执行） | `a185d07` | `r6-cp0` | typecheck 0；check-line-length 通过；`npm test` 515 轻量 + 98 重量级 = 613/613/0 跳过 |
| CP1 | R6-1 场景 envelope（`shared/envelope.ts` validate/apply + `envelope-hint.ts` 拦截器线索；schema/JSON schema/方案 §7.2/§8 同步；mock-middleware 三处物化点展开；status detail 草稿携 envelope/envelopeHint；`envelope.test` 7 例 + `real-traits` 1e E2E headless Chrome 成功分支） | `5527d73` | `r6-cp1` | typecheck 0；check-line-length 通过；`npm test` 522 轻量 + 99 重量级 = 621/621/0 跳过（E2E 未实现先失败已验：worker 拒绝未知 envelope 字段） |
| CP2 | R6-2 草稿调用点上下文（`call-site-context.ts` 单遍只读扫描、`.vue` 取 `<script>`、exact/模板前缀/suffix 三类确定性命中、consumers 属性链、显式类型经 checker 展开 typeHint、any/unknown 不给；预算触顶 `limited`+`context_incomplete` 诊断不阻断；`FixtureDraft.contexts`/`contextLimited`；方案 §4.2/§7.2 同步；`call-site-context.test` 12 例 + `session-registry` 集成 1 例） | `6b30555` | `r6-cp2` | typecheck 0；check-line-length 通过；`npm test` 535 轻量 + 99 重量级 = 634/634/0 跳过 |
| CP3 | R6-3 merge+applyTo（`write_scenario` 新 `mode:'merge'` 只追加 `(method,origin,path,query)` 新键、场景级字段只增不改等值幂等、冲突整体拒绝列键不落半写；`applyTo` 写后走 refresh+scenario 就地生效、应用失败如实报不改写结果；`WriteScenarioResult.applied`）+ R6-4 稳定信号（`UnmatchedRequestLog.lastNewEntryAt` 只记新增键、经 IPC 透传，status 换算 `sinceLastNewEntryMs`+可执行 hint）+ 方案 §4.2/§7.2 与 AGENTS.md §2 收口；测试：`config-write` merge/冲突/缺场景用例 3 例、`unmatched-log` 时间戳 1 例、`session-registry` merge+applyTo 与稳定信号断言、`toolchain-scenario` E2E 加 merge+applyTo 就地生效段落 | `3f3c6b0..4c6f673` | `r6-cp3` | typecheck 0；check-line-length 通过；`npm test` 539 轻量 + 99 重量级 = 638/638/0 跳过（static 预览 applyTo 如实 `unsupported`，Vite worker 就地生效且未命中列表清空） |
| fix1 | 复核修复（`docs/r6-fix-prompt.md`）：R6-F1 suffix 误配（只认请求调用实参位置、单段后缀禁用、exact 压制 suffix，先败后过 3 新用例，call-site-context 15/15）；R6-F2 real-traits 公开链路一轮补数据 E2E（SDK 工具链 → status contexts/envelopeHint → create → merge+applyTo → headless Chrome 成功分支 + unmatched 清空，首轮即过）；R6-F3 hint 按 `UNMATCHED_SETTLE_MS=2000` 分支（低于阈值"再查"、达到"填草稿+merge+applyTo"，options.now 可注入）；R6-F4 耗时实测不加缓存（real-traits ~3-5ms、3 万文件树 ~390-407ms <500ms 阈值；三项不共享时间预算：条目预算 5000/800/5000 + 仅 call-site 1500ms 截止，注释已写明） | `0b94740..fb8b021` | `r6-fix1` | typecheck 0；check-line-length 通过；`npm test` 543 轻量 + 100 重量级 = 643/643/0 跳过 |

### 2.0a R5（[`r5-plan.md`](r5-plan.md)；检查点记录）

| 检查点 | 内容 | 提交范围 | tag | 回归（macOS arm64, Node 24.13.1） |
| --- | --- | --- | --- | --- |
| CP0 | R5-0 复核修复（0a pageText 语义、0b CLI 场景换绑、0c worker 测试债、0d AGENTS.md、0e 进度文档） | `957ee31..a8e146f`（0a5b4a8、067bb8b、945ced2、a1d066e、a8e146f） | `r5-cp0` | typecheck 0；check-line-length 通过；`npm test` 540/540/0 跳过 |
| CP1 | R5-1 数据 Mock 闭环（1a 草稿写回、1b 来源分层、1c 跨源基址、1d 登录前置、1e 项目 Mock 执行、1f 写操作模板、1g WS/SSE）+ R5-3 Vite 浏览器端 refresh 证据 | `f518292..7cc0b0b`（f518292、eb22dbd、4d08cff、a0d9845、e854eb2、6afb36d、abb4ebb、39dd8c8、7cc0b0b） | `r5-cp1` | typecheck 0；check-line-length 通过；`npm test` 568/568/0 跳过（首轮 567/568：refresh 能力升 supported 后一处旧断言未同步，已按 R5-3 有意语义修正） |
| CP2 | R5-2 CLI 对齐（2a assertions/navigation 放行+真实浏览器证据、2b/c Tier 1 矩阵与版本范围）+ R5-3 其余（Linux Chromium 浏览器证据、CSP Worker/SW 边界记录）+ R5-4 路由目标/父布局/视口框架页 + 回归修正（SDK 布尔投影、worker 优雅关闭有界化——vite.close() 不返回导致 SIGTERM 实质失效靠 SIGKILL 兜底） | `15a86ee..4e7de83`（15a86ee、c69ff62、d87716a、3694539、dc224fa、4e7de83） | `r5-cp2` | typecheck 0；check-line-length 通过；`npm test` 577/577/0 跳过（首轮 574/577：verifyPlan 负载下指纹漂移偶发一次未复现——诊断已细化指出分量；vue-detect verified 旧断言已同步） |
| CP3 | R5-5 截图如实记 unsupported（锁定 SDK 无 iframe/webview 截图 API，`docs/limitations.md`）+ R5-6 面板建议一键打开（suggestions[].open 携 JSON 编码真实 TargetSelector、Typert `pagePreview/open`、session 为唯一身份源复用 openAttempt 全路径含官方审批）+ R5-8 Tier 2 冒烟（七库真实包+headless Chrome：naive-ui/tdesign-vue-next/vant/arco/vuetify/primevue@4.2.5 于 Vite + view-design@4.7.0 于 Vue 2.6/cli 5；primevue 4.5.5→4.2.5 因 @primevue/core 依赖 Vue 3.5 `useId` 与 Vue 3.4.27 硬冲突） | `6e1680d..8546562`（6e1680d、8546562） | `r5-cp3` | typecheck 0；check-line-length 通过；`npm test` 587/587/0 跳过 |
| CP4 | R5-7 React 适配器（`react-vite`：检测/入口重放/生成 setup/生命周期/路由/HMR/影响分析/antd+mui profile；Vue 分层复用，core 零分支；`/@react-refresh` 准入修 plugin-react preamble；RouterProvider 叶子→MemoryRouter；不合格导入从生成 setup 排除；react18-vite 工具链 + headless Chrome 实测）+ R5-9 收口（baseline 1500ms≈15 万文件、MAX_DIAGNOSTICS=8 实测定稿；resume 语义按锁定 SDK 类型定论；`dsh-llm` peer 缺口修复后干净安装验证通过——导出 3/9/9、`browser/react` 入包；zod 4.4.3 调查：锁定线无修复版本、不升级、登记风险；guide「真实项目接入」章；矩阵定稿挂 README 样本行；`docs/r5-report.md`+`docs/r5-blockers.md`） | `de1f9d5..a2e1a26`（de1f9d5、bccafc1、e7f68ee、7c40305、a2e1a26） | `r5-cp4` | typecheck 0；check-line-length 通过；`npm test` 598/598/0 跳过；`npm run build` + `pack-check` 通过（539 文件/2476.5 KiB）；npm pack 干净目录安装+导入验证通过 |
| fix1 | R5 CP4 复核修复 F1–F10（fixture 草稿禁合成值顶替占位、测试挂死改超时败报+重量级限并发、写回 TOCTOU 哈希比对、备份入 dataDir 每工作区 10 份、panelOpen 真实 agent+10 分钟上限、vite-plugin-mock 越界导入不虚报覆盖、矛盾 hint 条件化、WS 超帧 1009+protocol_violation、React/Vue 五对共享抽取 worker 77→32%、vue26-cli 路由/layout 真实浏览器测试） | `1c30ce4..r5-fix1`（5b7ec7c、21325ac、9780cac、95d33ba、cdb2081、d7e760c、cb5127d、ae55e3e、1fae9b8、ad54efd） | `r5-fix1` | typecheck 0；check-line-length 通过；连续 3 次 `npm test` 全绿：515/515 常规（~17.4s）+ 94/94 重量级（~129s）；`npm run build` + `pack-check` 通过（554 文件/2382.2 KiB）。详见 `docs/r5-fix-report.md` |

### 2.1 R4（[`r4-plan.md`](r4-plan.md)；首版收尾，随后 T 阶段）

| ID | 事项 | 状态 |
| --- | --- | --- |
| R4-1 | 结构化调试日志取代 lastError（P2-8） | ✅ 测试通过（da39dab；a908e62 补上真实密钥脱敏：env 值+nonce 双侧产品接线测试） |
| R4-2 | Host 缓存回收（P2-9） | ✅ 测试通过（d8166b5；snapshot-retention.test.ts、runner-client.test.ts） |
| R4-3 | pageText 采集降频（P2-10） | ✅ 测试通过（17dc14a；browser-page-text.test.ts） |
| R4-4 | 删除 core 转发层（P2-5） | ✅ 机械项，无新增测试需求；全量回归通过（a908e62，525/525） |
| R4-5 | 一次性探针归档（P2-7） | ✅ 机械项，无新增测试需求；全量回归通过（a908e62，525/525） |
| R4-6 | 文档整理（P2-6） | ✅ 文档项，无新增测试需求；全量回归通过（a908e62，525/525） |
| R4-7 | 清理过时 TODO | ✅ 机械项，无新增测试需求；全量回归通过（a908e62，525/525） |

### 2.2 R3（[`r3-plan.md`](r3-plan.md)；代码已完成，T 阶段测试后改 ✅）

| ID | 事项 | 状态 |
| --- | --- | --- |
| R3-0 | 适配器特性声明取代 ID 分支（P2-3） | ✅ 测试通过（e76fa63；adapter-features.test.ts） |
| R3-1 | 未命中请求汇总 + fixture 草稿 | ✅ 测试通过（46693dd；unmatched-log.test.ts、fixture-draft.test.ts、session-registry.test.ts） |
| R3-2 | 场景重新加载/切换（refresh 带 scenario） | ✅ 测试通过（8a06cb2；scenario-reload.test.ts、runner-session.test.ts；worker 内部细节留 T-工具链 E2E） |
| R3-3 | 项目已有 Mock 只读识别 | ✅ 测试通过（f7d4815；project-mocks.test.ts） |
| R3-4 | 影响分析（只读候选） | ✅ 测试通过（change-tracking、impact-rank-analyzer、static-impact、vue-impact、impact-service、turn-tracker） |
| R3-5 | 轮次触发 smart | ✅ 测试通过（trigger.test.ts、runner-session.test.ts、session-registry.test.ts） |
| R3-6 | 面板建议与未命中区块 | ✅ 测试通过（panel-suggestions.test.ts） |
| R3-7 | 发布准备（pack-check、limitations） | ✅ 干净 build + pack-check 通过（442 文件/1812.7 KiB；DSH profile 安装验收属 Aesc 实机清单） |

### 2.3 T 阶段清单（`docs/r4-plan.md` §4）

- 🟡 `TODO(test:*)` 锚点：绝大多数已清零；baseline 锚点已在 R5-9 实测清偿：
  - （已清偿，R5-9）`src/core/change/baseline.ts:53`——合成 30k 文件树全扫 ~294ms、
    100/250ms 预算分别约扫 9.9k/26k 文件后降级；保留 1500ms（约覆盖 15 万文件），
    测定值写入常量注释。真实业务样本复核仍在实机清单。
  - （已清偿，R5-0c）`src/adapters/vue/vite/worker.ts` 场景更新失败面：`invalidateAll`
    缺失如实回绝不换绑、编译失败 ack stale、`docBuild` 不随 HMR 变化——vue3-self-contained
    真实工具链三例实测（`vue-vite-runtime.test.ts`）。
  - （已清偿）`src/adapters/vue/cli/worker.ts` 场景更新分支：2026-11-03 按 Aesc 决策放行
    CLI scenario 后已可达，入口重写/编译失败 stale/原子换绑均由 toolchain-scenario-cli
    三套 spec 实测（CLI 无 docBuild 概念，对应项为 stats.hash→servedBuild）。
- ✅ 偶发 `cleanup_failed` 根因修复（8ab7006，zombie 进程表条目，见 §1 说明）。
- ✅ 调试日志脱敏接真实密钥（a908e62）：Host/Runner 双侧 env 值 + 回传 nonce，
  `channel-secrets` 内部 IPC 只进脱敏密钥集；产品接线测试各一条。
- 🟡 真实工具链闭环：`tests/unit/toolchain-scenario.test.mjs` 覆盖「草稿→填写→refresh→切场景→候选→inputs-changed」，Vue 3 Vite 在 macOS + Linux Docker `node:24-slim` 均通过（6185ce1；Linux 证据归档至
  [evidence/2026-11-03-linux-toolchain-scenario.md](evidence/2026-11-03-linux-toolchain-scenario.md)，HTTP/进程级，未用 Chromium 浏览器侧）；
  **Vue 2 CLI 腿场景链路已跑通**（`toolchain-scenario-cli.test.mjs`，2026-11-03 Aesc 决策放行
  CLI scenario，方案 §0.3 第 11 条）：vue26-cli/vue27-cli/vue26-cli4 三套 spec **3/3 通过**
  （macOS arm64，[evidence/2026-11-03-cli-toolchain-scenario.md](evidence/2026-11-03-cli-toolchain-scenario.md)）——
  带场景 open（handlers/bodyFile）→未命中草稿→填表 refresh 生效→切场景（换绑/未命中清空/
  入口真实重写等编译落盘）→影响分析候选→inputs-changed 重建供出新代码；失败路径覆盖
  config_invalid、config_changed_needs_approval、bodyFile 局部 500、编译失败 stale 不谎报。
  带 `route` 的场景仍拒 `unsupported_capability`（navigation 不放开）。CLI 场景数据经临时入口
  注入 mount-vue2 为入口级证据；浏览器侧挂载画面未验。
- 🟡 能力等级：`scenarioReset` 在已验证 Vite 组合为 `supported`（HTTP 级 coverage 如实标注，`applyViteEvidence`）；`refresh` 2026-11-03 按 Aesc 决定退回 `unknown`（`mode: 'hmr'` 保留，reason 如实标注 HTTP-only；浏览器实测应用后再升回）；CLI 侧全项保持 `unknown`；Tier 1 profile `verified` 仍待完整 UI 库矩阵。
- 🟡 CLI worker 同步修复：`previewOrigin` 改取真实监听源（fixture 缺省 origin/remote 同源判定与 Vite 一致）；产物请求在 `invalid→done/failed` 编译窗口等落盘后重查（与文档读同策略），不再把窗口期当 `unmatched_request` 404。
- ✅ 任务 C（2026-11-03）：已配置 `runtime.setup` 漏掉入口样式导入时给出非阻断诊断
  `setup_missing_styles`（新码登记 `shared/errors.ts`，方案 §4.2/limitations §5 同步）。
  检查范围：入口 `parseEntryRegistrations` 的 style-import 注册项 vs setup 文件本身及其
  深度 1 本地模块的 module 引用，说明符解析复用 `resolveModuleSpecifier`（自
  `entry-replay.ts` 提取共用，规则不变）；措辞 "may be missing"，最多列 5 条余计
  "and M more"，hint 指向移除 setup 或补导入。测试 `vue-preflight.test.ts` 新增 2 例
  （全漏/部分漏/全覆盖/深度 1 覆盖/未配置 setup/别名比对/列表截断），18/18 通过
  （macOS arm64）。未验：真实业务项目的 setup 形态（间接链更深会误报"may be missing"）。
- ✅ 任务 D / R5-0a（2026-11-03，决策 P-A 已实现）：open 返回 `pageText: ''` 的根因是
  **采集时机**而非渲染失败。复现（`tests/unit/taskd-pagetext.test.mjs`，macOS arm64 +
  headless Chrome 156 + 自包含 Vue 3.4.27/Vite 5.2.12）：setup.install 先 `await import()`
  时，open 返回的 pageText 为 ''（或字段缺省——首帧上报与 inspect 存在竞态，两者同为
  "无挂载后文本"）、targetMounted=unverified；2.5s 后 status 的 pageText 为
  真实页面文本（观测仅晚 ~88ms），mounted 信号随后到达。链条：bootstrap 在
  DOMContentLoaded 立即 sendText（body 未挂载→''）→ `waitForMount` 在 documentLoaded
  落地即返回（"不等首次渲染文本"是 2026-11-03 既定决策）→
  open inspect 只拿到挂载前观测。R5-0a 按决策 P-A 修复：Runner 为证据补 `at` 时间戳，
  Host（`src/host/page-text.ts`）只投影可证明为 mounted 后的观测；无挂载后文本时非终态
  open 结果带 `page_text_pending` 诊断（hint 指向 `page_preview_status`），不等待、不伪造。
  测试改名 `open-pagetext-timing.test.mjs` 断言新语义，新增 `open-pagetext.test.ts`。
- ✅ `npm run typecheck` 0 错误；`npm test` 526/526/0 跳过（macOS arm64，Node 24.13.1）；
  `npm run build` + `node scripts/pack-check.mjs` 干净（442 文件，1831.4 KiB）；
  `git diff --check` 干净；`check-line-length` 通过。
- 🟡 整理交 Aesc 的实机清单（DSH desktop 面板建议、未命中区块、轮次触发、调试日志位置、overview/web 只读复核、`docs/evidence/` 归档）。
- 另修复 E2E 暴露缺陷：快照缺 `scenario` 字段导致切场景后 status/面板谎报旧场景名（6185ce1）。

### 2.4 交 Aesc 的实机验收清单（需要真实 DSH/业务项目，本环境均未执行）

1. DSH desktop 安装本轮构建（pack-check 产物）后：面板建议区块（最多 3 条、selector/关系链/证据强度/来源、不可点击）与未命中区块（按数量排序、dropped 并入 label）在 overview/web 上复核。
2. `--dsw-alias-*` 主题变量与 DSH 主题联动；`openInBrowser` 只打开既有 URL。
3. 轮次触发：smart 模式下真实 turn/end 后既有预览收 inputs-changed、无预览只出建议；off/always 对照。
4. overview/web 只读复核：识别/计划/影响分析不执行项目代码、不写项目文件。
5. 真实业务项目上的影响分析候选正确率（改样式/共享组件后的建议是否命中预期页面）。
6. 项目 Mock 识别（已有 handlers/fixtures 的项目）与 fixture 草稿在真实 DSH 面板/工具输出中的呈现。
7. 调试日志 `<dataDir>/logs/*.jsonl` 在真实 DSH profile 下的落盘、脱敏与意外失败 hint 指向。
8. Vue 2 CLI：场景链路已在本环境三套真实工具链实测通过（toolchain-scenario-cli，见 §2.3，
   HTTP/进程级）；实机侧仍待验收：DSH desktop 上真实 Vue 2 CLI 业务项目的场景切换画面、
   props/setup 数据在浏览器 Vue 2 运行时的真实挂载、整页重载体验。
9. 任务 D 实机核对：真实 DSH 侧边栏下确认「open 返回 pageText=''、稍后 status 出真实文本」
   与复现一致；确认业务项目的 mounted 信号最终到达（区分"挂载晚"与"渲染失败"——前者只需
   status 复核，后者应有 runtime-error 诊断）；Aesc 业务项目若采用方案 A，验证标注字段在
   工具输出中的可读性。

### 待 Aesc 确认

1. （已替代，R5-0e）R5 轮授权以 `docs/r5-plan.md` §2「本轮授权（Aesc 2026-11-03）」为准：
   允许新增测试用工具链（清单入 `docs/toolchains/`、精确版本、装到 `tests/toolchains/`、
   由 `install-toolchains.mjs` 幂等安装）；对外契约新增按 AGENTS.md §7 同步、既有字段语义不变。
   仍禁止：新增插件运行时依赖、升级 DSH、push、发布、在任何 DSH profile 中安装插件、
   访问 Aesc 的业务项目。
2. R2-P0-4：是否授权在独立的 DSH profile 中安装插件并重启？
3. 能否提供一个真实的 Vue 2 + Element UI 项目，作为只读的业务样本？（本轮没有 → 决策 S：
   element-ui 保持 `verified: false`，其余矩阵用测试工具链补齐）
4. （已决，2026-11-03 Aesc）`refresh` 退回 `unknown`（`mode: 'hmr'` 保留，HTTP 级证据
   不证明浏览器端已应用）；`scenarioReset` 保持 `supported`。refresh 升回条件：
   浏览器实测页面已应用新版本。

## 3. 授权边界（持续有效）

- 本地提交已获授权。不推送、不发布、不调用可能计费的模型、不升级 DSH、不修改目标业务项目、不自动给业务项目安装依赖。
- 已批准并安装的依赖：
  - typescript 5.9.3、parse5 8.0.1、yaml 2.9.1、semver 7.8.5；
  - `@deepseek-ai/dsh-user-approval@0.2.1-rc.5`；
  - `tests/toolchains/` 下的六套测试工具链（vue26-cli、vue26-cli4、vue27-cli、vue3-resolvers、vue3-self-contained、vue3-unverified-vite6）。
- 原生产品安装和重启需要单独授权（见第 2.3 节"待 Aesc 确认"第 2 条）。
- 所有执行项的批准都必须来自用户的可信确认路径，Agent 不写入批准记录。
- overview/web 只能只读使用：不启动、不修改，也不读取它的 `.env`。

## 4. 发布风险

- 锁定的 DSH 包精确依赖 zod 4.4.3，存在已知的内存耗尽告警（GHSA-mrhx-c7xc-m3w5，`zod <4.6.6`）。R5-9 调查结论：本插件直接依赖与整条 `@deepseek-ai/*` 0.2.1-rc.5 链均含受影响版本，`npm audit fix` 无兼容修复（会装 `undefined@undefined`）；`next` 标签即锁定版 0.2.1-rc.5，`alpha` 线 0.2.2-alpha.3 已重构掉 dsh-tools 的 zod 直接依赖但属 alpha。保持 pin 不升级；评估边界见 `evidence/2026-10-31-parser-dependencies.md`，登记见 `docs/r5-blockers.md` §2。
