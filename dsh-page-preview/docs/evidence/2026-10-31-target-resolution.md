# 目标选择器解析

对应方案 §4.2、§5.2、§6.6、§8、§15.3。parseSelector/resolveTarget 已实现，公共 open 与统一 Planner 仍待接入；解析成功只确定选择器与应用绑定，不表示页面可运行。

选择器结构复用 IPC 的同一 Zod 定义，未知/组合字段、绝对文件路径、跨站路由、非 loopback URL 或 URL 凭据明确拒绝，不回显原值。配置中的 selector 仍使用配置协议的独立限制，不改变 schema JSON。

文件请求只使用一个基准：有 projectId 时相对该应用，否则相对工作区。先确定规范路径，再检查其所属应用/声明依赖根，不按不同应用重复尝试输入。文件必须存在且是普通文件，真实路径越界/断链明确失败；环境文件及其别名不作为目标。读取限于元数据，不执行文件内容。

优先已有配置目标 ID、scope、导出名和 route 上下文；文件未指定导出时保留未指定。相同文件对应多个登记目标、同名 registered/story 属于多个应用、路由绑定重叠时返回可选择的候选，不选第一个。绑定歧义独立于运行可行性；其中一项缺失源码时不能静默选中另一应用。已匹配但损坏的配置目标不回退成临时路由。

未登记的 file/route/url，或明确应用内的 story，使用 `<kind>-<规范选择器稳定JSON的SHA256前24位>` 派生 ID；对象键顺序不改变 ID，查询/参数或导出变化会改变 ID。推断候选保留原选择器，不能假装其派生 ID 已写入 registered 配置。无应用选择且多个应用可承接临时路由时返回歧义。

本地路由替换明确的 :name 参数，保留 query/hash；缺失参数、畸形转义和外部来源失败。配置匹配只处理固定路径段和 :name 段，支持 hash 路由；不模拟框架路由优先级、可选参数或自定义正则。静态运行时共用同一 localRoute 转换，避免 Host/Runner 对同一个目标产生不同 URL。URL 请求必须匹配配置的 loopback origin，localhost/127.0.0.1/IPv6 不互相假定等价。

内部 resolveTarget 由同步占位改为异步 Promise，原调用方尚未实现，无已发布接口需要迁移。计划生成仍须验证导出、构建器、数据约束、场景与能力；当前结果不构成执行批准。

验证环境 macOS 15.7.7、Node v24.13.1。10 项定向测试涵盖严格选择器、跨应用歧义、固定基准、真实符号链接/断链/依赖根、多目标与导出、参数/query/hash 路由、派生 ID、绑定损坏和 loopback origin。样本业务模块故意在执行时抛错，解析只读元数据；未读取真实 .env、访问模型或修改业务项目。

实际检查：

```text
npm run typecheck → 退出 0
npm test          → tests 139; pass 139; fail 0; skipped 0
npm run build     → 退出 0
git diff --check  → 退出 0
```

编译后的 lib/core/target/resolve.js 已对原 static-multipage/index.html 实际运行：resolved、projectId=fixture、targetId=index、sourceFiles=1；未执行项目代码。共享路由变更同时通过真实静态 HTTP、Host/Runner 和工具回归。未据此验收 public open、Vue 渲染、目标挂载或真实 DSH UI。
