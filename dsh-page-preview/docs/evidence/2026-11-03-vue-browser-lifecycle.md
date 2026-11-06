# Vue 浏览器挂载与生命周期

2026-11-01：实现浏览器 startVuePreview 编排及 Vue 3 两步挂载。该运行时已经真实 Vue SFC 验证；公开 vue-vite/vue-cli 适配器、Runner 分派与产品 Client 仍未接通。

顺序为显式网络准备 → 动态框架加载 → 创建 Vue 3 app → 动态 setup → install → createContext → applyScenario → 动态目标 → mount → nextTick → target-mounted。要求 Mock 时，模板缺少 mockReady 就失败，不把 CSP 或 Promise.resolve 当成 Mock 实现。target-mounted 只是挂载证据，不自行生成 Runner ready。

Vue 3 的根组件在 setup 前创建；rootOptions 以根组件 mixin 在首次 mount 前填入，目标 render 和可选 Provider 保持由运行时管理。install 的返回值按本次挂载交给 createContext/applyScenario/dispose。原骨架 createPreviewApp(Target, options)/mountVue3 改为 createPreviewApp() 返回 app/mount/unmount 控制器；当前无发布消费者或配置迁移。Vue 2 只增加项目构造函数及 nextTick 导出以接同一编排，原挂载主体未改，尚未真实验收。

取消、准备失败、缺失导出和无效 setup 不产生挂载信号；初始化失败也调用适用的 dispose。停止先卸载框架再 dispose，清理失败明确返回原始错误集合并可重试。成功停止后重复调用不清理后续挂载。新增 body 直系节点只在本次自有隔离文档内回收；已有节点内部的残留由 setup.dispose 处理，不操作 Cookie/Storage，不用于 attach。

## 本次证据

- 平台：macOS arm64，Node 24.13.1，Vue 3.4.27，Vite 5.2.12，@vitejs/plugin-vue 5.1.4，JS SFC。浏览器为 IAB；本轮工具未提供内核版本，不能据此宣称原生 DSH 或其他内核通过。
- 独立探针 PID <pid>，端口 50466；仅复制 tests/fixtures/vue3-vite-no-ui-kit 和浏览器 helper 到自有临时目录。复用 overview/web 的现有依赖，但 configFile/envFile 均 false、cacheDir 在临时目录；没有加载其配置/业务入口、读取 .env、安装依赖或修改来源项目。
- 实际显示原 Target.vue、props、全局注册组件、globalProperties、app.provide、根 mixin provide 和 Provider。初始化顺序由样本断言及 target-mounted 回传共同核对。
- 点击计数到 1；模板 revision-1→2、CSS 边框颜色 #246→#842 均热更新，计数保持 1。模板编译错误保留原画面；恢复至 revision-3 后计数仍为 1，编译错误采集 1 次，期间同一 PID、仅 1 次 document-loaded。
- Stop 移除目标与 setup 加入的自有弹层；Restart 再挂载且计数归零。累计 target-mounted 2 次，运行错误/未处理拒绝/CSP 违规 0 次。样本 requirements=[]，只作为观察，不宣称业务 Mock 或完整网络隔离。
- 页面已关闭；按 PID+启动时间+账本核对后 SIGTERM。实际进程/端口/临时目录消失，账本为空。
- 自动检查：新增 6 项编排回归，完整 tests 247 / pass 247 / fail 0 / skipped 0；typecheck/build 退出 0，浏览器 JS 通过 Node 语法检查。

本地原始证据：output/vue-browser-runtime/verified.json、observations.json、cleanup.json、recovered.png、remounted.png（忽略输出，不入包）。自动化覆盖：`tests/unit/vue-browser-lifecycle.test.mjs`（启动编排状态机）与 `tests/unit/vue-vite-public.test.mjs` 真实 headless Chrome 用例（"default mock-only plans mount the target in a real browser"、"freshness reaches current only when the browser proves the latest build is applied"、"a source syntax error forwards compile message/file/line/frame, marks stale and never leaks env values"）。原复现入口 dev/vue-browser-probe.mjs 与受控修改脚本 scripts/vue-browser-step.mjs 已随 R4-5 删除；探针只接受固定版本现有依赖，改源前核对临时目录账本和进程身份。

剩余：原生 DSH、Vue 2.6/2.7、Vue CLI、TS 和 Tier 1 库，实际 Mock/场景切换、公开适配器/Runner/Client、编译诊断与 freshness 管线。样本探针不代替产品链路，不填写 SUPPORTED_VITE 或 verified=true。
