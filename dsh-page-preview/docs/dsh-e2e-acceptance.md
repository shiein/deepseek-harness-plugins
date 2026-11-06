# 真实 DSH 端到端验收清单（R2-P0-4）

**状态：待 Aesc 授权后执行。** 本文档是可审阅的逐步验收脚本；审批前不安装、不重启。
对应 `docs/review-2026-11-02.md` §2.4。插件从未作为产品在真实 DSH 中安装过——
本条链路是首轮全量验收。

## 0. 前置确认（执行人逐项核对）

- [ ] Aesc 明确授权：允许在独立 DSH profile 中加载本插件并启动 `dsh web`。
- [ ] DSH 仓库路径已知且可运行（`pnpm dsh web` 可用）。
- [ ] 本仓库 `npm run build` 已通过（lib/ + browser/ 产物齐全，最近一次构建 2026-11-XX 通过）。
- [ ] 全程**不修改** overview/web 的任何文件、**不读取**其 `.env*`；
  代码修改步骤只用自建临时样本。

## 1. 环境准备（独立 profile，不碰真实 DSH_HOME）

```bash
export DSH_HOME=$(mktemp -d)/dsh-home        # 独立 profile；禁止复用真实 DSH_HOME
export DSH_PP_DATA=$(mktemp -d)/pp-data      # 插件数据目录
```

- [ ] 备份当前 `dev/cordis.dev.yml`（现存内容是 phase0 载体的 overlay，与插件无关）：
  `cp dev/cordis.dev.yml /tmp/cordis.dev.yml.phase0.bak`
- [ ] 复制 `dev/cordis.dev.example.yml` 为 `dev/cordis.dev.yml`，把两处
  `/ABSOLUTE/PATH/TO/` 替换为本机绝对路径（`src/index.ts` 与 `dataDir=$DSH_PP_DATA`）。
- [ ] 启动：`cd <DSH 仓库> &&
  pnpm dsh web --patch /abs/path/dev/cordis.dev.yml --no-open --host 127.0.0.1 --port 3080`
- [ ] 浏览器打开启动输出的带令牌 URL（**不要**把 URL/令牌粘进日志、截图或提交）。

**预期**：插件加载无错误；DSH UI 正常出现。异常即停止并记录到「5. 问题登记」。

## 2. 阶段 A：overview/web 只读链路（打开 → 审批 → 预览 → 面板）

> overview/web 只读使用：不改文件、不读 `.env*`。Agent 在指向该目录的会话中操作。

- [ ] A1. 在 DSH 会话中将工作区设为 overview/web，指令 Agent：「预览这个项目的页面」。
  **预期**：Agent 调用 `page_preview_open`。
  **证据**：`docs/evidence/e2e-01-agent-open.png`（Agent 消息+工具调用截图）。
- [ ] A2. 出现审批弹窗。**预期**：headline 显示人读差异，详情块可见；
  `allow-once` / `deny` 可选。
  **证据**：`docs/evidence/e2e-02-approval.png`。
  **检查点**：多行差异是否可读（headline 无 pre-wrap，已知 `\n` 会塌陷——如实记录观感）。
- [ ] A3. 点 `allowed-once`。**预期**：工具返回 preview 摘要+URL；
  预览面板/页面出现真实业务页面
  （不是替代页）。
  **证据**：`docs/evidence/e2e-03-preview.png`。
- [ ] A4. Client 面板可见。**预期**：面板列出该预览，显示状态/URL/诊断，有停止动作；
  URL 是"在 Browser 中打开"按钮，点击后在 DSH Browser 页签打开预览地址；
  浅色与深色主题各截一张核对主题变量可读性。
  **证据**：`docs/evidence/e2e-04-client-panel.png`（另附 `e2e-04b-panel-dark.png`、
  `e2e-04c-browser-tab.png`）。
- [ ] A5. `page_preview_stop` 停止该预览（阶段 B 用独立样本，先收掉）。
  **预期**：状态如实变 `stopped`；overview/web 目录 `git status` 干净。

## 3. 阶段 B：自建临时样本（修改 → 自动刷新 → current → 停止）

> 目的：验收 R2-P0-2 的自动刷新链路。overview/web 不允许修改，故用临时 Vue CLI 样本。

- [ ] B1. 创建临时工作区（不放进任何真实项目）：
  ```bash
  WS=$(mktemp -d)/sample && mkdir -p $WS/src
  cp -r tests/toolchains/vue26-cli4/package.json $WS/   # 或等价的最小 vue-cli 样本
  # 最小结构：vue.config.js、public/index.html、src/main.js、src/Target.vue
  cd $WS && npm install                                # 工具链版本与已批准清单一致
  ```
  也可用 `tests/helpers/vue-cli-fixture.ts` 同款最小结构；样本须含一个可编辑的 SFC。
- [ ] B2. 会话工作区切到 `$WS`，让 Agent 打开预览。
  **预期**：审批后 `page_preview_open` 返回 URL，
  页面渲染样本组件。
  **证据**：`docs/evidence/e2e-05-sample-open.png`。
- [ ] B3. 指令 Agent：「把 src/Target.vue 里的文本改成 r2-e2e-marker」。**预期**：无需人工刷新，
  预览自动重载出新文本（webpack `invalid`→`done`→`/build` 长轮询返回→`location.reload`）。
  **证据**：`docs/evidence/e2e-06-auto-reload.png`（录屏更佳）。
- [ ] B4. `page_preview_status` 查询。**预期**：`freshness` 依次出现 `unverified`→`current`
  （current 必须有浏览器 applied 回报为凭据）。
- [ ] B5. 指令 Agent 引入一处语法错误。**预期**：`stale` + `compile_error` 诊断带文件/行列。
  修复后重新 `current`。
  **证据**：`docs/evidence/e2e-07-stale.png`。
- [ ] B6. 手动调 `page_preview_refresh`。**预期**：`updated`/`unverified`→浏览器 applied→`current`；
  并发第二次调用被拒绝或共享同一更新。
- [ ] B7. `page_preview_stop`。**预期**：进程/端口/临时目录按账本释放；
  `$DSH_PP_DATA` 无残留孤儿。
  **证据**：`docs/evidence/e2e-08-stopped.png`。

## 4. 清理与回滚

- [ ] Ctrl+C 停 DSH；恢复 `dev/cordis.dev.yml`：`cp /tmp/cordis.dev.yml.phase0.bak dev/cordis.dev.yml`
- [ ] 删除 `$DSH_HOME`、`$DSH_PP_DATA`、`$WS` 临时目录
  （确认无遗留进程：端口 3080/预览端口已释放）。
- [ ] 截图/录屏放入 `docs/evidence/`，**不含**启动令牌 URL、`.env` 内容、nonce 明文。

## 5. 问题登记

每个失败或观感异常写一条：现象 / 期望 / 实际 / 证据文件 / 初步归因 / 建议修复——记入
`docs/development-progress.md` 待办或新 TODO，不现场改代码。

| # | 现象 | 证据 | 归因 | 处置 |
| --- | --- | --- | --- | --- |
| | | | | |

## 6. 授权声明

执行人在开始前在此填写：`授权人 / 日期 / 授权范围（安装+启动，仅限独立 profile）`。
