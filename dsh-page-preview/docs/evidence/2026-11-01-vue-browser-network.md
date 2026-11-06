# Vue 浏览器网络组合与资源准入

2026-11-01，macOS arm64 / Node 24.13.1 / Vue 3.4.27 / Vite 5.2.12 / plugin-vue 5.1.4 / IAB Chrome 156.0.0.0。编译完整 apply→锁定 SDK→Root→独立 worker，使用插件自有临时源码和 loopback 计数后端；仅借用 overview/web 的已安装依赖，未启动或修改业务项目，也未读其 .env。

## 失败基线与修正

初次组合样本中，页面跨源请求被阻断、后端零命中，但 Worker/SharedWorker/Service Worker 脚本均为 404，本地 iframe 超时。模块图尚未登记由字面 URL 创建的 Worker；资源准入只包含 script 等类型，漏掉 worker/sharedworker/serviceworker。Vite middlewareMode + appType:custom 也不会自动返回子 HTML。不是所有探针都通过，页面的 finished 仅表示检查结束。

现有文件解析共用真实路径/允许根/MIME 边界，新增这三种脚本请求类型。iframe/frame 的现有 HTML 单独经过原 Vite transformIndexHtml，响应保留自有 CSP，不注入父目标 bootstrap/reporter/断言。未知文件、点文件、越界路径和没有资源证据的普通请求继续明确 404，不交给项目代理，也不把所有同源 URL 当资源。没有增加路由或任意顶层文档准入。

公开 SDK 真实进程回归修改前 404≠200，修改后通过：三种脚本 JS MIME/CSP、子 HTML/CSP/无父上报、无 destination 的未知脚本和 /api/proxy、/.env 拒绝、源文件散列不变及停止清理。失败基线还暴露测试后端晚于 fixture 清理的问题，已用 finally 先关闭它；此前挂起测试按精确 PID+启动时间停止，对账后删除自有样本。

## 浏览器与实际到达证据

最终样本 Host <pid> / Root <pid> / worker <pid> / port <port>。浏览器执行结果：

| 检查 | 实际结果 |
| --- | --- |
| bootstrap 早于项目 inline hook、本地/内联 CSS、eval | 正常 |
| 跨源 fetch/XHR/WS/SSE、JSONP、图片/样式/iframe | blocked |
| 同源业务 WS /api/socket | blocked，项目 upgrade listener 未触达计数后端 |
| /api/proxy、未命中业务 SSE | 404 / blocked，无真实代理转发 |
| 同源 HTTP fixture / SSE fixture | owned-fixture / fixture-event |
| Worker、SharedWorker、Service Worker | 均执行；跨源 blocked、同源 fixture 正常、未命中 404 |
| Blob Worker / 本地子页面 | 跨源 blocked；子页面未命中 404 |
| 探针 Service Worker | 自身 registration.unregister() 返回 true |
| 计数后端所有数据/资源/Upgrade 路径 | 实际 hits={} |
| 原组件按钮与模板 HMR | 计数 0→1；模板更新后显示 revision 2，仍为 1 |

sendBeacon 返回 true 仅表示浏览器接受排队；字段为 beaconQueued，不能用它证明发送成功。真实到达以自建后端计数为准。后端计数不包含 /stats 自身；探针未通过另一个后端或真实外部服务测试。

三层初始就绪 proven/ready；模板更新后 freshness 保留 unverified，没有借 finished 或编译事件制造源码对应证明。自建后端是测试基础设施，早于合成用户确认创建；项目配置/初始化仍在确认后由产品 worker 执行，不把这一样本描述成全部基础设施批准前零分配。

实际输出：typecheck exit 0，build exit 0；完整 tests 319 / pass 319 / fail 0 / skipped 0。证据在 output/vue-browser-network-baseline 与 output/vue-browser-network-fixed：browser-results.json、ready-status.json、hmr-status.json、browser.png、hmr.png、cleanup.json。最终浏览器标签已关闭，Host/Root/worker/后端、两个监听端口、临时目录和账本均独立核对清理。

## 能力范围

这是上述精确组合的浏览器证据，未覆盖 Native Browser、其他内核、Vue 2/CLI、同源外来 SW 或离开受控来源后的文档。Vue network coverage 仍全部 none，默认 mock-only 仍在分配前拒绝；没有把自有 requirements=[] 的验证配置写入业务项目。Node handlers、构建插件和其他进程的任意出网不受此 CSP 约束，选中 handler 仍需 server-process 证据。完整角色切换/reset、视口/导航和产品 Client 继续待验，没有升级 UI profile 或扩大支持矩阵。

本次未改公开契约/schema/持久化格式；两端按同一包构建即可，无数据迁移。回滚本次代码会恢复上述 Worker/子 HTML 404；不会修改用户项目或浏览器存储。
