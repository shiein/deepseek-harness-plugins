# Agent 资产（Agent Assets）— DSH 插件

一个带**左侧栏入口**的 DeepSeek Harness 插件：在同一个页面管理 **技能（Skills）**、**MCP 服务** 与
**Agent 提示词文件（AGENTS.md / CLAUDE.md）**，全部**按作用范围分组展示**，并支持**增删改查**。

页面走 Harness 自己的槽位与主题令牌（`sidebar.panellist` + `main`），不是 iframe，也不引入额外的
UI 依赖；Host 半通过 `/api/dsh-agent-assets/*` 只对本机回环请求提供 JSON API。

![icon](icon.svg)

## 作用范围（Scope）

| 资产 | 用户级（user） | 工作区级（workspace） | 内置（bundled，只读） |
| --- | --- | --- | --- |
| 技能 | `~/.dsh/skills/<name>/SKILL.md`、`~/.agents/skills/<name>/SKILL.md` | `<workspace>/.dsh/skills/<name>/SKILL.md`、`<workspace>/.agents/skills/<name>/SKILL.md` | 其他已安装 bundle / 运行时注册的技能（来自 `skills` 服务） |
| MCP | `~/.dsh/agent-assets/mcp.json` | `<workspace>/.dsh/agent-assets/mcp.json` | 由其他插件 bundle 声明的 `@deepseek-ai/dsh-mcp-client` 行（只读展示） |
| Agent 提示词 | `~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md` | `<workspace>/AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`，以及已存在的嵌套 `AGENTS.md` / `CLAUDE.md` | — |

同名技能的优先级与 Harness 完全一致：`project-dsh` > `project-agents` > `user-dsh` > `user-agents` >
bundled。被覆盖的同名项会显示在详情/列表的 `shadowed` 信息里，而不是静默消失。

## 功能

- **技能**：新建（kebab-case 名称 + 描述 + 何时使用 + Markdown 正文）、**导入**（本地文件夹 / 多技能文件夹 / 仓库 `skills/<name>/` / SKILL.md / `.zip`·`.skill` 压缩包，先扫描预览、可勾选、同名需确认覆盖）、查看、编辑、删除；保留未知
  frontmatter 字段（如 `license`），只更新界面上的字段；内置技能只读。
- **MCP**：新建 stdio / streamable-http 服务、编辑、启停、删除；**保存后立即真实挂载**，状态来自
  `ctx.tools` 里 `mcp__<serverName>__*` 工具数量（已连接 · N 个工具 / 连接中 / 错误 / 已停用）；工作区级
  服务在该工作区的每个 Session 上按 `agent.ctx` 挂载，不泄漏到其他工作区。env / headers 明文存于
  本机（文件权限 `0600`），界面会提示这一点。
- **Agent 提示词**：只列出**已经存在**的用户级/工作区级指令文件（含已存在的嵌套文件）；未创建的文件不作为空行占位，
  通过「新建提示词文件」从完整候选列表（用户级 2 个 + 工作区级 4 个）中选择创建，可编辑、删除；
  写入后 Harness 的 `@deepseek-ai/dsh-agent-instructions` 会在下一次读取时热更新。
- 页面自身：三个标签页、作用范围筛选、搜索、按 scope 分组的列表、详情/编辑/删除确认对话框、
  错误与空状态、刷新、workspace 选择器；中英双语；浅色/深色主题；键盘可达（Tab/Enter/Escape）。

## 安装

在 DSH 会话里安装本目录（bundle 会自己插入 Host 行；Client 模块由 `package.json#dsh.client` 声明）：

```
plugin_manager install_bundle("/path/to/dsh-agent-assets")
```

安装后左侧栏出现「Agent 资产」图标；页面位于主栏。Host 路由挂载在 `/api/dsh-agent-assets/`。

## 结构

```
package.json          # bundle 清单：dsh.bundle.patch + dsh.client
cordis.patch.yml      # 插入 Host 行 agent-assets
index.js              # Host 入口：路由、作用范围解析、MCP 桥模块加载、agent/created 挂载
host/shared.js        # 路径/校验/SKILL.md frontmatter 工具（Lead 维护）
host/skills.js        # 技能扫描与增删改查
host/instructions.js  # AGENTS.md / CLAUDE.md 指令文件增删改查
host/mcp.js           # MCP 存储、校验、真实挂载与状态
client.js             # 左侧栏入口 + 管理页面（React，无 JSX，无构建）
locale/{zh,en}.json   # 插件管理器显示元数据
icon.svg              # 原始图标（自制）
API.md                # Host JSON API 契约（唯一事实来源）
DESIGN.md             # 页面视觉与交互契约
test/                 # 单元测试、MCP 测试服务、客户端渲染冒烟测试
```

## 验证

```bash
node --check index.js && node --check client.js
node --test test/*.test.mjs           # host 模块单测（显式 glob；默认发现会把 MCP 测试服务也当测试文件加载）
node test/host-integration.mjs        # 安装前的整体路由/作用范围/MCP 挂载联调（假 ctx）
node test/client-render.test.mjs      # 页面 SSR 渲染冒烟（真实 React 18）
node test/live-api.mjs                # 对已安装实例做只读校验（--write 增加工作区级增删改查）
curl -s http://127.0.0.1:49536/api/dsh-agent-assets/health
```

真实验证路径：安装 bundle → `GET /health` 显示 `mcp.moduleLoaded: true` → 在页面新建一个指向
`test/fixtures/mcp-echo-server.mjs` 的 stdio MCP 服务 → 状态变为「已连接 · 2 个工具」→ 新建/编辑/
删除一个工作区技能与一个 AGENTS.md 文件 → 检查文件内容与 Harness 的实际读取结果一致。

## 已知边界

- 开发期更新：只改 `client.js` 时刷新页面即可看到新版本；改过 `index.js` / `host/*.js` 后，
  先 `plugin_manager remove_bundle` 再 `install_bundle` 同一路径即可让新的模块代际在运行中的 DSH 生效（实测，
  无需重启应用）；仅 `package.json` 的显示元数据变化在下次页面加载/重启后读取。

- 工作区级 MCP 只在**新建立的 Session** 上挂载；已存在的 Session 保持原挂载，直到它被销毁。
- MCP 的 `env` / `headers` 明文保存在本机 JSON（`0600`），没有接 Harness 凭据系统；需要密钥时更推荐
  用 bundle 行配合 Loader `!!js` 引用已有凭据。
- 内置技能只读：卸载/修改内置技能要改提供它的 bundle。
- 技能名称不可重命名（改名称 = 新建 + 删除），避免破坏已有引用。
