# 非 Vite 模拟服务接入记录

2026-10-31。按用户“在 workspace 的 demo 目录自己模拟一个”的明确指示，创建并运行 `/Users/aesc/Documents/workspace/demo/dsh-page-preview-non-vite`。本轮以该模拟项目进行 Phase 0 非 Vite 展示路径探测，不再等待额外项目来源；真实业务样本要求仍按方案 §15 单独验收。

可复现源文件保存在 `tests/fixtures/non-vite-existing-server/`。技术组合为 Node `24.13.1` 内置 HTTP、原生 JavaScript ESM、HTML/CSS，无构建器、框架、第三方依赖或真实业务后端。订单均为人工 fixture。复制工具只创建新目录，拒绝覆盖已有目录；未修改 overview。

## 实测结果

环境为 macOS `15.7.7` arm64、当前原生 DSH `0.2.1-rc.5`、Electron `44.7.0` / Chrome `152.0.7977.130`。服务作为独立进程提前启动；DSH 中手动创建本轮 Browser tab，直接接入其 URL，没有安装插件、响应代理或 bootstrap。

| 检查 | 证据 | 限制 |
| --- | --- | --- |
| 服务可达 | 健康接口返回样本身份；实际监听 PID 与启动时间一致 | HTTP 200 不作为目标 ready |
| 实际页面与数据 | 原生页面显示“数据已加载 · 3 条订单”，含三条 fixture 订单 | UI 证据来自桌面无障碍树与截图检查，非产品就绪判断 |
| 筛选交互 | 选择“进行中”后仅显示山海设计 `DEMO-102` | 只有本样本数据，不证明业务权限 |
| 深层路由 | 点击详情后地址为 `/orders/DEMO-102`，显示金额 `¥8,600` | 原生 history 路由，没有框架路由器 |
| 整页刷新 | DSH 刷新后同一路由、订单详情与“进行中”筛选保留 | 无 HMR，刷新能力仅为 reload |
| 脱离 | 关闭本轮 tab 后，同一 PID、启动时间和端口仍在，健康接口正常 | 是载体关闭验证，产品 adapter.stop 仍未实现 |
| 存储保留 | 重新创建 Browser tab 并直接打开深层路由，“进行中”偏好仍在 | 仅同一 DSH 工作区、同一 origin 的样本 localStorage；不推广为跨工作区分区或 Cookie 结论 |
| 不改项目 | 打开前与首次脱离后，六个文件 SHA-256 完全一致 | 是本样本的文件比对 |
| 请求证据 | 打开、刷新、重开对应 documentRequests 和 apiRequests 均由 0 增至 3 | 服务器请求计数与 UI 证据分别记录，不将请求数当成业务挂载证明 |
| 未登记请求 | HTTP 回归得到 `404 { code: 'unmatched_request' }`；POST 返回 405；外部 Host 返回 403 | 不转发未知请求；不代表插件可以限制任意 attach 服务 |

两次关闭均未终止服务。验证结束由启动者另行核对 PID 与启动时间后发送 SIGTERM，进程正常退出，端口不再监听。测试 tab 均已关闭，用户客户端和原有输入保持原样。没有清理 Cookie、Storage 或浏览器缓存，没有模型调用。

本地证据在忽略目录 `output/phase0/non-vite/`：`before.json`、`after-refresh.json`、`after-detach.json`、`after-reopen-and-detach.json`、源文件哈希。它们记录本次临时服务的实际地址和进程信息，不进入支持矩阵。

## 复现

1. 从仓库根执行 `node tools/probes/prepare-phase0-non-vite.mjs <新的绝对目录>`，例如 workspace/demo 下的独立目录。目标目录已存在时明确失败。
2. 在新目录执行 `node server.mjs 0`，保存输出的 origin/PID；不需要 npm install。
3. 在 DSH Browser 手动打开 `<origin>/orders/`。确认三条订单，选择“进行中”，打开 `DEMO-102` 详情。
4. 使用 Browser 的刷新按钮，检查深层路由、金额和筛选偏好。关闭本轮 tab，核对服务仍存活；再创建 tab 并打开相同 URL，检查偏好仍在。
5. 关闭本轮 tab。由服务启动者核对身份后单独停止样本，不能把这个清理动作算作 attach.stop。

检查实际输出：

```text
npm run typecheck → exit 0
npm test          → tests 31, pass 31, fail 0, skipped 0
npm run build     → exit 0
node --check      → server.mjs、复制脚本通过
ESM syntax check  → app.js 通过
```

产品 `existing-server` 适配器、工具接入/脱离链路、Webpack/Vue CLI、真实 HMR、Cookie SameSite、跨工作区存储分区及真实业务项目均未据此宣称通过。
