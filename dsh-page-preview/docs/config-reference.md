# 配置参考

> 以 `src/shared/config/schema.ts` 与 `schema/page-preview.config.schema.json` 为唯一依据。
> 本文件逐字段说明类型、默认值、路径基准与执行批准关系；行为边界见 `docs/limitations.md`。
> 取代 `docs/configuration.md`（已缩为一行指针）。

## 1. 文件位置与来源优先级

- 仓库内：`page-preview.config.json`（项目根，`$schema` 可指向 `schema/page-preview.config.schema.json`）。
- 插件数据目录：`<dataDir>/config/<工作区哈希>/<项目ID>.json`（local 来源）。
- 优先级：repo > local，整份替换、不合并；多个来源只取一个完整来源，repo 存在时 local 被忽略并记录诊断。
- `schemaVersion` 必填且只接受 `1`；未知字段一律 `config_invalid`，不忽略。
- 校验只报告字段路径与约束，不回显配置值；通过校验不等于已批准执行。

## 2. 顶层字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `$schema` | string | 否 | 指向 JSON Schema 的提示字段，不参与校验语义。 |
| `schemaVersion` | `1` | 是 | 只接受字面量 1，其他版本 `config_invalid`。 |
| `projects` | ProjectConfig[] | 是 | 应用列表；`id` 不得重复。 |

## 3. projects[]

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | `^[a-z0-9][a-z0-9._-]*$`；多个应用匹配同目录时用 `projectId` 参数选择。 |
| `root` | string | 是 | 相对工作区的应用根；不得是绝对路径（POSIX/Windows/UNC 均拒绝）。 |
| `runtime` | RuntimeConfig | 是 | 运行方式，见 §4。 |
| `targets` | TargetConfig[] | 否 | 可预览目标；`id` 不得重复。 |
| `scenarios` | Record<string, ScenarioConfig> | 否 | 命名场景，见 §6。 |

## 4. projects[].runtime

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `strategy` | `static`/`isolated`/`project`/`attach` | 省略时由 `adapter` 推断（`vue-vite`/`vue-cli`/`react-vite`→`isolated`，`project-command`→`project`，`existing-server`→`attach`，`static`→`static`）；两者同时给出且不一致时报错。 |
| `adapter` | `static`/`project-command`/`existing-server`/`vue-vite`/`vue-cli`/`react-vite` | 已注册的适配器 ID，不是 npm 包名。 |
| `requirements` | `isolated-target`/`mock-only`[] | 需求声明；重复条目报错。默认（未声明）按 mock-only 处理。 |
| `setup` | 相对路径 | 复核过的 setup 模块（`install`/`createContext`/`applyScenario`/`navigate`/`dispose` 钩子）。计入执行指纹，需批准。 |
| `styles` | 相对路径[] | 追加样式表。 |
| `entry` | 相对路径 | 入口注册重放的入口文件（§6.9）；省略时由适配器从构建配置推断。 |
| `publicRoot` | 相对路径 | static 服务的文档根。 |
| `spaFallback` | boolean | static SPA 回退到 index.html；缺失资源仍按未命中处理。 |
| `command` | `{ executable, args[], cwd }` | `project` 策略必填。`cwd` 相对应用根。计入执行指纹，需批准。 |
| `env` | Record<string,string> | `project` 策略的命令环境。计入执行指纹，需批准；值不进入诊断。`attach` 禁用。 |
| `origin` | `https?://(127.0.0.1|localhost|[::1])(:port)?` | `attach` 必填；`project` 可选；目标 `url` 选择器必须同源且不含凭据。 |
| `readiness.probePath` | `/` 开头路径 | `project` 策略必填：服务就绪探针路径。 |
| `readiness.serviceDeadlineMs` | 正整数 ms | `project` 策略必填：服务启动期限。 |
| `readiness.targetDeadlineMs` | 正整数 ms | 浏览器目标证据期限；超时如实 `target_not_ready`，不报 ready。 |
| `dependencyRoots` | 相对路径[] | 显式批准的依赖根（workspace 共享包、符号链接来源）；未声明的根外文件拒绝。 |

执行批准：`command`、`env`、`setup`、场景 `handlers` 及其文件字节、入口自动生成的 setup 构成执行指纹（v2）。
指纹变化 → `config_changed_needs_approval`，批准后同会话同指纹内有效，不落盘。

## 5. projects[].targets[]

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 同 `projectId` 规则；不得重复。 |
| `selector` | object | 四选一，不得使用 `registered`（那是工具层自引用）：`{kind:'file',path,exportName?}`、`{kind:'route',path,params?,query?}`、`{kind:'story',id}`、`{kind:'url',url}`（须同源且无凭据）。 |
| `scope` | `page`/`component`/`shell` | 目标粒度；省略按 page。 |
| `route` | `{path,params?,query?}` | 文件目标的可选路由绑定；需 `setup.navigate` 解析。 |
| `defaultScenario` | string | 必须引用已存在的 `scenarios` 键。 |
| `assertions` | `{kind:'selector-visible',selector}` / `{kind:'text-present',text}`[] | 浏览器目标断言；全部 proven 才进 ready 证据。 |

## 6. projects[].scenarios[name]

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `identity` | object | 身份/账号数据，经 setup 注入。 |
| `permissions` | string[] | 权限列表。 |
| `state` | object | 应用状态种子。 |
| `props` | object | 目标组件 props。 |
| `route` | `{path,params?,query?}` | 场景级路由。 |
| `locale` | string | 语言环境。 |
| `businessPaths` | string[] | 自有 HTTP Mock 的显式业务路径范围，不从接口名推断。 |
| `http` | HttpFixture[] | 同源 HTTP fixtures，见 §7。 |
| `handlers` | 相对路径 | 项目 handler 模块（写交互）；计入执行指纹，需批准。 |
| `ws` | WsFixture[] | R5-1g 声明式 WebSocket 通道：`{path, send?:[{data,delay?}], replies?:[{match,data}], close?:{code?,reason?}}`——声明路径的 Upgrade 准入并按固定序列播放；未声明仍 block。仅 Vue worker 接通，static 如实拒绝。 |
| `sse` | SseFixture[] | R5-1g 声明式 SSE 通道：`{path, events:[{data,event?,id?,retry?,delay?}], keepOpen?}`——GET 命中即供出固定事件流；未声明仍 unmatched。 |

## 7. HttpFixture

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `origin` | string | 省略时只匹配预览来源；其他来源须显式声明。 |
| `method` | string | 必填。 |
| `path` | string | 必填。 |
| `query` | Record<string,string> | 精确匹配。 |
| `body` | unknown | 请求体匹配。 |
| `response.status` | int 100–599 | 必填。 |
| `response.headers` | Record<string,string> | 可选。 |
| `response.body` / `response.bodyFile` | unknown / 相对路径 | 二选一；`bodyFile` 相对应用根，保留二进制字节。 |
| `provenance` | string | 数据来源说明（AI 补全/人工编写）；草稿预填模板。 |

含占位标记（fixture 草稿未填写）的响应体/头会被 `config_invalid` 拒绝生效（R3-1）。

## 8. 语义校验（schema 之外）

`validateConfig` 额外检查：重复项目/目标 ID、缺失的 `defaultScenario` 引用、adapter↔strategy 一致性、
`attach` 必须有 `origin` 且不得有 `command`/`env`、`project` 必须有 `command` 与 `readiness.probePath`+`serviceDeadlineMs`、
`url` 选择器必须匹配配置的本地 `origin` 且无凭据、fixture 占位标记。
