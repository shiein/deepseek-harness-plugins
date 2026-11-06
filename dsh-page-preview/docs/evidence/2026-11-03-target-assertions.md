# Vue 目标就绪断言

2026-11-01：公开 Vue 预览可以使用目标配置中的 selector-visible/text-present 判断初次目标就绪。计划会附加 mount-signal；全部断言在同一浏览器检查中通过，服务/文档证据也已通过时，RunnerSession 才进入 ready。无断言的观察路径保持原来的 unverified 行为。

受控响应层把断言和有界目标期限注入普通 JS bootstrap。DOM 加载、框架 mounted 及每 100 ms 检查一次，成功、期限到达或 pagehide 时停止计时器。选择器至少有一个已连接且有布局矩形、未被 display/visibility/零透明度隐藏的元素才通过；无效选择器返回未通过。text-present 使用 body.innerText 的包含关系，不宣称完整无障碍树或像素级文本可见性。没有采集或回传 DOM/文本原值。

浏览器新消息 `assertions { url:string, results:boolean[] }` 是同一时刻的全部结果。Runner 核对目标文档 URL、数组长度与声明一致，且全部为 true 才产生目标证明；不累计不同时间的单项成功。旧 assertion/target-mounted 消息不能替代配置断言；声明了断言时原始 mounted 消息不会覆盖完整断言证据。消息沿原同源认证、nonce 脱敏、专用 worker IPC 传播。旧单项 assertion 结构仍接受但不作为该路径的证明，同一版本两端须一起构建。

这项能力验证初次挂载，不是持续 DOM 监视或源码对应证明；成功后停止轮询。HMR 的编译成功和画面新旧仍遵守原有 unverified/stale 规则。后续静态路径也已接同一逻辑，见 `static-target-assertions.md`；CLI/attach/project 路径尚未开放断言。场景/路由/视口、pageText、手动 refresh 和 Client 仍待实现。

## 实际验证

- macOS arm64 / Node 24.13.1；typecheck/build 退出 0，bootstrap `node --check` 通过。
- `DSH_PREVIEW_TEST_MODULES=<显式已有工具链 node_modules> npm test`：tests 279 / pass 279 / fail 0 / skipped 0。新增 4 项实际 bootstrap 脚本 VM/证据测试覆盖挂载前/异步文本、隐藏元素与祖先、无效 CSS、错长/错类型/不同时刻的结果、无配置及有界计时器。另有真实公开 SDK/Root/worker 测试：目标期限 200 ms 且未收到证明时最终 failed/target_not_ready，拥有的服务账本为空；open 返回已受理 ID 不等于已就绪。
- 自动化覆盖：`tests/unit/session-registry.test.ts`（"public open waits for proven readiness when the plan carries target assertions"，真实 open→static 链路 + HTTP 注入上报）与 `tests/unit/browser-assertions.test.ts`（bootstrap DOM 断言 VM 用例）；真实 headless Chrome 挂载由 `tests/unit/vue-vite-public.test.mjs`、`tests/unit/vue-cli-public.test.mjs` 覆盖。原 `scripts/verify-vue-public.mjs --serve --assertions` 已随 R4-5 删除；历史记录：Vue 3.4.27 / Vite 5.2.12 / plugin-vue 5.1.4、IAB Chrome 156.0.0.0；Host <pid> / Root <pid> / worker <pid> / port <port>，真实 TS SFC 挂载、article h1 可见、Real adapter target 文本同时满足，公开 status 三层 proven/ready、freshness unverified，点击计数到 1。记录 `output/vue-assertions-browser/ready-status.json` 和 `ready.png`。
- 浏览器测试标签已关闭；公开 stop/卸载后独立核对 Host/Root/worker/监听端口与整个临时样本目录消失，账本为空。清理记录：同目录 cleanup.json。批准仍为官方服务的自有临时合成答复，不代表真实 Agent/用户界面或原生 DSH 验收。
