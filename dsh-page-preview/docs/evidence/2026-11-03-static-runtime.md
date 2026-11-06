# 原文件静态运行时

对应方案 §6.1、§6.6、§6.8、§9.2。static.start 已提供原文件 HTTP 服务，内部 Host→Runner 执行与真实 probe/discover/plan 已接通；公共 open 尚未接通，不代表静态预览产品路径全部完成。新预检见 [静态预检](2026-11-03-static-preflight.md)，下文检查数量是分项历史结果。

仅返回 publicRoot 内已有的 HTML/JS/CSS、JSON、图片/字体/WASM；点文件、越界链接和未知请求明确失败。路径规则共享于 shared/config/paths.ts，core 原路径保留兼容出口，避免 Host/Runner 各自维护一份范围规则。没有修改目标文件、转发后端或生成替代页面。

响应沿用既有 CSP/bootstrap/nonce 通道。监听后先登记端口，核对实际 PID 并请求私有归属探针，才发送 serviceReachable。只有匹配目标 URL 的 document-loaded 才作为文档证据；不从 HTTP 200 推断 targetMounted 或 freshness。nonce 留在私有响应/探针，进入诊断前脱敏。

显式 spaFallback 只作用于 HTML 导航且无资源扩展名的路由；参数/query 保留，Unicode 文件可访问。缺失 JS/CSS 不返回 index。当前场景、目标断言、额外 entry/styles 和文档 export/route 绑定均明确不支持，不通过忽略它们制造成功。当前帧策略仅 self；原生顶层载体可复用此前机制，web iframe 联动尚未接入。

5 项真实 HTTP 测试已通过，包含原始多页内容、脚本顺序、CSP、实际监听、重复停止、点文件/越界/畸形输入、nonce/目标校验、SPA 与 Unicode，以及登记期间取消回滚。环境 macOS 15.7.7、Node 24.13.1；未验证平台不宣称支持。测试使用临时原文件副本，浏览器目标断言与真正 Host/Client 集成尚未据此验收。

本项提交前实际输出：typecheck/build/diff 检查退出 0；`npm test` 为 `tests 110; pass 110; fail 0; skipped 0`。

后续 Host 接入补充：源码和编译产物分别从 src/browser 与打包后的 browser 读取 bootstrap，避免源码运行依赖旧构建产物。`tests/unit/runner-client.test.ts` 与 `tests/unit/static-runtime.test.ts` 已验证产品 static.start 在独立 Runner 中服务原文件和清理。原编译烟测 `scripts/verify-host-runner.mjs` 已随 R4-5 删除。载体、目标挂载和 freshness 未被 HTTP 烟测推断为通过，详见 [Host/Runner 验收](2026-11-03-runner-ipc.md)。

2026-11-01 诊断边界修正：实际本地 HTTP 合成上报复现了 static 将 runtime-error/unhandled-rejection.message 和 CSP blockedURI 原值直接放入公开诊断。nonce 脱敏不能去掉错误中的业务数据或 URL query。现在与 Vue 路径一样只发安全的静态诊断及本地浏览器检查提示；保留 runtime_error/blocked_request 和阶段，原始错误/堆栈/source/被拒 URL 不进入模型可见结果。没有改动 reporter 或内部 BrowserReport 契约，不新增日志存储原始值。

新增失败回归在修改前确实因 SYNTHETIC_PRIVATE 出现在诊断而失败，修改后通过；包含三种已认证上报和错误码/可用提示验证，服务、端口与账本由真实停止清理。macOS arm64 / Node 24.13.1；typecheck/build 退出 0，完整 tests 309 / pass 309 / fail 0 / skipped 0。这里实际验证的是 HTTP 回传到诊断的边界，没有把合成上报当成真实浏览器生成异常或 Native Client 验收；页面错误采集的浏览器证据仍以此前独立记录为准。

后续静态初始 HTTP 场景已接公开 SDK/Root 和编译完整入口/IAB 原页面，真实资源文件优先、业务 Mock 先于 SPA 回退、未命中明确 404，静态写响应如实提示无存储修改。静态浏览器数据初始化/handlers 仍拒绝，详见 [静态初始场景](2026-11-02-static-initial-scenarios.md)。
