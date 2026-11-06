# Vue 公开手动预览接入

2026-11-01：产品 registry 和 RunnerController 已接 `vue-vite`。公开 `page_preview_open` 经同一只读 Planner、执行确认、独立 Root、每预览 worker 运行原 SFC；Host 不调用 start。Runner 共用注册表核对策略和进程类型，不另维护三种通用适配器的分派清单。

当前 scope/独立渲染证据仅用于 macOS、Vue 3.4.27 / Vite 5.2.12 / @vitejs/plugin-vue 5.1.4、默认导出的 JS/TS SFC、component/page 范围。`SUPPORTED_VITE` 精确填写 `5.2.12`，不扩展到同一主版本的其他版本。Probe 仍只提供候选；完整 plan 通过目标/初始化检查后才应用这些证据。shell、非默认导出、其他版本/平台仍 unknown；CLI 不注册为可执行适配器；所有 UI profile 不变。

网络通道仍全部 none。因此默认 mock-only 返回 needs_configuration，不分配 Root、不执行配置、不弹执行项确认；工具参数不能覆盖默认约束。当前运行验收使用自有样本保存的 requirements 空数组，再显式要求 isolated-target。没有修改真实项目的保存配置或批准记录。

显式 setup/styles 只在 Vue 路径通过，其执行批准仍来自官方 ApprovalService 的用户答复，批准前不分配 Root。拒绝、无答复或确认期间 setup 字节变化均阻止运行。Runner 在 worker 启动后再次核对批准和直接源/config/toolchain 指纹，然后才发送 start；取消/撤销/直接目标变化会回滚本次账本资源，不先执行配置。传递依赖图尚不完整，不把这些直接指纹当成全部源码新旧证据。

后续目标初次就绪断言已接通，见 `target-assertions.md`；没有断言时目标挂载仍为 unverified。场景/路由/视口仍明确拒绝。自动 HMR 已有浏览器证据，手动 refresh 操作尚未接通，capability 保持 unknown。截图/真实 Agent loop/产品 Client 与原生载体仍待接入。没有把服务可达或浏览器 mount 消息当作 ready/current。

## 实际验证

macOS arm64、Node 24.13.1、IAB Chrome 156.0.0.0；全部样本位于临时目录，借用显式已安装工具链，不启动其来源业务项目或读取其 `.env`。

- typecheck/build 退出 0。显式 `DSH_PREVIEW_TEST_MODULES=<已有工具链的绝对 node_modules 路径> npm test`：tests 274 / pass 274 / fail 0 / skipped 0。新增 3 项真实公开 SDK 测试、版本/导出范围和启动后源字节变化回归；相关真实测试无显式工具链目录或非 macOS 时会跳过。
- 自动化覆盖：`tests/unit/vue-vite-public.test.mjs`（"public Vue open executes reviewed setup/styles only through owned Runner workers and preserves truthful evidence"、"Vite config cannot publish a preview after changing previously approved setup bytes"）与 `tests/unit/setup-write-approval.test.ts`（官方确认接缝）。原编译烟测 `scripts/verify-vue-public.mjs` 已随 R4-5 删除；历史记录（合成用户答复下 Root <pid>→worker <pid>，port <port>，9 个原样本文件不变，stop/卸载后全部自有资源清理）在 `output/vue-public-compiled/`。
- 同脚本加 `--serve` 的编译浏览器验收：Host <pid> / Root <pid> / worker <pid> / port <port>。真实 TS SFC 显示，点击计数 1；document-loaded 经 worker→Root→Host 回到公开 status 为 proven。自有样本编译错误后公开 status 为 stale 并含 compile_error，恢复后显示 `adapter-public-recovered` 且计数仍 1；freshness/targetMounted 均 unverified。截图 `output/vue-public-browser/recovered.png`，加载/失败/恢复状态与独立清理记录均在该目录。标签已关闭，3 个进程、端口和整个临时样本目录实际消失。

这次交付是有限版本的公开手动执行链，不能作为完整 Vue 隔离、mock-only、UI 组件库矩阵或首版验收。下一步仍按完整进度表推进场景/Mock、其他 Vue 组合、Client 及后续阶段。
