# 已知限制与故障排查

> 对外说明用。只写有证据的结论；每条限制注明依据（方案章节、样本记录或诊断码）。
> 口径以 `docs/development-progress.md`、`tests/fixtures/README.md` 与方案 §0.3 为准。

## 1. 支持矩阵

「通过」仅指 `tests/fixtures/README.md` 登记为通过的精确组合；未列出的组合照常执行、能力标 `unknown`、附 `unverified_toolchain` 诊断，不代表支持声明。

- Vue 3.4.27 + Vite 5.2.12 + plugin-vue 5.1.4（macOS arm64 + IAB Chrome 156）：SFC、TS、目标断言、初始场景、导航、受控网络、Node handlers、devServer 接管、自动刷新均为逐项样本验收（README 第 19–29 行）；不代表完整 UI 库矩阵、角色重置或全部网络通道通过。
- Vue 2.6.14 + cli-service 4.5.19/5.0.9 + Element UI（macOS + headless Chrome）：编译、入口重放、Vuex/vue-router、wds v3/v4、devServer 接管、`.env*` 拦截逐项验收（README 16–18 行）；profile `verified` 仍 false。
- Vue 2 CLI 场景链路（open/refresh 带 `scenario`、fixtures、Node handlers、原子换绑、编译失败 stale）：vue26-cli/vue27-cli/vue26-cli4 三套工具链 HTTP/进程级实测通过（README 23 行，`docs/evidence/2026-11-03-cli-toolchain-scenario.md`）；浏览器侧画面未验，能力保持 `unknown`。
- Vue 2.7 + TS + ant-design-vue 1.x：babel-plugin-import 按需重写、less 主题变量、devServer 接管逐项验收（README 17 行）；`verified` 仍 false。
- static（无构建 HTML/JS）：原文件 HTTP 生命周期、初始场景、目标断言、多页样本通过（README 9、33–34 行）。
- existing-server / project-command：attach 与已批准 project-command 的路由、观察/脱离、托管停止通过（README 11 行）。
- React 18.3.1 + react-dom 18.3.1 + Vite 5.2.12 + plugin-react 4.7.0（macOS arm64 + headless Chrome）：`createRoot().render` 入口静态重放（Provider 链保序、Router→MemoryRouter、叶组件替换）、声明路由 initialEntries、Fast Refresh、antd ConfigProvider/MUI ThemeProvider 主题逐项验收（README 27 行）；不代表真实业务 React 项目、webpack/CRA、React 19 或 Tier 2 组件库矩阵。

## 2. 平台

- macOS arm64：全部实测基准。
- Linux：Docker `node:24-slim` + Chromium 156 的 E2E 面通过（见 progress/AGENTS §2）；非 Docker 的 Linux 未验。
- Windows（2026-11-10 起列入支持范围，**未实机验收**）：进程表与启动时间走 CIM `Win32_Process`、监听归属走
  `Get-NetTCPConnection`（PowerShell 5.1），组归属按「组长后代 + 创建时间一致」判定（无进程组）；带 IPC 的
  worker 先断开 IPC 优雅退出，宽限期后逐个 `TerminateProcess`；无 IPC 的项目命令只能强制终止；`.cmd/.bat`
  经 `cmd.exe /d /s /c` 启动，参数含 `%`、`"` 或换行时如实拒绝；子进程环境补 `SystemRoot`/`TEMP` 等 OS 位置。
  解析与判定有合成单测（`tests/unit/winproc.test.ts`），PowerShell 调用每次约数百毫秒，停止/对账比 POSIX 慢；
  中间进程已退出的孙进程无法再归属（与 POSIX 的 setsid 逃逸同类），计为无法覆盖。能力按 `unverified_toolchain`
  如实保持 `unknown`。

## 3. 首版明确不做的事

- React 之外的框架（Svelte/Angular）、webpack/CRA 的 React 项目、SSR/RSC、跨应用导航、完整角色 reset、Tier 2/3 组件库 verified 声明（Tier 2 仅冒烟通过，按方案 R5-8 不标 verified）。
- 截图/无障碍树交给模型：锁定版 `dsh-client-ui-sidebar-browser` 无截图/捕获 API（R5-5 实测类型核对），`captureCurrentView` 保持 `unsupported`；不以 `ImageBlock` 伪造。
- `trigger: always` 的实际 auto-open：`turn/end` 无执行审批上下文（D2），只产出 `unsupported_capability` 意图记录。
- 面板一键打开建议页：已实现（R5-6，D2-b）——建议行携带 `open` 载荷（projectId + JSON 选择器），经 `pagePreview/open` 远程方法进入与工具 `open` 同一路径；执行项指纹审批仍走官方弹窗，拒绝/不可用如实 `needs_configuration`，不跳过。
- Node 进程出网控制（`network coverage` 仍 `none`，默认 mock-only）。

