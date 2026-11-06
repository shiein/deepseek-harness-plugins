# 使用指南

> 面向使用者（在 DSH 中由 Agent 调用本插件的人）。只写当前代码真实具备、且有证据的行为；
> 未验证项在 `docs/limitations.md`，配置字段全集在 `docs/config-reference.md`，内部结构在 `docs/architecture.md`。

## 1. 安装与启用

- 包以 `cordis.patch.yml` 的 bundle patch 加载：

```yaml
- insert:
    - id: page-preview
      name: dsh-page-preview
      # config:
      #   dataDir: <可写绝对路径>   # 草稿/配置/日志数据目录；缺失时 open 报 config_invalid
      #   trigger: smart           # off | smart | always，默认 smart
```

- `dataDir` 用于：本地配置副本（`config/`）、fixture 草稿、调试日志（`logs/`）、账本残留归档、配置写回备份（`config-backups/<工作区哈希>/`，每工作区留最近 10 份）。
- 构建产物过期或 DSH 设置界面改写 patch 后丢失条目：重跑安装/补回 patch 行并重启 DSH。
- `trigger` 控制 `turn/end` 后的影响分析；`always` 的实际 auto-open 未实现（如实 `unsupported_capability`）。

## 2. 第一次预览一个页面

典型流程（Agent 侧）：

1. `page_preview_open { target: ... }` —— 目标可以是文件选择器、路由、已注册 ID 或同源 `url`。
   有执行项（command/env/setup/handlers/自动生成 setup）时先弹用户审批；
   `danger-full-access` 会话按权限预设放行并附 `approved_by_permission_preset`。
2. 返回 `state: reachable`（服务+文档已证明）或 `ready`（目标断言也证明）。`accepted`/bounded 状态下
   可稍后 `status` 查询，受理 ID 不等于已就绪。
3. 侧边栏（Client）展示预览列表与诊断；URL 经 DSH Browser 页签打开。
4. `page_preview_stop { previewId }` 释放自有资源；对账失败的残留用 `{ previewId, recover: true }`。

## 3. 工具一览

| 工具 | 关键参数 | 行为 |
| --- | --- | --- |
| `page_preview_open` | `target`、`projectId?`、`strategy?`、`scope?`、`scenario?`、`requirements?` | 打开/复用预览；多应用匹配需 `projectId`；候选歧义返回 `candidates` 总数不自动开第一个。 |
| `page_preview_status` | `previewId?`、`detail?` | 默认列最近 3 个自有预览；`detail` 返回计划/能力表/未命中列表/fixture 草稿（执行环境值省略）。 |
| `page_preview_refresh` | `previewId`、`scenario?` | 重编译/切场景；`inputs-changed` 到达的预览会提示刷新。 |
| `page_preview_capture` | `previewId`、`fullPage?` | 当前画面采集：如实 `unsupported`（D4 未验证图片到模型）。 |
| `page_preview_stop` | `previewId`/`all`/`recover` | 只停自有预览；`recover` 按账本回收残留并返回 `recovered`。 |

## 4. 场景与 Mock

- 场景字段：`identity`/`permissions`/`state`/`props`/`route`/`locale` + 同源 `http` fixtures +
  项目 `handlers`（需批准）；`refresh { scenario }` 或 open 带 `scenario` 切换。
- 未命中的业务请求如实 `unmatched_request`（404）；`status { previewId, detail:true }` 给出按
  (method, origin, path) 聚合的未命中列表与 `fixtureDraft` 草稿，填入真实数据后即可用。
- 项目自带 Mock（vite-plugin-mock/mockjs/msw）只读识别并报告 `project_mock_detected`，不执行。
- 配置了 `runtime.setup` 时自动重放关闭；若 setup 可能漏掉入口样式导入，会给出非阻断的
  `setup_missing_styles` 诊断（hint：移除 setup 走自动重放，或在 setup 中补导入）。

## 5. 真实项目接入

以只读识别过的 overview/web 样本（Vue 3.4.27 + Vite 5.2.12 + Ant Design Vue/Element Plus；
记录见 `docs/phase0-desktop-and-overview.md`）为例说明接入边界。该样本仅完成识别，
不构成适配器通过证据。

- **前置条件：**项目依赖已由项目自身安装（插件不代为安装）；入口文件可被静态解析；
  目标组件在应用根内。识别/计划/影响分析阶段只读文件——不执行项目代码、不在 Host 中
  加载 `vite.config.*` 的运行值、不读 `.env*`。
- **打开流程：**`page_preview_open { target }` → 计划与执行指纹 → 有执行项时弹用户
  审批 → Runner 子进程启动项目构建器 → 三层就绪（service/document/target）。业务登录
  和 API 初始化不会自动执行；页面所需数据走 §4 的 fixtures/handlers。
- **网络边界：**默认 `mock-only`——未命中请求 `unmatched_request`（404），不转发真实
  后端；项目 devServer proxy/mock 不执行（Vue CLI 会逐项剥离并给出
  `devserver_taken_over` 诊断）。配置注明直连真实后端的项目，预览行为同样不直连。
- **入口重放：**未配置 `runtime.setup` 时自动生成 setup 草稿并计入执行指纹；插件层、
  Provider 层按原入口顺序重放，业务叶组件替换为预览目标。顶层函数包裹、条件渲染等
  复杂入口会产出草稿供人工改为 reviewed setup，不会静默猜测。
- **环境边界：**构建工具链版本与已验证组合（`docs/limitations.md` §1）不一致时照常
  执行，能力标 `unknown` 并附 `unverified_toolchain`；SSR/Next/Nuxt、Svelte、Angular、
  跨应用导航、完整角色 reset 不在首版范围。

## 6. 限制与排查

- 已验证组合与平台边界：`docs/limitations.md` §1–2；未验证组合照常执行、能力 `unknown`。
- 常见诊断码与下一步：`docs/limitations.md` §5。
- 意外失败排查：诊断 hint 给出调试日志路径（`<dataDir>/logs/host.jsonl`、
  `runner-<工作区哈希>.jsonl`）；写失败时 hint 如实说明。
- 实机验收步骤与证据归档：`docs/dsh-e2e-acceptance.md`、`docs/evidence/`。
