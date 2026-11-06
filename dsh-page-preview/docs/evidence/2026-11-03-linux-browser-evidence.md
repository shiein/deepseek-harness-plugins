# Linux + Chromium 浏览器证据（R5-3，2026-11-03）

环境：Docker `node:24-slim`（arm64），Node 24.22.2，Debian Chromium 156.0.8078.79（`--headless=new` + CDP），
工具链经 `npm ci` 按提交锁安装。容器内以 root 运行（`--no-sandbox` 由启动参数声明，属测试环境边界）。

| 用例 | 命令 | 结果 |
| --- | --- | --- |
| Vite refresh 浏览器端证据 | `node --test --test-name-pattern="real browser proves refresh" tests/unit/vue-vite-runtime.test.ts` | 通过（1254ms）：改 SFC → 新标记出现、`window.__hmrProbe` 存活（非整页重载）、module-updated 推动 freshness→current |
| CLI navigation/assertions 浏览器证据 | `node --test --test-name-pattern="CLI navigation" tests/unit/vue-cli-public.test.mjs` | 通过（3799ms）：vue26-cli + Chromium——setup.navigate 推送、finalPath 核对、selector/text 断言经共享响应层/bootstrap 链路取证 |

归档说明：

- 本批为 Linux+Chromium 的**浏览器端**证据，补足早前仅 HTTP/进程级的 Linux 记录（`2026-11-03-linux-toolchain-scenario.md`）与 macOS-only 的浏览器记录。
- 早前「全 E2E 面 135/135 + Chromium」无归档记录的说法仍以未核实处理；本条只陈述本次可复现的运行结果。
- 首次跑批暴露导航后执行上下文瞬时重建导致的 evaluate 竞态（Linux 特有），已在测试中容错重试——不断言弱化，第二次跑批即本结果。
- 未验证：DSH 原生载体 IAB、Windows、其他内核；refresh 在 vue-cli 宿主下仍是 reload 机制（无 HMR），能力等级不外推。
