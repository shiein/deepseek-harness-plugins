# Vue 命名 SFC 与 Ant Design Vue 4 初始化样本

2026-11-01：已验证的精确 Vite 组合支持显式选择 SFC 的命名组件导出。公开 Planner/Runner 保留 exportName；浏览器从原模块选择该导出，缺失或非组件值继续明确失败，不回退 default。

样本由 tests/helpers/vue-antdv-fixture.ts 生成，仅借用 overview/web 已有的官方包文件。实际版本为 macOS arm64 / Node 24.13.1 / Vue 3.4.27 / Vite 5.2.12 / plugin-vue 5.1.4 / Ant Design Vue 4.2.5 / IAB Chrome 156。原入口 app.use(Antd) 和 reset.css 通过显式 reviewed setup/styles 重现；ConfigProvider 的 theme/locale 包裹原 NamedPage，默认组件若误挂载会抛错。没有修改或运行依赖来源项目、读取其 .env、安装新依赖或调用模型。

## 实际发现与修正

首次浏览器未挂载，报告外部 reset.css 动态 import 失败。原入口把文件路径提前 encodeURIComponent；Vite 的 import analysis 需要文件系统模块 ID，因此含 @/空格的路径未通过真实文件存在检查，生成了丢失 /@fs/ 的浏览器路径。此前直接请求原始 URL 的样式测试未覆盖这一步。

现在源入口传原始 Vite 文件 ID，浏览器 URL 由项目自己的 Vite 生成。没有添加库分支、全局资源放行、二次 URL 修补或构建器旁路。回归使用应用外、显式声明依赖范围内的 theme@1 space.css，跟随编译后入口实际发布的 URL，验证 200、JavaScript MIME 和真实样式内容；修改前失败，修改后通过。HTTP 请求侧仍按真实范围解析路径，不因未编码模块 ID 放宽资源权限。# 等其他特殊文件名没有对应真实构建样本，不从源码字符串单测外推兼容性。

## 验收证据

实际输出：

```text
npm run typecheck  # exit 0
npm run build      # exit 0
ℹ tests 313
ℹ pass 313
ℹ fail 0
ℹ skipped 0
```

新增公开 SDK 样本验证 NamedPage 的计划、原 TS SFC/外部样式编译、源文件哈希不变和停止。只读预检继续拒绝未知工具版本、非 SFC 模块格式和缺失导出；原有默认 JS/TS SFC、Node handlers 与场景回归通过。

编译完整入口→实际锁定 SDK→Root→worker→浏览器，Host <pid> / Root <pid> / worker <pid> / port <port>：

- 显示 Original named Ant Design Vue page 与 Original setup installed，默认错误组件未挂载；计数按钮从 0 变为 1。
- ConfigProvider token 显示 #0f766e，浏览器只读 DOM 测量按钮背景 rgb(15, 118, 110)、文字 rgb(255, 255, 255)，CSS-in-JS 主题实际生效。
- 原库 Modal 在 body 下显示，按钮为“取 消 / 确 定”；关闭后弹窗消失，原计数仍为 1。
- 公开 status 三层 proven / ready，无 runtime_error/compile_error，freshness 仍 unverified，所有网络 coverage 仍 none、默认 mock-only 仍阻断。

记录在 output/vue-antdv-named-browser-fixed/ready-status.json、library-dialog.png、named-page.png、browser-state.txt 和 cleanup.json。失败样本 output/vue-antdv-named-browser 也保留记录；两轮自有 Host/Root/worker/端口、临时目录与账本均独立确认清理，浏览器标签已关闭。

## 剩余范围

Ant Design Vue profile 的 verified 仍 false。这是 4.2.5 全量注册、显式 Provider、主题/中文 Modal 和命名 TS SFC 的部分证据；尚未完成 1.x/3.x、按需引入、完整状态重置、全局 API 或 Native 产品验收，不能据此提升整个 Tier 1 profile。没有新增广泛版本范围，也没有把普通 JS 模块/JSX 标记为已支持。兼容性矩阵、Vue 2/Vue CLI、其他组件库和两个真实业务样本仍保留待办。
