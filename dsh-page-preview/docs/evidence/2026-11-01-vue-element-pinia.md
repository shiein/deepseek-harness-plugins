# Element Plus 与原 Pinia 初始权限场景

2026-11-01：自有样本已通过三个独立初始场景的真实浏览器验收。它们使用同一原业务权限函数与 Pinia Store；插件只把场景数据经显式 reviewed setup 写入原 Store，没有另一套授权实现。

组合：macOS arm64 / Node 24.13.1 / Vue 3.4.27 / Vite 5.2.12 / plugin-vue 5.1.4 / Element Plus 2.14.2 / Pinia 2.1.7 / IAB Chrome 156。样本源码由 tests/helpers/vue-element-fixture.ts 生成，Element Plus/Pinia 仅借用 overview/web 的已安装官方包；没有执行来源项目、读取其 .env、修改业务文件、安装新依赖或调用模型。

## 绑定

原入口 app.use(ElementPlus) 与 index.css 全量注册；显式 setup 安装同一 Pinia、Element Plus 与 ElConfigProvider（中文、small 尺寸），然后 applyScenario 在目标动态导入前按项目约定 $patch 原 Store。原 permissions.js 的 canRead/canEdit/permissionMode 决定页面内容、输入 readonly 和编辑按钮；初始身份没有读写 Cookie/Storage。目标是原 JS SFC 的 OrdersPage 命名导出，default 若被错误选择会抛错。

主题来自项目自己的 theme.css，保留原组件库样式。三个场景各使用新的自有临时工作区/执行器，验证初次应用；没有用重启、换端口或清 Storage 冒充同一预览的角色切换，scenarioReset 仍 unsupported。

## 真实浏览器结果

| 初始场景 | 原业务 UI 证据 | Host / Root / worker / port |
| --- | --- | --- |
| viewer | sample-viewer / read only；标题值 Original Pinia order；readonly 属性存在，Edit order 禁用。原 DatePicker 展开后显示“前一年、上个月、2026 年、11 月、星期日”等中文内容 | 85395 / 85398 / 85457 / 53147 |
| editor | sample-editor / editable；原编辑 action 使 Pinia count 从 0 变成 1，输入可修改。原 ElButton 观察时的 hover 背景 rgb(155, 106, 240)，对应项目自定义 light-3；small 高度 24px | 86733 / 86736 / 86739 / 53398 |
| denied | sample-denied / denied；显示 Access denied by original permission function，订单输入、计数/编辑按钮和日期控件均不呈现 | 87351 / 87451 / 87481 / 53645 |

三个编译完整 apply→实际锁定 SDK→Root→worker 的公开 status 均为服务/文档/目标三层 proven、ready，无 runtime_error/compile_error；freshness 仍 unverified。网络 coverage 仍全部 none，默认 mock-only 保持阻断；样本只保存空 requirements 并额外要求 isolated-target，没有放行真实后端。

记录目录分别是 output/vue-element-pinia-viewer、output/vue-element-pinia-editor、output/vue-element-pinia-denied，均有 ready-status.json、browser-state.txt、public-observations.json 和 cleanup.json。截图为 viewer-calendar.png、editor-state.png、denied-page.png。所有标签已关闭，Host/Root/worker/端口、临时目录与账本均独立确认清理。

## 自动检查与限制

实际检查：

```text
npm run typecheck  # exit 0
npm run build      # exit 0
ℹ tests 315
ℹ pass 315
ℹ fail 0
ℹ skipped 0
```

新增一个公开 SDK 回归分别编译三种初始场景，检查原 JS 命名导出、传递权限数据、源码哈希不变和正常 stop。UI/原 Store 行为以上述浏览器证据为准，HTTP 编译成功不能替代它。组件库名只出现在样本与既有 profile 数据中，生产 core/Vite 没有新增库分支。

Element Plus profile verified 仍 false。resolver 按需引入尚待工具链批准后实测；完整角色切换、缓存/旧事件流重置、全局弹层 API、Native 产品及真实业务样本未被此项覆盖。Vue 2/CLI 和其他矩阵也继续保留待办，不能将部分全量注册验收当成整个 Tier 1 完成。
