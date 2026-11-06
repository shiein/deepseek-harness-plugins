# 静态页面初始 HTTP 场景

2026-11-01：static 公开工具链已接显式初始场景的同源 HTTP fixtures、范围校验文件响应和未命中诊断。它继续服务原 HTML/JS/CSS，无业务替代页、真实后端转发或业务源码修改。

## 处理规则

沿用 schemaVersion 1 的 scenarios.<name>.businessPaths/http。fixture/handler 必须有显式业务范围，支持整段 * 和末尾 **；此路径拒绝跨源 fixture。static 与 Vue 共用 inspectScenarioFixtures，只构造中间件校验并读取响应文件哈希，不启动服务或执行 handler。实际读取继续共用 readScenarioBodyFile 的应用/声明依赖根和环境文件边界。

static 当前只接 HTTP 数据。identity/permissions/state/props/locale 没有浏览器初始化绑定时明确不支持；Node handlers、额外初始化和视口也继续拒绝。route 仍按已有具体静态导航规则处理，不因为场景自动放宽文件/路由约束。

计划保留原 requirements，包括默认 mock-only。同源 HTTP 有 fixtures 时 browser-http 标 mock；其余已验静态浏览器通道保留原 CSP block，build/server-process 仍 none（没有执行业务构建或服务端代码）。不把这项证据推广到 Vue 或 Native。场景文件内容同时进入 sources/scenario 指纹，Runner 在启动前重新只读核对计划。P1-4 后场景变化改为自动停旧启新：旧预览完整清理后启动新预览，preview_restarted 诊断如实说明「状态不保留、不代表身份隔离」；scenarioReset 仍 unsupported，不做就地重置，不清用户 Cookie/Storage。

请求顺序固定为真实资源文件→显式业务 Mock→适用的 SPA 导航回退→404。业务范围内未命中在 Mock 中明确失败，不能被 Accept:text/html 或 SPA fallback 掩盖。已有静态文件不会被同名 fixture 替换。静态写响应返回配置数据，并明确提示不会修改后续读取的存储；没有推导 CRUD 或伪造持久化。

## 验证

macOS arm64 / Node 24.13.1 / IAB Chrome 156，编译完整插件与锁定 DSH SDK 0.2.1-rc.5。实际输出：

```text
npm run typecheck  # exit 0
npm run build      # exit 0
ℹ tests 312
ℹ pass 312
ℹ fail 0
ℹ skipped 0
```

3 项新增回归覆盖只读 fixtures/文件与来源限制、数据字段拒绝、源/场景指纹、真实 HTTP/SPA 顺序、原文件优先、畸形 body/静态写提示，以及公开 SDK/Root 的同计划复用、场景变化自动重启（preview_restarted 诊断）和停止清理。共用预检后的 Vue/Node handlers 回归继续通过。

编译完整入口→实际 SDK ToolRuntime→Root→原静态页→浏览器：Host <pid> / Root <pid> / port <port>。页面显示 Static fixture: Offline rows，未命中按钮显示 404，写响应显示 201，重新读取仍是 Offline rows；公开 status 有 unmatched_request 和静态写 unsupported_capability，query 不进入诊断。服务/文档/目标三层 proven、ready，freshness 仍 unverified。记录 output/static-initial-scenes-browser/ready-status.json、fixture-interaction.png 和 browser-state.txt。

浏览器标签已关闭。结束时自动审批一度因额度无法执行停止操作；恢复后重新核对，记录的 Host/Root 身份和端口均已消失，未发送信号。随后对资源账本按现状对账，确认无残留后移除精确匹配的自有临时工作区；独立证据见 cleanup.json。不把该样本的延迟收尾当成正常 stop 路径证据；正常公开 stop 的证据来自上述实际 SDK 回归。

已有配置保持兼容，handlers 和浏览器初始化字段没有隐式降级。fixture 文件仍按请求时的真实范围读取；此实现不证明数据文件编辑后的画面/源码对应，也不提供场景切换或持久状态重置。其他 Vue 版本/组件库、完整网络通道、Native 产品 Client 和真实业务样本继续待完成。
