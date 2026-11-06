# 静态目标断言与文档绑定

2026-11-01：静态原文件预览接入相同 bootstrap/证据函数，保留配置中的 selector-visible/text-present。初次 DOM 断言全部通过且服务、目标文档证据通过时，Runner 进入 ready；不要求静态页提供 Vue mount-signal。无断言行为不变，场景/额外初始化/视口仍明确拒绝，freshness 不因此提升。

多页和同源 iframe 都可能收到注入脚本。断言批量消息因此必须携带当前完整 URL，证据函数核对 origin/path/query/hash 与选中目标一致，query 顺序归一化；其他页面、子文档或畸形 URL 不提供证明。相同规则同步用于 Vue。旧版不带 URL 的 assertions 消息拒绝，两端须一起构建；没有持久化数据迁移或新工具参数。

静态页自身 meta CSP 可能阻止 bootstrap/报告，故其 readinessAssertion 能力为 conditional；没有报告就超时失败，不能假装 ready。它验证初次目标显示，不持续监视 DOM，也不保证页面代表最新源码。通用断言语义和计时器边界见 `target-assertions.md`。

## 实际验证

macOS arm64 / Node 24.13.1 / IAB Chrome 156.0.0.0；typecheck/build 和普通 JS 语法检查退出 0。显式 `DSH_PREVIEW_TEST_MODULES=<已有工具链 node_modules> npm test`：tests 281 / pass 281 / fail 0 / skipped 0。新增目标 URL/部分成功/静态 HTTP 报告回归，并保留默认约束、Vue 真实进程及目标超时清理覆盖。

`tools/probes/static-assertions-probe.mjs <绝对输出目录>` 使用编译完整 apply→锁定 SDK→独立 Root 服务自建父页和同源子文档。Host <pid> / Root <pid> / port <port>：子文档先显示相同目标及相同断言，父页面实际仍 preparing、公开状态 reachable/targetMounted unverified；点击 Show parent target 后父页自己的目标显示，公开状态才三层 proven/ready，freshness 保持 unverified。记录在 `output/static-assertions-browser/child-only-status.json`、`parent-ready-status.json` 和 `parent-ready.png`。

共享协议变更后复验编译 Vue：Host <pid> / Root <pid> / worker <pid> / port <port>；真实 TS SFC 显示，公开 status 三层 proven/ready、freshness unverified。记录在 `output/vue-assertions-url-browser/ready-status.json`、`ready.png`。

两个测试标签均已关闭。公开 stop/卸载后独立确认全部 Host/Root/worker、监听端口、整个临时样本目录消失，账本为空；cleanup.json 保存在各自输出目录。未修改原静态 fixture 或来源业务项目，没有模型调用、产品原生 DSH 安装或真实用户批准记录。
