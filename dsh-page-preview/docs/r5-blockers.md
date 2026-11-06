# R5 阻塞清单

按 `r5-plan.md` §6 登记：每条含子项 ID、现象、已尝试、需要谁做什么、对能力等级的影响。
阻塞项不阻塞检查点推进；对应能力等级按证据如实保持 `unknown` 或 `unsupported`。

## 1. 需要 Aesc / 真实 DSH / 真实业务项目

| 子项 | 现象 | 已尝试 | 需要谁做什么 | 能力影响 |
| --- | --- | --- | --- | --- |
| R5-5 截图到模型 | 锁定 SDK `dsh-client-ui-sidebar-browser` 无 iframe/webview 截图或捕获 API | R5-5 类型核对：ImageBlock 存在但载体侧无采集通道；不伪造 | DSH 提供载体截图 API，或 Aesc 实机确认是否有未登记通道 | `captureCurrentView` 保持 `unsupported` |
| R5-9 干净 DSH profile 安装 | 插件在隔离 DSH profile 中加载/启用未验 | `npm pack` 干净目录安装 + 导出加载验证通过（R5-9，见 §2 备注） | Aesc 授权后在隔离 profile 安装并重启验证 | 实机验收缺项，不影响代码侧证据 |
| R5-9 resume 语义实测 | DSH 会话恢复后 `turn/end` 事件流无实测 | 按锁定 SDK 类型核对：seed 事件不发布到 `session/event`，`firstLiveSeq` 为界——恢复历史 turn 不会重建重复基线（`turn-tracker.ts` 注释） | 真实 DSH profile 中 kill→resume→触发 turn，核对 tracker 行为 | turn 追踪在 resume 场景为 `unknown` |
| R5-6 面板一键点击 | 面板按钮→`pagePreview/open`→官方审批弹窗在真实 UI 中未验 | panel-service/session-registry 单测覆盖投影与审批接缝；真实审批路径由 project-command.test.mjs 的 ApprovalService+open turn 覆盖 | Aesc 实机点击面板建议行的打开按钮 | 面板交互体验 `unknown`；工具路径已验 |
| overview/web 实机验证 | 真实业务样本（Vue 3.4.27 + Vite 5.2.12 + antdv/element-plus）仅只读识别 | phase0 只读核对（不启动、不读 `.env`、不修改） | Aesc 决定是否在受控条件下打开预览；启动需先定执行授权、最小子进程环境、受控网络策略 | 业务样本验收缺项；verified 声明不依赖它 |
| Service Worker 在 DSH 载体 iframe | DSH Browser iframe/webview 中 SW 注册能力未验 | headless Chrome 的受控响应层已验（vue-network fixture）；载体差异不套用 | DSH 载体中实测 SW 注册/注销 | MSW 类项目 Mock 执行路径为 `unknown`，如实 `unsupported` 时按诊断报告 |

## 2. 已解决（本轮内闭环，登记备查）

- **干净安装缺 peer（R5-9）**：`lib/host/session-registry.js` 运行时引用
  `@deepseek-ai/dsh-llm` 的 `ToolCallId` brand 函数，但该包此前只经 dev 链传递、未声明。
  已按锁定版 `0.2.1-rc.5` 补入 `peerDependencies`/`devDependencies`；干净目录默认解析
  peers 安装后 `dsh-page-preview`、`/typert`、`/remote` 均可加载（导出 3/9/9）。
  `client.js` 为浏览器侧产物（依赖 `window`），不以裸 Node import 验证。
- **zod 4.4.3 审计告警（R5-9）**：GHSA-mrhx-c7xc-m3w5（`zod <4.6.6` 受限集合内存耗尽）。
  本插件直接依赖与整条 `@deepseek-ai/*` 0.2.1-rc.5 链均含受影响版本；
  `npm audit fix` 会装 `undefined@undefined`（无兼容修复）；`next` 标签即锁定版
  0.2.1-rc.5，`alpha` 线 0.2.2-alpha.3 已重构掉 dsh-tools 的 zod 直接依赖但属 alpha。
  结论：锁定线无修复版本，保持 pin 不升级，登记为发布风险。
- **baseline 时间预算与诊断条数（R5-9）**：`DEFAULT_TIME_BUDGET_MS` 实测保留 1500ms
  （合成 30k 文件树全扫 ~294ms，预算约覆盖 15 万文件）；`MAX_DIAGNOSTICS` 保留 8
  （React 工具链实测诊断 ≤8，在方案建议 5–10 内）。测定值已写入代码注释。
