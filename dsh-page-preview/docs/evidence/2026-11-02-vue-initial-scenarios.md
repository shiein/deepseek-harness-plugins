# Vue 初始场景与 HTTP fixtures

2026-11-01：公开 Vue 路径已接显式/目标默认场景选择、初始 props、经 reviewed setup 传递的场景数据和同源 HTTP fixtures。目标仍是原文件/原组件，没有生成业务替代页、平行权限判断或真实后端转发。

## 配置与执行

ScenarioConfig.businessPaths 与该场景的 http/handlers 一起保存，JSON Schema 从同一结构生成，schemaVersion 保持 1。当前 HTTP fixtures 必须有显式范围，支持整段 * 和末尾 **，不猜 /api；跨源 fixture 仍明确不支持。文档/模块/真实资源优先走原受控资源路径，其他请求才进入已声明的业务 Mock；未命中明确 404。

```json
{
  "props": { "title": "Example scene" },
  "businessPaths": ["/api/**"],
  "http": [
    { "method": "GET", "path": "/api/value", "response": { "status": 200, "bodyFile": "preview/value.json", "headers": { "Content-Type": "application/json" } } }
  ]
}
```

identity/permissions/state/locale 必须有显式 runtime.setup 绑定和至少一个初始化 hook，空 setup 不冒充已应用，原权限语义由业务模块继续执行；props 直接传入原目标。浏览器只接需要的场景数据，不复制 Node handler 路径、业务范围或整个 HTTP fixture 集合。setup.install/createContext/applyScenario 在目标动态 import 之前执行；服务 Mock 在发布地址前已就绪。

响应文件由 Host 预检与 worker 使用同一 readScenarioBodyFile 核对真实范围，环境文件/别名不读取，二进制字节不转成文本。源指纹和场景指纹均绑定 fixture 文件内容；声明文件在计划前缺失或变化，不用空对象替代。HTTP 运行异常回传安全诊断码和有界 pathname，query/body 与原始项目错误不进入工具诊断。模块/fixture 不能覆盖自有 CSP/CORS/cache/frame 策略；普通自定义响应头保留。

通用 Planner 现在要求实际 scenarioApply 能力，而非只把场景名称放入计划。P1-4 后 RunnerWorkspace 对场景名称/数据指纹变化一律先完整清理旧预览再启动新预览（自动停旧启新），preview_restarted 诊断如实说明「状态不保留、不代表身份隔离」；就地 scenarioReset 仍 unsupported，没有用换端口/worker 假装清空 Cookie 或 Storage。

## 执行复核修正

新增真实失败用例复现：Vite 配置求值时改写了刚批准的 setup，旧实现仍发布 reachable 地址。Root 现在分配前、worker 执行前、配置加载/端口登记/认证探针完成后各复核一次，再返回 URL。最后一次同时复核当前批准和直接源/config/toolchain/场景指纹；该用例现为 config_changed_needs_approval/failed，拥有资源为空。项目配置自身的副作用不是 Node 沙箱能回滚的内容，本插件不覆盖业务文件来伪装恢复。

## 实际验证

平台：macOS arm64 / Node 24.13.1，Vue 3.4.27 / Vite 5.2.12 / plugin-vue 5.1.4，IAB Chrome 156.0.0.0。

- typecheck/build、JS 语法与 JSON Schema 同源检查通过；显式已有工具链目录运行完整 tests 302 / pass 302 / fail 0 / skipped 0。
- 新回归覆盖通用场景能力门槛、只读业务范围/文件与场景指纹、源文件/环境别名、公开 fixture/bodyFile/未命中、P1-4 后不同场景及同名数据变化自动停旧启新（preview_restarted 诊断：状态不保留、不代表身份隔离）、配置求值后批准变化。构建器通过 server.headers 试图覆盖 CSP/CORS 的真实请求仍保留自有策略和普通自定义头。
- 编译完整 apply→锁定 SDK→Root/worker→浏览器：Host <pid> / Root <pid> / worker <pid> / port <port>。原 TS SFC 接收到 title、身份/权限/state/locale；项目自己的 canRead 函数返回对应 UI。setup 的初始 HTTP seed 完成后才导入目标，随后读到文件 fixture；三层 proven/ready，freshness 仍 unverified。计数可增至 1，缺失接口显示 404，公开诊断只含 /api/missing，没有 query。记录 output/vue-initial-scene-browser/ready-status.json、interaction-status.json、scene-ready.png、cleanup.json。
- 最终编译版另做一次完整入口/HTTP 烟测：Host <pid> / Root <pid> / worker <pid> / port <port>，12 个样本源文件在启动/编译请求前后不变，相同指纹一次合成确认/同预览复用，公开 stop/卸载清理完成。记录 output/vue-initial-scene-compiled/public-observations.json。无浏览器时目标仍 unverified，不冒充 ready。
- 浏览器标签均关闭，两个样本的 Host/Root/worker/端口/整个临时目录与账本均已清理。未修改或启动依赖来源 overview 项目，也没有读取其 .env。用户答复仍是隔离样本中的官方服务合成答复，不是实际用户/Agent loop 验收。

## 剩余边界

后续项目 Node handler 已接产品 Vue 场景，紧邻 import 前经专用 IPC 等待 Root 当前批准/计划复核，见 vue-node-handlers.md。静态初始 HTTP fixtures 后续已接（见 static-initial-scenarios.md）；静态初始化/handlers、完整上下文/角色切换、路由/视口、其他网络通道、Native Client 和组件库矩阵继续待实现/验证。所有 network coverage 仍 none，默认 mock-only 仍在分配前阻断；运行样本保存 requirements 空数组，并额外要求 isolated-target。该阶段不是完整 Mock 或首版完成。

最终绑定 hook 检查/场景指纹版本另做同一浏览器复验：Host <pid> / Root <pid> / worker <pid> / port <port>，三层 proven/ready、交互和 query 脱敏均通过；记录在 output/vue-initial-scene-final-browser/ready-status.json、scene-ready.png、cleanup.json，全部自有资源已独立确认清理。
