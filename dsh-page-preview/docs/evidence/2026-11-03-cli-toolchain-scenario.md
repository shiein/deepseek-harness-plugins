# Vue 2 CLI 工具链场景链路证据（2026-11-03）

与 `tests/unit/toolchain-scenario.test.mjs`（Vue 3 + Vite）同链路的 CLI 腿实测记录。
2026-11-03 Aesc 决定放行 CLI `scenario`（assertions/navigation 仍拒），本文件为放行后
全链路证据；旧版「带场景 open 被 planner 拒」的卡点记录已由本次运行取代。

## 环境

| 项 | 值 |
| --- | --- |
| 平台 | macOS arm64 |
| Node | 24.13.1 |
| 工具链 | `tests/toolchains/vue26-cli`（Vue 2.6.14 + @vue/cli-service 5.0.9 + element-ui 2.15.14，webpack 5 / wds4）；`tests/toolchains/vue27-cli`（Vue 2.7.16 + @vue/cli-service 5.0.9 + ant-design-vue 1.7.8 + TypeScript，webpack 5 / wds4）；`tests/toolchains/vue26-cli4`（Vue 2.6.14 + @vue/cli-service 4.5.19，webpack 4 / wds3，`runtime.env` 声明 `NODE_OPTIONS=--openssl-legacy-provider` 由批准覆盖） |
| 测试 | `tests/unit/toolchain-scenario-cli.test.mjs`，真实 `@vue/cli-service` worker（webpack dev-middleware 内存包） |
| 证据级别 | HTTP/进程级；未用 Chromium，无浏览器侧画面证据 |

## 运行结果

`node --test tests/unit/toolchain-scenario-cli.test.mjs`：**3/3 通过**（macOS arm64，
2026-11-03；三套各约 3.6s/3.6s/4.0s，总时长约 11.6s）。`vue26-cli4` 可运行，无需
记录阻塞原因；其 worker `env` 仅含 `NODE_OPTIONS`，已计入执行指纹并走批准。

## 通过步骤（事实，三个 spec 同一链路）

1. 带 `route` 的场景 `open` → `needs_configuration` + `unsupported_capability`
   （navigation 负断言，CLI 不放开）。
2. 带 `scenario: 'own'` 的 `open` → `ok`/`reachable`；项目 Node handler 挂上
   devServer 自有层并执行（`/api/handled` → `{value:'handled'}`），bodyFile
   fixture 惰性供出（`/api/file-data` → `bin-data`）。
3. `GET /api/orders?n=1` → 404 `unmatched_request`；`status detail` 出现 unmatched
   条目与 `fixtureDraft`。
4. 草稿填进配置后 `refresh`（不带场景）→ `/api/orders` → `{value:'filled-orders'}`，
   其余路径仍如实 404。
5. `refresh` 带 `scenario: 'alt'` → 数据原子换绑（`/api/orders` → `alt-orders`），
   场景名/freshness 如实更新；own/alt 携带不同 `props`，入口真实重写并等 webpack
   编译落盘（写后 invalid→完成编译才认 `applied`，否则 ack `stale`）。
6. 失败路径：场景名不存在 → `config_invalid`，预览仍服务旧场景数据；
   handlers 文件变化 → `config_changed_needs_approval`；bodyFile 缺失 → 仅该请求
   500，其余照常。
7. 修改 `src/Target.vue` → `ImpactService.analyzeNow` 产出本预览候选 →
   `onTurnAnalyzed`（smart）→ `inputs-changed` → webpack 重建，轮询目标异步
   chunk（webpack named-chunkIds 推导名 `js/src_Target_vue.js`，先取证于编辑前）
   取得含 `edited-marker` 的新产物。
8. `src/Target.vue` 写成语法错误 → 编译错误如实落 `freshness: stale`；此时再
   `refresh` 切场景 → 换绑仍原子生效（数据面正确服务），stale 保持不谎报 current。
9. `client.dispose()` 无残留，fixture 清理完成。

## 实现要点（与 Vite 路径同机制）

- 场景数据经 `scenarioEntryValues` 注入临时入口（`__SCENARIO_JSON__`/`__PROPS_JSON__`），
  浏览器侧由 `preview-entry.template.js`/`lifecycle.js`/`mount-vue2.js` 接收（入口内容
  级证据；浏览器内挂载行为无画面验证）。
- Mock/Store 原子换绑在真实监听源就绪后创建（`previewOrigin` 取真实 origin，与 Vite
  一致）；fixture 缺省 origin、remote 通道同源判定均以此为准。
- 编译窗口内 webpack 产物读可能瞬态失败：文档请求与产物请求都在 `invalid→done/failed`
  窗口内等本轮落盘后重查，不把窗口期当 `unmatched_request` 404。
- handlers/setup/env 等执行指纹变化仍返回 `config_changed_needs_approval`（R3-1 授权路径）。

## 结论边界

- 本证据为 HTTP/进程级：场景换绑、fixture/handlers、编译 stale 语义已实测；
  浏览器侧整页重载画面、props/setup 数据在 Vue 2 运行时的真实挂载无证据。
- CLI 的 `scenarioApply`/`scenarioReset`/`refresh` 能力等级保持 `unknown`：
  CLI 不是已验证组合，且无浏览器侧证据。
- Vite worker 的 `TODO(test:r3-2)` 余下项（invalidateAll 缺失回绝、HMR 下 docBuild
  不变）属 Vite 专属路径，本测试不覆盖，继续挂起。
