# Linux Docker 工具链全链路（toolchain-scenario）

对应 T 阶段工具链项：在 `node:24-slim`（Linux arm64）复跑 `tests/unit/toolchain-scenario.test.mjs`
全链路——未命中 404 → fixtureDraft 填表 → refresh 生效 → 切场景数据换绑、未命中清空 →
改源文件出影响分析候选 → inputs-changed → 资源清理。

## 边界（先说清）

- **本链路为 HTTP/进程级证据**：容器内没有浏览器/Chromium，就绪/refresh 断言基于自有响应层
  与 worker IPC 事实，不含浏览器端 HMR application 画面证据。
- **Linux 不是已验证组合**：运行中 Host 如实给出 `unverified_toolchain` 诊断，所有适配器能力
  保持 `unknown`；`supported` 声明仅限 macOS 精确组合（见 `applyViteEvidence`）。
  本次通过证明的是"未验证组合照常执行 + 诚实降级"，不构成能力升级依据。
- 容器为一次性 `--rm` 实例；仓库经 `git archive HEAD` 注入，node_modules 在容器内
  `npm ci` 全新安装（不污染宿主 darwin 原生包）。

## 环境

- 宿主：macOS arm64（OrbStack Docker 29.8.2），容器 `--platform linux/arm64`
- 镜像：`node:24-slim`
- Node：`v24.22.2`（容器内 `node --version`）
- 内核：`Linux <container-id> 7.2.12-orbstack-00394-gbecdd6130068 aarch64 GNU/Linux`
- Chromium：N/A（未安装；本链路不依赖浏览器）
- 工具链：`tests/toolchains/vue3-self-contained`（vue 3.4.27 + vite 5.2.12 +
  @vitejs/plugin-vue 5.1.4，容器内 `npm ci` 安装）

## 实际命令

```bash
git archive HEAD | docker run --rm -i --platform linux/arm64 -w /work node:24-slim bash -c '
  set -e
  tar -xf -
  npm ci --no-audit --no-fund --loglevel=error
  (cd tests/toolchains/vue3-self-contained && npm ci --no-audit --no-fund --loglevel=error)
  node --version
  uname -a
  node --test tests/unit/toolchain-scenario.test.mjs
'
```

## 输出摘要（动态值已替换为占位符）

```text
added <n> packages in <n>s   # root npm ci
added 125 packages in <n>s   # toolchain npm ci
v24.22.2
Linux <container-id> 7.2.12-orbstack-00394-gbecdd6130068 aarch64 GNU/Linux
✔ toolchain E2E: unmatched draft → filled fixture via refresh → scenario switch → impact → inputs-changed (2.9s)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
```

## 结果

- 通过/失败/跳过：**1 / 0 / 0**（Linux arm64 容器，Node 24.22.2）。
- 同链路在 macOS arm64（Node 24.13.1）同样通过，两处共用同一测试文件与同一断言集。
- 已知无关失败教训：`bsdtar --exclude='./browser'` 会误排 `src/browser/`（BSD tar 按路径
  组件匹配），导致 worker 缺 `lifecycle.js` 启动失败；`git archive` 为可复跑的正确注入方式。
