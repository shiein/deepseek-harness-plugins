# 真实 Vite HMR 探针样本

对应方案 §6.8、§9.2、§14。原生 ESM，没有 Vue SFC、业务后端或第三方 UI 库。

由 `tools/probes/phase0-hmr.mjs` 复制到临时目录，在独立 Node 进程中加载明确指定的已安装 Vite `5.2.12`；`configFile: false`、`envFile: false`、`middlewareMode: true`，HTTP 服务和停止清理由探针管理。不需要给本仓库或来源项目安装依赖。只修改临时 `target.js`，不修改此处原始样本。

页面保留一个内存交互计数。正常模块更新报告新的 revision；加载失败明确显示 `update_error`，收到 Vite 错误事件时可显示其消息。完整编译诊断仍可能只在 Vite 服务端，不能仅依赖 Browser 或 `vite:error`。详细复现与实测边界见 `docs/phase0-hmr.md`。
