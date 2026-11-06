# R5-3 Vite 浏览器端 refresh 证据（2026-11-03）

平台：macOS arm64，Node 24.x，本机 Google Chrome `--headless=new` + CDP（非 DSH IAB 载体）。
工具链：`tests/toolchains/vue3-self-contained`（Vue 3.4.27 / Vite 5.2.12 / @vitejs/plugin-vue 5.1.4）。
测试：`node --test tests/unit/vue-vite-runtime.test.ts`——「a real browser proves refresh applies
the new build in place (R5-3 refresh evidence)」。

## 断言链

1. 真实浏览器导航到预览 URL，`document.body.innerText` 出现初始目标标记（挂载证明）。
2. 页面内写入 `window.__hmrProbe = "survives"`。
3. 改 `src/Target.vue` 加入新标记 `r5-hmr`。
4. 活文档的 `innerText` 出现 `r5-hmr`——HMR 把新版本应用到当前页面。
5. `window.__hmrProbe === 'survives'`——证明是就地更新而非整页重载（重载会清掉变量）。
6. 新文档印章 `__DSH_BUILD__` 与旧值不同；bootstrap 回传 `module-updated` 后
   freshness 事件序列出现 unverified→current（浏览器自证应用，非伪造上报）。

## 结论与边界

- `refresh`（mode `hmr`）在已验证组合（macOS + Vue 3.4.27/Vite 5.2.12/plugin-vue 5.1.4）
  由 `unknown` 升回 `supported`，coverage 如实标注 headless Chrome、载体未验。
- 未验证：DSH 侧边栏 Browser（webview/iframe）内的 HMR 应用；CLI（webpack）路径的
  浏览器端应用（保持 unknown）；Linux/Chromium 组合。

## 相关

- CSP `TODO(phase0)` Worker/Service Worker 边界：R5-1e iframe SW 实验见
  `docs/evidence/2026-11-03-project-mock-execution.md`（同源 iframe 注册+拦截在 headless
  Chrome 成立；bootstrap 未检出 MSW 时屏蔽 `navigator.serviceWorker`，实测 API undefined）。