## 4. 数据与网络

- 默认 `mock-only`：未命中的业务请求明确 `unmatched_request`（404），不转发真实后端、不返回空对象（方案 §0.3 第 5 条）。
- `page_preview_status { previewId, detail: true }` 返回按 (method, origin, path) 聚合的未命中列表与 `fixtureDraft` 草稿（R3-1）；草稿带 `placeholder` 标记，需 Agent/用户填真实数据，占位标记未清除的场景会被 `config_invalid` 拒绝。
- 项目已有 Mock 设施（vite-plugin-mock/mockjs/msw 等）只读识别并经 `project_mock_detected` 报告，插件不 import/执行它们（R3-3，D1）。
- `.env*` 一律不读不写；vue-cli 项目经 `service.loadEnv` 拦截不进入预览进程（README 17 行验收）。
- `turn/end` 影响分析只读：不执行项目代码、不进 `.env*`；`impact_incomplete` 表示分析降级。

## 5. 常见诊断码与下一步

| 码 | 含义 | 下一步 |
| --- | --- | --- |
| `unmatched_request` | 业务请求无 fixture/handler | `status detail` 取 `fixtureDraft`，填入场景 `fixtures` |
| `config_changed_needs_approval` | command/env/setup/handlers 指纹变化或运行中收到执行输入变更 | 用同一配置重新 `page_preview_open` 走用户审批 |
| `preview_needs_restart` | 构建配置变更无法就地生效 | 停止后重新 open |
| `unverified_toolchain` | 版本组合无样本证据 | 照常执行；结果如实看浏览器 |
| `unsupported_capability` | 明确不支持的能力/操作 | 换方案或显式目标；不支持 auto-open 时手动 `page_preview_open` |
| `project_mock_detected` | 检出项目自有 Mock | 参考现有数据边界写 fixture，不依赖其执行 |
| `setup_missing_styles` | 已配置 setup 可能漏掉入口样式导入（只读静态核对，"may be missing"） | 移除 `runtime.setup` 走自动重放，或在 setup 中补导入这些样式 |
| `impact_incomplete` | 影响分析部分降级 | `suggestions` 仍可用但可能不全；显式 `target` 打开不受影响 |
| `config_invalid` | 配置违反 schema/占位标记未清 | 按 hint 修配置 |
| `page_text_pending` | open 返回时尚无挂载后的页面文本观测（早于挂载信号的首帧文本不作页面文本） | `page_preview_status` 稍后读取最新观测；不是渲染失败的证据 |
| `cleanup_failed` | 资源回收对账失败 | `page_preview_stop { previewId, recover: true }` 按账本清理 |
| `preview_busy` | 会话 updating 中 | 等待落定后重试或刷新 |

## 6. 故障排查

- 预览 `busy`：`updating` 中并发请求被拒；inputs-changed 通知排队到更新落定，等 refresh/scenario 更新完成再操作。
- `cleanup_failed`：`page_preview_stop { previewId, recover: true }` 按账本重试回收；`residual` 列出无法核对归属的残留。
- 审批策略 `never` 且非完全访问会话：插件如实提示无法批准，Agent 不得绕过（§0.3 第 9 条）。
- 插件 `dataDir` 缺失/不可写：open 报 `config_invalid`；在 `cordis.patch.yml` 配 `dataDir` 为可写绝对路径。
- DSH 设置界面改写 `cordis.patch.yml` 会丢 page-preview 条目：重跑插件安装或手工补回 patch 行。
- 构建产物 `lib/` 过期（改了 src 未重build）：`npm run build` 后重启 DSH；`node scripts/pack-check.mjs` 可核产物齐备。
- 面板无建议/建议为空：`turn/end` 分析未运行或会话已释放（`suggestions` 字段缺失属正常）；改动不在任何配置应用根内时不产生候选。
- 意外失败排查：runtime_error 诊断的 hint 给出调试日志路径。Host 写 `<dataDir>/logs/host.jsonl`，Runner 写 `<dataDir>/logs/runner-<工作区 sha256 前 16 位>.jsonl`（单行 JSON，2MB 滚动单份 `.1`）。日志与诊断同一脱敏策略；写失败时 hint 如实说明日志不可用。
