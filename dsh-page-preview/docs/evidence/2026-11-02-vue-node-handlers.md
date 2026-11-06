# Vue 产品场景的 Node handlers

2026-11-01：公开 Vue 场景已接入已批准的项目 handler 数组。Host 只读解析路径和字节；代码在该预览独占的 Vite worker 内按原路径导入，依赖解析和模块缓存遵循原 Node 规则。没有新增依赖或修改业务项目。

## 执行与数据

沿用已有 scenarios.<name>.handlers 和 businessPaths。fixtures 先匹配，handler 按声明顺序处理剩余请求，未命中返回 404/unmatched_request。handler 通过 HttpRequestInfo 和 ScenarioStore 实现项目自己的写读语义；插件不从路径猜 CRUD，也不为 Node 模块自动注入业务身份。没有改动 handler 导出或响应契约。

预检和加载器共用 resolveHandlerModule，核对真实应用/依赖范围、文件和 Node JS/TS 扩展，拒绝环境文件及其别名。选中 handler 的字节进入 sources 与 scenario 指纹；执行批准继续绑定项目全部 setup/handlers 的路径、内容、归属和命令/env。

Vite 配置和插件 hook 完成后，worker 在 handler import 前通过专用 IPC 请求 Root 复核。Root 核对登记 PID、启动阶段和已选 handler，只受理这次启动的一个请求，然后检查当前可信批准、配置/源文件/工具链/场景计划及取消/期限，才发送 handlers-verified。该消息是执行复核答复，不是用户批准，不带 Agent approved 参数或新批准记录。首次批准仍来自官方 ApprovalService，运行样本中的答复是临时隔离测试合成。

构建配置改写 handler 的真实回归在 import 前返回 config_changed_needs_approval，模块 marker 不产生。Root 检查期间取消同样不导入，等待中的 worker 和临时资源被回收。导出非数组/含非函数启动失败为 config_invalid；运行异常和非法响应是 500，原始错误/query/body 不进入公开诊断。模块自身副作用不是安全沙箱可回滚的内容，插件不会覆盖业务文件来假装恢复。

## 验证

macOS arm64 / Node 24.13.1 / Vue 3.4.27 / Vite 5.2.12 / plugin-vue 5.1.4 / IAB Chrome 156。实际检查输出：

```text
npm run typecheck  # exit 0
npm run build      # exit 0
ℹ tests 308
ℹ pass 308
ℹ fail 0
ℹ skipped 0
```

6 项新增测试覆盖只读字节/场景指纹、公开 Node TS→HTTP 写读删除、拒绝批准零分配、配置求值改写 handler、非法 CJS 导出和 Root 复核期间取消；私有协议拒绝附带批准字段。既有独立加载器的 mjs/ts/cjs 样本继续通过。项目原错误/原值不进入模型诊断，响应策略头保持自有值。

编译完整 apply→实际锁定 SDK→Root→worker 的 HTTP 样本，Host <pid> / Root <pid> / worker <pid> / port <port>；真实 POST→GET→DELETE 后读回初始值，一次合成确认、重复打开复用、13 个样本源文件在启动/编译请求前后不变。记录 output/vue-node-handlers-compiled/public-observations.json 与 cleanup.json。

编译版真实浏览器样本，Host <pid> / Root <pid> / worker <pid> / port <port>。原组件按钮保存后显示 Saved by original UI，再次读取相同值，删除后显示 empty；初始场景/文件 fixture 继续可见，公开 status 的服务/文档/目标三层 proven、state ready，freshness 仍 unverified。记录 output/vue-node-handlers-browser-final/ready-status.json、handler-saved.png、handler-deleted.png、browser-state.txt 与 cleanup.json。

首次浏览器样本在打开标签前超过 30 秒目标期限，按设计 failed 并清理服务，没有冒充 ready；复测明确配置自有验收期限 300 秒。所有样本 Host/Root/worker/端口、临时目录与账本已独立确认消失，没有操作用户 DSH profile 或依赖来源项目。浏览器成功标签已关闭，首次连接失败的临时标签随工具会话清理。

## 范围

仅扩展已验精确 Vue 组合的初始 scenarioApply 证据。所有 network coverage 仍 none，默认 mock-only 仍在分配前阻断；HTTP Mock 不控制 Node 任意出网、其他进程、WS/SSE/Worker/SW。scenarioReset 仍 unsupported；P1-4 后场景变化自动停旧启新并如实报告重启语义。静态初始 HTTP fixtures 后续已接（见 static-initial-scenarios.md）；静态初始化/handlers、Native 产品/实际用户确认、其他框架版本和组件库矩阵继续待验。
