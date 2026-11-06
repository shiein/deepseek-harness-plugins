# 桌面客户端与 overview 样本接续记录

2026-10-31。结论：DSH 原生桌面的 Host→Client 开页、刷新、关闭已通过；overview 可作 Vue/Vite 业务样本，不能充当方案 §14 要求的非 Vite 样本。Phase 0 整体仍未完成。

## 桌面客户端

本机安装 `/Applications/DeepSeek Harness.app`，版本 `0.2.1-rc.5`；安装包内运行时为 Electron `44.7.0`、Chrome `152.0.7977.130`、Node `24.21.0`。此前联动证据来自内置 CLI 的 web profile + Chrome 156，不能用于证明原生 Browser 行为。

实际完成了全新临时 `DSH_HOME` 和 Electron `--user-data-dir` 的桌面启动、profile 初始化，以及官方 CLI 将本地 `dev/bridge` 链接到该临时 desktop profile。该隔离步骤未修改用户现有 profile、未复用用户登录状态、未调用模型。运行路径和日志仅留在忽略目录 `output/phase0/desktop`；日志中的启动认证地址不得提交或展示。

原生 Browser 的 SDK 源码使用 Electron 页面载体；不能把 web iframe 的 origin、Cookie、CSP 或截图结论直接套用。`browserWorkspace` 为 Workspace 会话选择 `cwd:<path>`，为未分组会话选择 `session:<id>`，所以探针不需要额外登记 Workspace。一次试验中新增的 Workspace controller 开发依赖及接入代码已撤回，没有保留第二条控制链路。

界面工具按 bundle ID 只定位到原有用户窗口，无法可靠选择第二个独立实例。用户随后明确要求使用当前打开的客户端，工作改为官方插件页的本地目录安装，不再以退出原客户端为前提。

已通过当前客户端安装、启用第一个本地快照，组件页显示运行中；随后已通过官方界面卸载。固定会话没有标题，不便定位，探针新增了确定性标题 `Page Preview Phase 0`，使用 SDK 的 `sessionTitle.rename`，不调用标题模型。仅增加同版本 `dsh-session-title` 开发类型依赖，运行时使用 DSH 已加载的服务。

带固定标题的快照最初被自动审批拒绝；用户随后明确确认安装并运行，已通过当前客户端完成安装和启用。仅检查本探针的投影记录，确认标题已生效，但 `sessionListMetadata.blank` 仍为 `true`。锁定版本 `dsh-client-ui-workspace` 源码的 `sessionVisible` 会隐藏未选中的 blank 会话；因此标题不能让它出现在侧栏或搜索中。没有向会话写入聊天消息，也未启动模型来绕过这个限制。

已卸载上述快照。Client 探针修订为通过官方 `uiWorkspace.openSession` 选择固定 SessionId，再由原来的 mounted 订阅执行载体操作；仅增加同版本 Workspace Client SDK 开发类型。用户又明确确认了修订快照 `output/phase0/desktop-package-1793406572244`，已通过当前客户端安装、启用。

用户批准后，已按原 profile 退出并重新打开客户端一次，未切换或清理 profile。重启后仍未导航。通过发行版 F12 打开前端 DevTools，在 Sources 中确认实际加载了带 `uiWorkspace.openSession` 的修订代码；断点证明 `apply`、Remote `$mount` 和命名空间注入回调均执行。此前对同名包路径缓存的怀疑不能解释这次失败，未将其登记为 SDK 缺陷。

实际错误是 `sessions.retain: unknown session page-preview-phase0-carrier`。锁定版本 Session Controller 的 `resolveTarget` 会拒绝尚未进入 Client 目录的会话；Remote 已挂载不代表目录已同步。探针现在先等待官方 `sessions.refresh()`，成功后才安装 mounted 订阅并导航。目录失败直接使启动失败，不用延时猜测或吞错。仅增加 `dsh-api-session-controller@0.2.1-rc.5` 开发类型，运行时使用既有服务。协议类型也不再引用 Host 类，避免把 Host/Client 两种同名 `sessions` Context 接口带入同一类型检查。

