# Phase 0 验证记录

日期：2026-10-31（Asia/Shanghai）。本记录只描述实际执行过的探针，不是产品支持矩阵。

环境：macOS `15.7.7 (24G720)` / arm64；DSH 桌面安装包内置 CLI 与 SDK `0.2.1-rc.5`；Host 使用内置 Node `24.21.0`；开发检查使用 Node `24.13.1`；Playwright 隔离浏览器 Chrome `156.0.0.0`。后续原生测试经用户确认使用其当前 profile，只操作固定探针会话；未使用用户业务会话、Cookie、Storage、凭据或真实业务后端。

下方响应层详细能力证据来自 **web profile**。原生桌面随后通过 Host→Client 自动开页、刷新、关闭及两次文档加载；其他原生能力不继承 web 结论，详见 `phase0-desktop-and-overview.md`。overview/web 是 Vite 项目。

## 受控响应层

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| 原插件加载 | 成功，4 个工具已注册 | `open/status/stop` 尚为骨架，未宣称完整功能可用 |
| Browser 加载 loopback | 显式启用后成功；后续 Host 联动探针也通过 | 该版本 web profile 默认禁用 Browser；产品 Registry 尚未接入 |
| bootstrap 顺序 | 页面显示“bootstrap 先于业务脚本” | 样本使用真实 HTML 与独立 app.js |
| 错误回传 | 收到 runtime-error、unhandled-rejection、document-loaded | 只覆盖受控文档 |
| CSP | 跨源 fetch 失败，收到 connect-src 违规，跨源端点命中数 0 | 请求仅指向本机另一个 origin；不代表服务端禁网 |
| 同源资源与连接 | app.js、WebSocket、SSE 可用；未登记同源请求 404 + unmatched_request | WebSocket 握手成功不代表完成真实构建器 HMR 验收 |
| Worker | 脚本响应附 CSP 后，跨源 fetch 失败 | 未验证无 CSP 的 Worker、嵌套 Worker、其他内核 |
| Service Worker | 可在专用 /sw-scope/ 注册并注销 | 尚未验证 Service Worker 内的数据访问；不能声明该通道受控 |
| 截图 | Playwright 保存整个测试浏览器截图到 output/playwright/phase0-dsh-iframe.png | 这是外部测试工具，不证明插件 captureCurrentView 能力 |

回传通道还通过真实 HTTP 回归测试：归属探针、nonce/previewId 校验、Origin 校验、消息校验、保留路径隔离、64 KiB 限制、100 次/秒限制、nonce 脱敏、消费者抛错。归属探针不返回 nonce；未知业务请求不转发。

## 复现响应层

1. `npm ci --ignore-scripts`，再运行 `npm run typecheck`、`npm test`、`npm run build`。HTTP 测试需允许本机监听。
2. `node tools/probes/phase0-server.ts 0 http://127.0.0.1:<port>`。输出随机 loopback 地址，不输出 nonce。
3. 复制 `dev/cordis.phase0.example.yml` 为被 Git 忽略的 `dev/cordis.dev.yml`，替换绝对路径。
4. 在一个新建临时工作目录运行 DSH：`DSH_HOME=/tmp/<独立测试目录> dsh web --patch /abs/path/dev/cordis.dev.yml --no-open --host 127.0.0.1 --port <port>`。不要复用真实 DSH_HOME。启动 URL 含临时令牌，只在本地浏览器使用，不粘贴到日志或提交中。
5. 使用全新浏览器上下文打开 DSH，跳过登录，打开右侧 Browser，输入第 2 步的地址。依次点击错误、网络、Worker 按钮。`GET /phase0/status` 可读脱敏回传与跨源命中数。
6. 停止两个测试服务并关闭隔离浏览器。所有样本请求都在 loopback 内；不需要模型账号或外部服务。

## 验证输出

Host 探针 `tools/probes/phase0-host-plugin.mjs` 在真实 DSH 中执行，并把结果写到被忽略的 `output/phase0/host-observations.json`。使用 Node 内置断言判定，失败记录 `error` 并使探针插件报错，不把观察当成功。

| 检查 | 实测结果 | 边界 |
| --- | --- | --- |
| 工具注册/文本渲染 | 4 个产品工具注册成功；测试 echo 值与渲染文本一致 | 没有调用尚未实现的 open/status/stop |
| 工具超时 | 60 ms 后 `TOOL_TIMEOUT` | 协作式超时，不能强制终止忽略 signal 的工具 |
| 工具取消 | 调用者 signal 中断等待并返回错误 | 尚未验证完整 Runner 取消清理 |
| 调用者身份 | exec.agent.id 与 exec.agent.session.id 一致 | 工作目录取 workingDirectory.get(session)，不能把 Host cwd 当所有会话根 |
| 写工具路径 | arguments.file_path 保留 `./…`；meta.path 为绝对路径 | 相对路径须按调用时工作目录解析；不能依据 shell 文本推断写入 |
| 实际 loop 的轮次 | 完成→completed、流失败→error、用户取消→aborted | 使用无网络脚本模型，仅替换 provider，不手工伪造 loop 事件 |
| 历史 seed | 创建 session 时不重发 seed 的 session/event | 完整持久化 resume 仍待验收 |

