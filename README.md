# DeepSeek Harness Plugins

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）桌面版编写的 6 个本地插件，每个都是独立的 profile bundle。前 5 个在 Web GUI 左侧栏增加入口，Host 端 HTTP 接口只接受本机回环地址请求；`dsh-page-preview` 为 Agent 提供页面预览工具，并在右侧栏显示预览面板。

| 插件 | 包名 | 作用 |
|---|---|---|
| [业务流程分析](./dsh-business-flow) | `@local/dsh-business-flow` | 用默认模型分析本地项目中某项业务的数据流程并绘成拓扑图，可切换全貌 / 调用链 / 数据 / 权限 / 外部视图；选中节点可把粗略需求改写成精准的实现 prompt，并在项目中新建会话 |
| [Agent 资产](./dsh-agent-assets) | `@local/dsh-agent-assets` | 统一管理技能（Skills）、MCP 服务和 Agent 提示词文件（AGENTS.md / CLAUDE.md），按用户级 / 工作区级 / 内置分组增删改查 |
| [Agent 历史对话](./dsh-agent-history) | `@local/dsh-agent-history` | 扫描本机 Claude Code、Codex、DSH、OpenCode、Gemini CLI、Cursor 等二十多种 AI 编程 Agent 的会话，按项目合并成多 Agent 时间轴或按 Agent 浏览，可一键在原 Agent 中继续对话 |
| [Agent Token 用量](./dsh-agent-usage) | `@local/dsh-agent-usage` | 从本地会话和用量文件统计各 Agent 的 Token 消耗，按 Agent、模型、日期汇总，并按 API 价格估算费用 |
| [网盘备份维护](./dsh-maintenance-backup) | `@local/dsh-maintenance-backup` | 把 DSH 配置、技能和本地插件工程备份到夸克网盘：立即 / 定时 / 变更触发备份、云端快照预览，以及两阶段可回滚还原 |
| [页面预览](./dsh-page-preview) | `dsh-page-preview` | 在隔离子进程中用项目自己的构建器（static / 已有服务 / 项目命令 / Vue 3 + Vite / Vue CLI / React + Vite）预览真实页面，可注入身份、权限、路由和接口 Mock，改代码后刷新验证。仍在迭代，需先构建 |

两个扫描类插件（历史对话、Token 用量）在 `worker_threads` 中执行扫描，不阻塞 Host；大型数据源（如 Devin CLI 数据库）增量读取。各插件的功能、接口、数据位置和限制见其目录下的 README。

## 环境

- 基于 DSH 桌面版 `0.2.2-rc.1`（macOS arm64）开发。插件依赖 DSH 内部服务和 Client 槽位，DSH 升级后可能需要适配。
- `dsh-agent-history`、`dsh-agent-usage`、`dsh-maintenance-backup` 同时适配 macOS 和 Windows 路径，Windows 上的验证程度见各自 README。
- `dsh-business-flow` 需要 profile 中配置可用的默认模型。
- `dsh-maintenance-backup` 需要安装并授权夸克网盘技能（`~/.dsh/skills/quarkclouddrive`）。
- `dsh-page-preview` 为 TypeScript 工程，依赖锁定 DSH `0.2.2-rc.1` 的 npm 包；安装前先在其目录运行 `npm install && npm run build`（构建产物 `lib/`、`browser/` 不入库）。macOS arm64 实测，Linux 仅在 Docker 中验证，Windows 已实现但未实机验收。

## 安装

1. 克隆仓库：

   ```bash
   git clone https://github.com/shiein/deepseek-harness-plugins.git
   ```

2. 在 DSH Web GUI 插件管理中选择「从本地目录安装 bundle」，指向插件目录（如 `deepseek-harness-plugins/dsh-agent-history`）；或让 DSH 中的 Agent 调用 `plugin_manager install_bundle`，target 传该目录的绝对路径。
3. 安装后左侧栏出现对应入口。更新代码后：
   - 改了 Host 端（`index.js`、`host/`）：在插件管理中停用再启用，或重启 DSH；
   - 只改了 `client.js`：刷新页面即可。

插件管理器以 `link:` 依赖把目录写入 profile 的 `package.json`，并把包名加入 `dsh.profile.bundles`，因此 DSH 直接运行仓库中的代码。

> 业务流程分析插件原名 `bizflow`（包名 `@local/bizflow`），已改为 `dsh-business-flow`（`@local/dsh-business-flow`），接口前缀改为 `/api/dsh-business-flow/`。已安装旧版的，请在插件管理中卸载 `@local/bizflow`，再从 `dsh-business-flow` 目录重新安装。原来的 `~/.dsh/bizflow/history.json` 会在首次打开历史时自动移到 `~/.dsh/business-flow/history.json`。

## 目录结构

前 5 个插件为纯 JavaScript，结构大致相同：

```
<plugin>/
  package.json        # bundle 清单：dsh.bundle.patch（Host 行）+ dsh.client（Client 模块）
  cordis.patch.yml    # 向 profile 插入 Host 插件行
  index.js            # Host 端：本地 HTTP API（/api/<plugin>/*）
  host/               # Host 端模块（部分插件有）
  client.js           # Client 端：左侧栏入口与主栏页面
  locale/             # 中英文标题与描述
  icon.svg
  README.md
  test/ docs/         # 测试脚本与设计、调研文档（部分插件有）
```

`dsh-page-preview` 的结构（`src/` → `lib/`）见其 README。

几个插件共用的 Host 代码只维护一份，放在 `shared/host/`，再由脚本复制到各插件的 `host/`（复制件带 `GENERATED` 标记），这样每个插件目录仍能独立安装。界面共用的部分（头部高度、动效时长、减弱动效、浮层退出动画）放在 `shared/client/ui-kit.js`，由同一脚本内联到各插件 `client.js` 的 `<shared-client:ui-kit>` 标记之间。修改时改 `shared/` 下的源文件，然后运行 `node scripts/sync-shared.mjs`；各插件的 `npm test` 会检查复制件是否同步。

## 说明

- 均为个人插件，未发布到 npm；前 5 个使用 `@local/` 作用域。
- `dsh-page-preview` 是从其独立本地仓库导出的快照，不含提交历史。
- 部分测试脚本和文档包含作者本机路径，在其他机器上运行测试前需先修改。
