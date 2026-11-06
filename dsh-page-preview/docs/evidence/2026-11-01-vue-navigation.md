# Vue 文件目标的初始路由上下文

2026-11-01：Vue/Vite 的明确文件目标可通过已审核 setup 连接项目自己的路由。没有添加插件专用 Router、空路由容器或平行权限判断，也没有把业务地址改成自有服务的页面路径。

## 接口与顺序

现有目标/scenario 的 route 和 Planner 的优先级保持不变，计划保留 path/params/query。只读预检通过 localRoute 核对具体本地路径、必需动态参数及 query/hash；缺 setup、外部路径、未填参数、CLI 或视口控制继续明确拒绝。route 选择器自动发现与 shell 渲染仍未实现，本项只支持已绑定文件。

setup 增加可选 hook：

```js
async navigate({ route, href, context, installation }) {
  await context.router.push(href)
  await context.router.isReady()
  return context.router.currentRoute.value.fullPath
}
```

href 由同一 localRoute 规则生成，含具体参数/query/hash。项目绑定负责建立原 Router、安装原守卫、必要布局和等待导航，返回真实最终本地路由字符串。插件比较 path、query（忽略参数键顺序，保留重复值）和 hash；缺 hook、无返回、抛错、拒绝或跳登录均停止初始化并执行 dispose，不发挂载信号。错误不回显原路由/项目值。这个返回值是受信任 setup 的契约，不能独立证明任意项目绑定没有虚报结果。

顺序为网络准备→框架/setup→install/createContext→applyScenario→navigate→插件的 loadTarget→挂载/nextTick→初次断言。原 Router 在导航中解析自己的懒组件仍是项目行为，不拦截或替换。浏览器地址保持自有预览文档；本样本使用原 createMemoryHistory，不冒充 history 路由、完整跨页导航或真实地址栏语义。

## 实际证据

macOS arm64 / Node 24.13.1 / Vue 3.4.27 / Vite 5.2.12 / plugin-vue 5.1.4 / vue-router 4.3.2 / IAB Chrome 156.0.0.0。只从 overview/web 借用已安装包，项目源码、配置、原权限函数、Router 和布局全在自有临时目录；未启动/修改业务项目或读取其 .env，没有新安装依赖或模型调用。

- 允许样本：Host <pid> / Root <pid> / worker <pid> / port <port>。原布局和真实 SFC 显示 id=42、tab=active、note=from fixture、hash=#details、完整路由；原计数 0→1。服务/文档/目标三层 proven、ready，freshness=unverified。
- 原守卫实际执行 2 次，包含 Router 安装时的初始导航。首个样本断言误写 1 次，未声称 ready；改为断言真实目标路由后重新跑独立样本，没有删掉原导航或守卫。
- 拒绝样本：Host <pid> / Root <pid> / worker <pid> / port <port>。空权限进入原 canReadOrders/原 beforeEach，最终 /login，守卫 3 次。项目测试绑定把这一结果显示为诊断；目标标题和按钮数量均为 0。公开 status 保持 targetMounted=unverified，期限后 failed/target_not_ready；没有把登录路径或诊断文字认作业务页 ready。
- 两个样本及首次允许样本的浏览器标签、Host/Root/worker、端口、临时目录和账本均独立核对清理。

记录见 output/vue-navigation-allowed-final 与 output/vue-navigation-denied 的 browser.png、browser-state.txt、ready-status.json / failed-status.json、cleanup.json。测试批准为锁定官方 ApprovalService 的合成答复，不代表真实用户 UI 验收，不给业务项目创建批准。

4 项新增回归覆盖只读计划/缺绑定/非法 route、准备与导航顺序、缺 hook/重定向/异常的清理，以及公开 SDK→Root→worker 传递/编译/源文件不变/停止。修改前 3 项接缝测试均失败，修改后通过。最后实际输出：

```text
npm run typecheck  # exit 0
npm run build      # exit 0
ℹ tests 323
ℹ pass 323
ℹ fail 0
ℹ skipped 0
```

此前一轮完整检查为 pass322/fail1：既有 invalid handler exports 清理用例出现 cleanup_failed，后置 dispose 完成；同用例单独复查及随后完整 323 项检查均通过。根因尚未稳定复现，保留为清理稳定性待查项，没有放宽断言、吞异常或把复测称为修复该问题。

## 兼容性与剩余范围

未改变工具参数、schema、私有 IPC 字段或持久化格式；入口模板和浏览器 helper 需随同一包构建。无 route 的现有 setup 不需要 navigate。此前 route 请求被拒绝；现在仍需审核绑定及原有执行项批准，不能只靠返回某个字符串声明所有项目路由已支持。回滚会恢复这类请求的预检拒绝，无数据迁移。

证据限上述精确 Router/工具链/浏览器与初次上下文。Vue 2/CLI、其他路由器/版本、Native、路由发现/父布局自动推断/跨页导航、完整角色重置和视口均待验。Vue network coverage 仍 none，默认 mock-only 保持阻断，UI profile 未提升。静态 Node handlers/初始化仍未接入，不能把项目模块直接加载进共用 Root 来跳过每预览执行器约束。