复现 Host 探针要**每次新建 DSH_HOME**，并使用临时工作目录。Overlay 会开启原本默认禁用的 write 工具，探针只在该临时目录创建测试文件。局部测试模型仅用于 loop 生命周期，不证明外部模型能理解截图。

响应层功能提交前：

```text
npm run typecheck  → exit 0（0 errors）
npm test          → tests 16, pass 16, fail 0, skipped 0
npm run build     → exit 0
node --check      → bootstrap、fixture JS、Host 探针通过
```

## macOS 端口与进程身份

已实现并用真实父子孙进程验证 `readProcessStartTime`、端口建议/反查、后代判定和进程树内实际 loopback 端口发现。测试占用一个端口，再让包装进程的子进程监听另一个随机端口，确认只返回子进程真实监听地址，不把占用端口上的无关服务当成本次服务。进程退出后启动时间为 undefined、监听 PID 列表为空；不按进程名或日志 URL 猜测归属。

只有 macOS 的 `/bin/ps` 和 `/usr/sbin/lsof` 路径经过验证；其他平台明确抛错。空匹配和命令/权限错误分开处理。端口建议不保留端口，也不是归属证据。后续已验证产品基础设施 `spawnManaged` 的进程组终止、取消/失败回滚、脱组残留与重复停止，见 `docs/runner-managed-process.md`；**完整 Runner/Host stop 与孤儿恢复集成尚未验收。**

此功能提交前：`npm run typecheck` / `npm run build` exit 0；`npm test` 实际输出为 tests 19、pass 19、fail 0、skipped 0。

补充 OS 行为探针：`node tools/probes/phase0-process.ts` 使用临时 Host、独立进程组中的两级服务和专用临时记录。在 Host 被 SIGKILL 后，记录文件仍在，两个服务仍监听；错误启动时间的记录被拒绝且服务未被发信号；正确记录触发 SIGTERM 进程组回收，两个监听均消失。探针退出时回收自己的数据；回收失败则保留记录并报错。

文件账本现已实现，每项资源单独写入临时文件并 rename 发布。更新后的探针实际登记两项进程和两项端口，强制终止 Host 后用新账本实例重新读取，四项均保留并报告为 residual。进程组清理后，消失的子进程和两个端口记录被移除；组长条目仍要求调用者核对整组，不能凭组长消失自动判断无残留。单测覆盖独立实例的 20 项并发登记、重新打开、重复 release、损坏记录和错误身份保留。对账本身不终止进程或删除已有路径。尚未实测 PID 实际复用、Windows/Linux、setsid 后代；完整 Runner 集成仍待开发。

实际输出：

```json
{"platform":"macOS","hostSigkill":"verified","orphanRecordSurvives":"verified","wrongIdentityNotSignalled":"verified","processGroupTerminated":"verified","fileLedgerAfterHostSigkill":"4 records preserved and reported","runnerLifecycle":"not-implemented"}
```

文件账本验证：`npm run typecheck` 与 `npm run build` exit 0；`npm test` 为 tests 27、pass 27、fail 0、skipped 0；上面的真实进程探针 exit 0。并发测试使用临时目录，未接触用户服务或业务后端。

## Host → Client 联动

2026-10-31 在同一平台和锁定 SDK 上实测 `dev/bridge` 独立包：

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| 本地包发现 | 官方 CLI 将本地包链接到全新临时 profile，Client Module 自动加载 | 未修改用户 profile、未发布包 |
| Host 主动操作 | Remote stream 发出 open、refresh、close，Client 全部 accepted | accepted 只证明载体 API 已调用 |
| 实际加载 | 服务端 document-loaded 计数由 4 增至 6，增量恰好 2 | 对应打开和刷新；不代表目标挂载或业务 ready |
| 资源所有权 | 记录并核对本探针打开的 tab ID，刷新/关闭均指向该 tab | 服务仍是独立测试进程，关闭 tab 不停止它 |
| 重复订阅 | 完成后再次订阅不发命令，已补回归测试；Client 页面重载未观察到额外目标加载 | 重载后同会话重选与断线重连仍待完整实测；不承诺产品跨重启恢复 |

使用 SDK 导出的 `createTypertRemoteInfo` 和 Loader 支持的显式 wire schema。类型、严格解析与 JSON Schema 从同一份 Zod schema 推导。没有新建 RPC 控制端口；错误通过流/探针记录暴露。动态 `$mount` 后必须用 `ctx.inject` 声明具体 Remote 命名空间，否则 Cordis 会拒绝访问。刷新使用所拥有 tab 的 `occurrence.commands.refresh`，不读取或操纵 iframe DOM。

