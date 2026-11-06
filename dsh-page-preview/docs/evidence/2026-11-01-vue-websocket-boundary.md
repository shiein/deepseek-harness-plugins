# Vue 自有 HMR 与 WebSocket Upgrade 边界

2026-11-01：真实样本复现了一个独立于 HTTP 中间件的入口。Vite 项目插件可在自有 HMR HTTP server 上注册 upgrade listener；请求 /api/socket 时，原实现会返回 101 并进入该业务 listener。HTTP fixtures 和文档 CSP 不能阻止同源 WebSocket 走这条路径。因此不能只凭 HTTP 404 就宣称所有浏览器连接都已受控。

## 修正

自有 Node server 在已核对 Node 24 API 线上使用 shouldUpgradeCallback，在任何项目 upgrade listener 之前决定准入。仅允许 GET、固定 /__dsh_page_preview__/hmr、websocket/vite-hmr 协议、实际监听端口的 Host 和匹配的同源 Origin。拒绝的 Upgrade 回到既有 HTTP 边界，返回 403/blocked_request，不进入项目 callback、资源编译或业务 Mock；诊断只保留有界 pathname，不含 query/nonce。

Vite 的 HMR server/path/host/clientPort/protocol 由自有服务维护，保留 hmr:false，不沿用指向其他地址的 HMR 参数。原编译插件、模块图和 Vite WebSocket 实现继续工作，没有引入第二套 WS 代理或服务。createServer 返回后复核实际 HMR 绑定，项目 hook 改变绑定时明确失败。私有 worker IPC 接受现有 blocked_request 码；两端需同包一起构建，无外部工具字段/schema 或批准记录迁移。

本地 @types/node/http.d.ts 把该原生选项标为 since v24.9.0；代码只在 24.9+ 的 Node 24 线上启用。其他 Node 线没有据此声明 Upgrade 控制。实际运行证据仅为 macOS arm64 / Node 24.13.1 / Vue 3.4.27 / Vite 5.2.12 / plugin-vue 5.1.4；不是 Node 24 所有补丁、其他 OS 或 Native Browser 的验收。

## 实际测试

修正前，真实项目 listener 用合法 WebSocket 握手返回 101，回归明确失败；修正后同请求返回 403，listener marker 不存在。异源/缺 Origin、错误/缺协议、异 Host 和原项目 HMR 路径均拒绝；自定义远端 HMR 参数不进入生成客户端；合法同源 HMR 返回 101。禁用 HMR 时保留禁用并拒绝握手。专用诊断不含合成 query 值，停止清理通过。

实际输出：

```text
npm run typecheck  # exit 0
npm run build      # exit 0
ℹ tests 318
ℹ pass 318
ℹ fail 0
ℹ skipped 0
```

新增 3 项回归，2 项为真实拥有进程/端口与原生 Upgrade，1 项仅检查版本门槛；没有安装新依赖、业务后端或模型调用。

## HMR 浏览器复验

编译完整 apply→锁定 SDK→Root→worker→IAB Chrome 156：Host <pid> / Root <pid> / worker <pid> / port <port>。

- 原 TS SFC 挂载并通过三层就绪；真实按钮计数从 0 到 1。
- 一次同时修改模板和样式时，原 Vue 插件走组件 reload，计数重置为 0。锁定插件 isOnlyTemplateChanged 要求 style 块未变化，源码与实测一致；没有人为恢复状态或把这种组合说成保留全部状态。
- 重新设置计数 1 后，分别修改模板和 CSS。原页面更新到 upgrade-hmr-revision-3，CSS border 为 rgb(17, 136, 102)，计数仍为 1；客户端有真实 hot updated 消息。
- 制造模板缺失 end tag，旧画面保留、公开 status 仍记录初次 ready 但 freshness=stale 且含 compile_error。修正为可见新版本 upgrade-hmr-recovered-4 后更新恢复，计数 1，freshness=unverified。没有把恢复事件伪造成 current，也没有再次伪造目标证明。

记录 output/vue-owned-hmr-upgrade-browser 下的 stale-status.json、recovered-status.json、after-template-css.png、compile-failure-view.png、recovered.png、browser-state.txt 与 cleanup.json。标签、Host/Root/worker/端口、临时目录与账本已独立核对清理。只据 UI 计数、真实热更新事件与公开状态记录刷新行为，未采到独立文档加载次数，不声称该计数已有单独验证。

## 未覆盖项

此项是同源 HMR 例外和业务 Upgrade 的边界修正。后续 HTTP/SSE、Worker/Service Worker/子文档和项目代理的精确浏览器组合已有补充记录（vue-browser-network.md），Native/其他组合与服务端通道仍待验；Vue network coverage 仍全部 none，默认 mock-only 保持拒绝。已有 Node handlers 不因此获得进程禁网，选中它们时还需 server-process 控制。没有约束 Node/构建插件任意出网，不是 OS 沙箱或完整 WS 业务模拟；Native 产品、Client 与完整场景 reset 继续待验。
