# 非 Vite 已有服务模拟样本

方案 §14、§15.1；用户于 2026-10-31 授权在 `workspace/demo` 自建模拟项目。

Node 内置 HTTP 服务 + 原生 ESM，无构建器、框架、依赖安装、插件响应层或外部 API。所有订单都是人工 fixture；不是实际业务项目，也不代表 Webpack/Vue CLI 或 HMR 验收。

```bash
node server.mjs 0
```

启动输出随机 loopback origin 与 PID。打开 `/orders/`，筛选状态、查看详情，刷新或直接访问 `/orders/DEMO-101`。筛选偏好保存在本样本命名空间的 localStorage；关闭预览不得清理它。`GET /health` 提供进程身份及请求计数；未登记请求返回 `404 unmatched_request`。

接入测试只打开、刷新、关闭载体，不代理、改写响应或终止此进程。验证脱离后仍存活，再由启动者单独发送 SIGTERM 清理。它不证明产品 `existing-server` 适配器已经实现。
