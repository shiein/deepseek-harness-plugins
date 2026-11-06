# DeepSeek Harness Plugins

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）桌面版编写的 5 个本地插件。每个插件都是一个独立的 profile bundle，会在 Web GUI 左侧栏加一个入口。插件都在本机运行，Host 端的 HTTP 接口只接受本机回环地址的请求。

| 插件 | 包名 | 作用 |
|---|---|---|
| [业务流程分析](./bizflow) | `@local/bizflow` | 用已配置的模型分析本地项目里某项业务的数据流程，画成拓扑图（入口 / 流程 / 数据 / 权限 / 外部服务）；选中节点后能把粗略需求改写成精准的实现 prompt，并在项目里新建会话 |
| [Agent 资产](./dsh-agent-assets) | `@local/dsh-agent-assets` | 在一个页面里管理技能（Skills）、MCP 服务和 Agent 提示词文件（AGENTS.md / CLAUDE.md），按用户级 / 工作区级 / 内置分组，支持增删改查 |
| [Agent 历史对话](./dsh-agent-history) | `@local/dsh-agent-history` | 扫描本机 Claude Code、Codex、DeepSeek Harness、OpenCode、Gemini CLI、Cursor 等二十多种 AI 编程 Agent 的会话，可按项目文件夹合并成一条多 Agent 时间轴，也可按 Agent 浏览，并能一键在原 Agent 中继续对话 |
| [Agent Token 用量](./dsh-agent-usage) | `@local/dsh-agent-usage` | 从本地会话和用量文件统计各个 AI 编程 Agent 的 Token 消耗，按 Agent、模型、日期汇总，并估算按 API 计价的费用 |
| [网盘备份维护](./dsh-maintenance-backup) | `@local/dsh-maintenance-backup` | 把 DSH 配置、技能和本地插件工程备份到夸克网盘：立即备份、定时与变更监听、云端快照预览，以及分两阶段、可回滚的还原 |

每个插件的功能、接口、数据位置和限制，见各自目录下的 README。

## 环境

- 在 DSH 桌面版 `0.2.2-rc.1`（macOS arm64）上使用。插件依赖 DSH 内部的服务和 Client 槽位，DSH 升级后可能需要适配。
- `dsh-agent-history`、`dsh-agent-usage` 和 `dsh-maintenance-backup` 同时适配了 macOS 和 Windows 路径；Windows 上的验证程度见各自 README。
- `bizflow` 需要 profile 里配置好可用的默认模型。
- `dsh-maintenance-backup` 需要安装并授权夸克网盘技能（`~/.dsh/skills/quarkclouddrive`）。

## 安装

1. 克隆仓库：

   ```bash
   git clone https://github.com/shiein/deepseek-harness-plugins.git
   ```

2. 在 DSH Web GUI 的插件管理里选择「从本地目录安装 bundle」，指向某个插件目录，例如 `deepseek-harness-plugins/dsh-agent-history`。也可以让 DSH 里的 Agent 调用 `plugin_manager install_bundle`，target 传该目录的绝对路径。
3. 安装后左侧栏会出现对应入口。之后更新代码：
   - 改了 Host 端（`index.js`、`host/`）：在插件管理里停用再启用该插件，或者重启 DSH；
   - 只改了 `client.js`：刷新一次页面即可。

插件管理器会以 `link:` 依赖的形式把目录写进 profile 的 `package.json`，并把包名加进 `dsh.profile.bundles`，所以 DSH 直接运行仓库里的代码。

## 目录结构

每个插件目录的结构大致相同：

```
<plugin>/
  package.json        # bundle 清单：dsh.bundle.patch（Host 行）+ dsh.client（Client 模块）
  cordis.patch.yml    # 往 profile 插入 Host 插件行
  index.js            # Host 端：本地 HTTP API（/api/<plugin>/*）
  host/               # Host 端的模块拆分（部分插件有）
  client.js           # Client 端：左侧栏入口与主栏页面
  locale/             # 中英文标题与描述
  icon.svg
  README.md
  test/ docs/         # 测试脚本与设计、调研文档（部分插件有）
```

## 说明

- 这些都是个人插件，包名用的是 `@local/` 作用域，没有发布到 npm。
- 部分测试脚本和文档里有作者本机的路径；在别的机器上运行测试前，需要先把这些路径改掉。
