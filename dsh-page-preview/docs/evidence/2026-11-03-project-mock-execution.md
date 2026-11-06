# R5-1e 项目 Mock 执行证据（2026-11-03，macOS arm64，Node 24.13.1）

工具链：tests/toolchains/vue3-self-contained（vue 3.4.27 / vite 5.2.12 / @vitejs/plugin-vue 5.1.4 / msw 2.15.0 / vite-plugin-mock 3.0.2 / mockjs 1.1.0），headless Google Chrome（非 IAB/DSH 载体）。

## vite-plugin-mock 执行与边界
`tests/unit/vue-vite-runtime.test.ts`：
- 「project vite-plugin-mock executes only outside declared businessPaths」：项目 `mock/api.ts` 定义 `/api/mock-user` 与 `/api/declared/x`；计划 `network` 含 `browser-http mock/project`；启动后 `/api/mock-user` → 200 `{name:'project-mock-user'}`，`/api/declared/x`（businessPaths 声明内）→ 404 `unmatched_request`（场景层独占遮蔽），`/api/nothing` → 404。PID/端口/临时目录均为占位语义，真实值逐次分配。
- 「out-of-root or absent mockPath reports project_mock_unavailable」：mockPath 指向不存在目录 → `project_mock_unavailable` 诊断 + 请求如实 404。
- 单测：`readonly-config` 对 `plugins` 中 vite-plugin-mock 调用的字面量解析（mockPath/布尔白名单通过；非字面量、未知键、`enable:false`、多调用 → `unresolved` 不执行）。

## MSW 复用与 Service Worker
- 「project MSW worker serves intercepted requests inside the document」：入口 `initVue` 内 `await worker.start()`（重放的顶层调用链），`public/mockServiceWorker.js` 为 msw 2.15.0 生成原文件；真实浏览器中 `/api/orders` 由项目 `setupWorker(http.get(...))` 应答（页面渲染 `MSW-ORDER`），该请求插件层不可见；`/api/miss` 穿透 SW 到插件层 → `unmatched_request`，页面得 404。
- 「Service Worker registers and intercepts inside a same-origin iframe」：独立同源 outer→iframe 实验，inner 在 `worker-src 'self'` CSP 下注册 SW 并经 `controllerchange` 后拦截 `fetch` —— 证明 iframe 内 SW 注册+拦截在 headless Chrome 成立（载体 IAB/原生另行验收）。
- `service-worker` 覆盖通道如实修正：检出 MSW → `mock/project`（bootstrap 放行）；未检出 → `block/response-layer`（bootstrap 屏蔽 `navigator.serviceWorker`，真实工具链页面实测 `typeof navigator.serviceWorker === 'undefined'`；原 `block` 声明曾不实）。

## 未验证
- DSH 载体 iframe（侧边栏 Browser）内的 SW 注册/拦截——本环境无载体。
- MSW 对跨源请求的拦截（bootstrap 先于 SW 改写跨源到 remote 通道，由场景 fixture 应答）。
- mock 文件经 `../src/x` 的越目录相对导入（不复制，插件降级空表后如实 unmatched）。
