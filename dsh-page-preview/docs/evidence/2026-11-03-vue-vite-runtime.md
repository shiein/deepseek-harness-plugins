# Vue Vite 每预览执行器

2026-11-01：`vueViteAdapter.start` 已运行真实项目工具链，当前仅验证 Vue 3.4.27 / Vite 5.2.12 / @vitejs/plugin-vue 5.1.4。没有新增依赖；测试通过显式目录借用已有工具链，只执行自建临时样本，不启动依赖来源项目。

每个预览由 `spawnManaged` 创建独立 Node 子进程。Root 在分配前及 worker 启动后、发送执行指令前复核执行授权。worker 加载项目实际安装的 Vite 和配置，stdout/stderr 排空而不进入日志或协议；专用 IPC 严格校验，原始编译内容不进入工具诊断。监听 PID 必须等于登记的 worker，服务另需通过私有 nonce 探针。停止、取消和启动失败共用已有进程组/启动时间核对及资源账本，残留不报成功。

Vite 5.2.12 的 `loadConfigFromFile` 会在输入配置旁写 timestamp 打包文件。本实现先在自有临时目录生成引用原配置的包装文件，再让原工具链加载。样本确认原配置 `import.meta.url`/dirname 语义和别名保留，原项目无新增配置、缓存或环境文件。没有配置时仅使用已经安装且版本匹配的 Vue 编译插件，不安装或猜测插件。

最后一个自有 config hook 固定 loopback HTTP、base `/`、受控服务和临时 cache/env 目录，关闭自动 env-file 加载、自动开页及跨源源码读取。configResolved 清除原项目代理；保留实际别名、编译插件和 optimizer include。该路径会改变原服务的 base/代理等行为，已写入只读计划差异。它不限制任意配置代码显式读文件、调用 loadEnv 或出网，不能作为安全沙箱或 mock-only 证据。

自有 HTML/虚拟模块只负责加载原目标，不生成业务替代组件。Mock 准备和显式样式先于框架、setup、目标的动态导入。资源准入只查已有模块图、计划绑定的真实文件及允许的静态文件；未知请求不调用项目 resolveId，返回 `404 unmatched_request`。受控响应层提供 Host 检查、CSP、bootstrap 和报告。编译失败产生 `compile_error`/stale；编译恢复仅回到 unverified。无目标断言时挂载信号仍为 unverified，不据此宣称 ready/current。

## 验证证据

平台：macOS arm64、Node 24.13.1、IAB Chrome 156.0.0.0。

- `npm run typecheck`、`npm run build`：退出 0。
- 显式设置 `DSH_PREVIEW_TEST_MODULES` 为已有工具链的绝对 node_modules 路径后运行 `npm test`：tests 269 / pass 269 / fail 0 / skipped 0。新增 9 项覆盖协议/源码生成和真实 Vite 成功、授权缺失/撤销、mock-only 拒绝、配置异常、取消、无配置编译与 config hook 对所有权设置的影响。无显式依赖目录或非 macOS 时，7 项真实运行测试跳过；不能把跳过作为兼容证明。
- 自动化覆盖：`tests/unit/vue-vite-runtime.test.ts`（"real Vite worker preserves source/config paths, owns an authenticated listener and cleans its process/port/temp paths"）与 `tests/unit/vue-vite-public.test.mjs` 真实 headless Chrome 用例（模板/CSS/编译错误/恢复与 freshness 证据）。原 `scripts/verify-vue-vite.mjs`、`dev/vue-vite-adapter-probe.mjs` 与 `scripts/vue-vite-adapter-step.mjs` 已随 R4-5 删除；历史记录：verify-vue-vite 二次复核（Root <pid> / worker <pid> / port <port>，7 个源文件不变，假环境值未进入编译结果）在 `output/vue-vite-compiled.json`；adapter 探针（Root <pid> / worker <pid> / port <port>，真实 TS SFC、点击计数 1、revision 1→2、CSS #246→#842、compile_error→stale→恢复 unverified、唯一 document-loaded）在 `output/vue-vite-compiled-browser/`（recovered.png、verified.json、cleanup.json），Root/worker/端口/临时目录均确认消失。
- 另有源模式同样本的完整浏览器更新/恢复记录：`output/vue-vite-verified/`。此前虚拟模块、首次动态目标、Vue export-helper 请求失败已修正；自动测试请求真实 Target 及其发布的全部静态依赖，防止仅凭 HTML 200 判成功。

## 当前边界

后续公开 registry/Runner/SDK 已接入，并完成精确版本 scope 证据与编译完整入口验收，见 `vue-public-open.md`。本节下文保留本执行器初次提交时的边界；网络/场景/完整矩阵和原生载体仍未因此通过。

这次完成内部适配器执行器，尚未接产品 registry、公开 RunnerController/SDK 和 Client。候选 capability 仍 unknown、网络 none、SUPPORTED_VITE 未填写；mock-only 在分配前明确拒绝，测试 requirements 为显式空数组。默认约束没有放宽。

真实 Mock/场景、目标断言、路由/视口、批准草稿的公开操作、原生 DSH 载体、Vue 2/CLI 和组件库矩阵仍待实现/验证。所有 profile 的 verified 保持原值。不因本次 TS SFC/独立浏览器通过而宣称整个 Vue 隔离功能或首版完成。

## 显式外部依赖样式修正

后续组件库样本准备复现：runtime.dependencyRoots 已被只读路径校验接受，但未传给 Vite server.fs.allow，工作区外明确声明的主题实际返回 403。执行器现在只把相同已声明/规范化的依赖根传入 Vite，继续保留资源准入及严格 fs 检查，不自动扩大到其他目录。

自有临时 CSS/真实 Vite 回归先实际失败 403，再修正为 200、样式内容不变，停止后拥有资源回收。Node 24.13.1/macOS arm64，typecheck/build 退出 0；显式工具链全量 tests 295 / pass 295 / fail 0 / skipped 0。现有依赖元数据另核对 Element Plus 2.14.2、Ant Design Vue 4.2.5、Pinia 2.1.7，可供后续自建样本借用；尚未据此验收或修改 profile。

2026-11-01 Ant Design Vue 4.2.5 真实浏览器样本进一步暴露 pnpm 外部 reset.css 的路径编码问题：入口预先编码文件 ID 导致 Vite 生成错误 URL。现传原始模块 ID 给 Vite；回归跟随编译入口实际发布的 theme@1 space.css URL，并核对 JS MIME，修改前失败、修改后通过。真实命名 TS SFC/Provider 主题/中文 Modal 与完整 313 项检查已通过，见 [命名 SFC 与组件库部分验收](2026-11-01-vue-named-sfc-antdv.md)。

2026-11-01 自有 HMR/Upgrade 边界后续修正：真实业务 WS listener 原可绕过 HTTP 中间件返回 101，现 Node 24 原生准入先于 listener，只允许固定同源 HMR。真实握手、禁用 HMR、错误来源、编译完整入口/IAB 的分开模板/CSS更新和错误恢复通过；组合更新可能按原 Vue 编译器重挂而重置状态。完整 318 项通过，网络整体声明仍 none，详见 [WebSocket 边界](2026-11-01-vue-websocket-boundary.md)。