已更新已安装探针的 Client 产物并从 DevTools 刷新当前页面，没有再次重启应用或重装包。随后原生会话自动选中，Host 的三次命令均收到 `accepted`，静态服务的 `document-loaded` 计数从 6 增至 8。记录为 `output/phase0/native-current/carrier-observations.json`，校验脚本 exit 0：

```text
Host→Client: open/refresh/close accepted; 2 actual document loads; target readiness unverified
```

该记录只证明真实文档加载和载体 API 联动；不证明业务页面 ready、原生 Cookie/存储、真实 HMR、当前画面截图或模型图片能力。没有导出或复制用户 Cookie、Storage、凭据，没有调用真实模型。Console 的粘贴保护出现后保持启用；调试使用 Sources 断点，没有执行 Console 代码。测试结束已移除断点、恢复执行、关闭 DevTools，并通过官方插件页卸载探针；用户客户端保持运行。

测试进程清理按精确 PID、启动时间和父子关系核对，静态服务、隔离 web Host 与测试浏览器共 10 个进程均已退出，残留为 0；58074 与 3080 均无监听。未停止用户原生客户端。

当前客户端复现顺序：

1. 构建 `npm run build:phase0-bridge` 并开启独立静态探针服务，记录其 loopback origin。
2. 执行 `node tools/probes/prepare-phase0-desktop.mjs <origin> <绝对输出目录>`。脚本只在忽略目录生成独立快照，包含明确的 origin/output 配置和 Browser 启用层；不安装、不写用户 profile。
3. 用户确认安装该本地代码后，在当前客户端“插件 → 添加插件”填入脚本打印的目录并启用。无需让正在运行的客户端继承新的环境变量。与安装要求完全退出的 CLI 路径区分。
4. Client 等待会话目录同步后，通过公开导航 API 打开固定测试会话，不依赖侧栏展示 blank 会话；不输入提示词。探针只对该会话发出操作。若无操作，先核对实际加载的 Client 和启动错误，不把 Host 运行中当成 Client 生效。
5. 运行 `node tools/probes/verify-phase0-bridge.mjs <记录路径>`，验证三次载体操作与两次真实文档加载。另行核对原生 CSP、存储、HMR 和截图能力，不继承 web 结论。
6. 通过官方插件页卸载本轮探针，停止自己创建的服务；不清理用户 Cookie/Storage、不停止现有客户端。

已执行检查：`npm run typecheck` exit 0；`npm test` 为 tests 30、pass 30、fail 0、skipped 0；`npm run build` 与 `npm run build:phase0-bridge` exit 0。新增回归覆盖目录延迟期间不导航、目录失败时不安装流也不导航。HTTP/进程单测需要沙箱外的 loopback 监听和 ps 权限；沙箱内首次运行因 EPERM 失败，未修改测试绕过，获执行权限后全部通过。

## overview 只读核对

用户指定路径为 `/Users/aesc/Documents/workspace/overview`，实际前端应用根是 `web/`。只读取了 manifest 与构建配置，未读取 `.env`、启动项目、安装依赖或修改其已有工作区改动。

| 项目 | 源码中的值 |
| --- | --- |
| 框架与构建器 | Vue `3.4.27`、Vite `5.2.12`、plugin-vue `5.1.4` |
| UI 与状态 | Ant Design Vue `4.2.5`、Element Plus `^2.13.3`、Pinia `2.1.7` |
| 已声明启动脚本 | `localhost: vite --mode localhost`；`dev: vite` |
| 本地依赖目录 | 已存在；未执行安装 |

配置注明浏览器使用绝对 API 地址直连业务后端，开发服务器默认监听 `0.0.0.0:<port>`；配置还把 `process.env` 整体放入前端 define。启动方案必须先明确执行授权、最小子进程环境和受控网络策略，不能直接继承 Host 环境或把实际后端访问当作默认预览行为。

overview 目前仅完成识别，不是适配器通过证据。用户随后明确要求在 workspace/demo 自建非 Vite 模拟项目；该样本已完成原生载体的接入、刷新和脱离探测，记录见 `phase0-non-vite-demo.md`。真实业务样本和产品适配器验收仍独立保留。