复现步骤（`dsh` 可替换为本机锁定 CLI 的绝对路径）：

1. 执行 `npm run build:phase0-bridge`，分别检查 Host/Client 类型并构建独立包。
2. 另一个终端运行 `node tools/probes/phase0-server.ts 0 http://127.0.0.1:<port>`，记录其 loopback origin。
3. 新建临时 DSH_HOME 和临时工作目录。在该目录执行 `DSH_HOME=<临时目录> dsh plugin --profile web add /abs/path/dev/bridge`。它只链接本地探针，不改真实 profile。
4. 设置 `DSH_HOME=<临时目录>`、`DSH_PREVIEW_PROBE_ORIGIN=<第2步origin>`、`DSH_PREVIEW_PROBE_OUTPUT=/abs/path/output/phase0`，运行 `dsh web --patch /abs/path/dev/cordis.bridge.example.yml --no-open --host 127.0.0.1 --port <port>`。
5. 用隔离浏览器打开启动 URL，跳过登录，选择“未分组”里的探针会话。无需输入预览 URL，Host 会自动发出三步操作。
6. 执行 `node tools/probes/verify-phase0-bridge.mjs`。预期输出：`Host→Client: open/refresh/close accepted; 2 actual document loads; target readiness unverified`。自定义输出目录时把记录路径作为参数传入。
7. 重载 Client 并选回同一会话，确认记录仍只有三次命令、文档加载计数不再增加。停止本轮两个服务和隔离浏览器。

此功能验证输出：

```text
npm run typecheck          → exit 0
npm run build:phase0-bridge → exit 0（含独立 Host/Client 类型检查）
npm test                   → tests 23, pass 23, fail 0, skipped 0
npm run build              → exit 0
```

`src/client/index.ts` 仍是产品 Client 骨架，`open/status/stop` 尚未接入本探针。真实模型图片调用按用户要求不执行，不作为失败项或支持声明。

原生补充：同版本桌面客户端（Electron `44.7.0`、Chrome `152.0.7977.130`）在用户原 profile 中完成三步联动。Client 须等待 `sessions.refresh()` 后才能打开固定会话，否则实测会抛出 unknown session。记录 `output/phase0/native-current/carrier-observations.json` 的三次确认均 accepted，document-loaded 从 6 增至 8；校验脚本 exit 0。原生 Browser 使用 Electron webview，不是 web iframe。探针已从官方插件页卸载，调试断点已清除；用户客户端保持运行。修订验证：typecheck、两项构建 exit 0，tests 30、pass 30、fail 0、skipped 0。

## 尚未完成的判定

非 Vite 服务探测补充：用户明确允许在 workspace/demo 自建样本后，已用 Node HTTP + 原生 ESM 模拟项目完成当前原生 DSH 的直接接入、筛选、详情路由、整页刷新、关闭和重开。服务在两次关闭后均存活，样本 localStorage 筛选偏好保留，文件哈希未变；随后由启动者单独停止。详见 `phase0-non-vite-demo.md`。这是载体层证据，不代表产品 existing-server 适配器、真实业务或 HMR 验收。

HMR 补充：原生 DSH + Vite 5.2.12 + 原生 ESM 在受控响应层下通过实际更新、浏览器模块加载失败及缺失模块编译失败后的恢复；计数保持 1、文档只加载一次、PID/启动时间不变，无 CSP 违规。完整编译诊断仍须从构建器采集，不能只靠 Browser 或 vite:error。记录见 `phase0-hmr.md`，不代表 Vue/CSS HMR 或产品更新管线验收。

存储补充：原生 DSH 已验证同工作区重开保留样本 Cookie/localStorage、跨工作区 A→B→A 的样本状态隔离，以及 SameSite 的同源/跨站 fetch/顶层导航行为。跨端口 Cookie 共享而 localStorage 分离，不能把换端口当作身份隔离。详见 `phase0-storage.md`；每个 preview 独占身份、其他存储通道、web iframe 和应用重启仍未验收。

Phase 0 尚未通过。待验证：生产 Runner 生命周期/账本恢复，以及托管静态预览与已有服务脱离的完整工具链；持久恢复等剩余边界按具体模块验收。非 Vite 服务接入、有限 HMR 和原生 Cookie/localStorage 边界已有证据，真实业务样本留待兼容性验收。图片能力按用户决定保留未验证；本轮未发起真实模型请求。

Phase 1～2 的工作量需在这些探针结束、选定两个真实业务样本后再估算，目前没有充分依据给出可信数字。未通过项不自动触发方案降级。

2026-10-31 用户已批准 `phase0-host-client-dependencies.md` 中的直接依赖清单，已按固定版本安装。用户同时决定暂不调用真实模型，图片能力继续保留未验证；不将这个决定记为图片能力测试失败。
