# dsh-page-preview — DSH 插件

在 DeepSeek Harness（DSH）里预览项目中**真实的业务页面**：Agent 通过工具打开某个组件、路由或 URL，插件在隔离的子进程里启动项目自己的构建器，把页面放进 DSH 的 Browser 页签。打开时可以带上场景（身份、权限、状态、路由、接口数据），代码改动后可以刷新，确认改动效果。

## 当前状态

还在迭代中（最近一轮为 R6）。下面只列有测试或实测证据的部分，完整进度见 [`docs/development-progress.md`](./docs/development-progress.md)，限制见 [`docs/limitations.md`](./docs/limitations.md)。

- **已验证的路径**（macOS arm64）：
  - `static`（无构建的 HTML/JS）、`existing-server`（接入已在运行的服务）、`project-command`（经批准后运行项目命令）；
  - Vue 3 + Vite、Vue 2 / Vue CLI（4.5 / 5）、React 18 + Vite 的隔离预览，包括入口重放、HMR / 自动刷新、编译错误带文件、行号和代码片段；
  - 已验证组合之外的工具链版本照常运行，能力标为 `unknown` 并附 `unverified_toolchain` 诊断。
- **平台**：macOS arm64 是实测基准；Linux 只在 Docker `node:24-slim` 中验证过；Windows 已实现（进程表、端口归属、进程树终止、`.cmd` 启动），只有合成单测、未实机验收，限制见 `docs/limitations.md` §2。
- **真实 DSH 端到端**：在 DSH desktop 里部分跑通；审批弹窗和 Client 的其余路径目前只有代码和单测。
- **首版不做**：SSR / Next / Nuxt、Svelte、Angular、webpack / CRA 的 React 项目、跨应用导航；截图交给模型的能力（`page_preview_capture`）如实返回 `unsupported`。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `page_preview_open` | 按文件选择器、路由、已注册目标 ID 或同源 URL 打开或复用预览 |
| `page_preview_status` | 查看预览状态；`detail: true` 时返回计划、能力表、未命中请求列表和 fixture 草稿 |
| `page_preview_refresh` | 重新编译或切换场景 |
| `page_preview_capture` | 采集当前画面（当前返回 `unsupported`） |
| `page_preview_stop` | 停止自己打开的预览；`recover: true` 时按账本回收残留进程 |

右侧边栏有一个预览面板，展示预览列表、诊断和建议打开的页面。

## 安全与数据边界

- **会执行代码的配置项要先经用户审批**：项目命令、环境变量、setup、handlers、自动生成的 setup、应用根下的 `vite.config.*` / `vue.config.*` 都计入执行指纹，变化后需要重新审批。构建配置 import 的其他文件不在指纹内。
- **默认只用 Mock**：没有命中 fixture 的业务请求返回 `unmatched_request`（404），不会转发到真实后端；`status` 会给出按 method、origin、path 聚合的未命中列表和 fixture 草稿，填入真实数据后即可使用。
- **不改目标项目**：不修改业务源码、`package.json`、锁文件和构建配置，也不代为安装依赖；`.env*` 不读不写。
- 项目自带的 Mock（vite-plugin-mock、mockjs、msw）只做只读识别，不执行。

## 安装

`lib/` 和 `browser/` 是构建产物，不在仓库里，需要先构建：

```bash
cd dsh-page-preview
npm install        # 依赖锁定在 DSH 0.2.2-rc.1
npm run build      # 输出到 lib/，并把 src/browser/ 复制到 browser/
```

然后在 DSH 插件管理里从本地目录安装这个目录。`dataDir` 必须配置为可写的绝对路径，否则 `open` 会报 `config_invalid`：

```yaml
- id: page-preview
  name: dsh-page-preview
  config:
    dataDir: /absolute/path/to/page-preview-data
    trigger: smart     # off | smart | always，控制每轮对话结束后的影响分析
```

`dataDir` 用来存放本地配置副本、fixture 草稿、调试日志（`logs/*.jsonl`）和配置写回备份。

项目侧配置写在项目根目录的 `page-preview.config.json`，字段说明见 [`docs/config-reference.md`](./docs/config-reference.md)，JSON Schema 在 [`schema/page-preview.config.schema.json`](./schema/page-preview.config.schema.json)。

## 开发

```bash
npm run typecheck
npm test           # 先跑行宽检查并安装测试工具链（tests/toolchains/），再跑全量测试
```

- 开发约束：[`AGENTS.md`](./AGENTS.md)（接手开发前必读）
- 使用指南：[`docs/guide.md`](./docs/guide.md)
- 架构：[`docs/architecture.md`](./docs/architecture.md)
- 完整方案：[`dsh-page-preview-development-plan.md`](./dsh-page-preview-development-plan.md)
- 样本登记：[`tests/fixtures/README.md`](./tests/fixtures/README.md)

## 目录结构

```
src/
  host/       # Host 端：工具注册、会话登记、执行审批、影响分析、面板服务
  runner/     # Runner 子进程：启动项目构建器、受控响应层、资源账本与进程回收
  adapters/   # static / existing-server / project-command / vue-vite / vue-cli / react-vite
  scenario/   # 场景、fixture 与 Mock
  client/     # 右侧边栏预览面板
  browser/    # 注入预览页的浏览器端代码
  core/ shared/
schema/       # 项目配置的 JSON Schema
tests/        # 单元测试、工具链 E2E、样本
docs/         # 设计、进度、证据、限制
cordis.patch.yml
```
