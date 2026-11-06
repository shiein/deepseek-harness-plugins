# Vue 入口重放与 setup 草稿

2026-11-01：实现 parseEntryRegistrations/generateSetupDraft。它们是只读分析和源码生成，不保存文件、不生成执行批准、不执行业务代码。公开 Vue 适配器仍未接通，不据此声明隔离可用。

解析器使用已获准的 TypeScript AST，处理 JS/TS/JSX/TSX。识别 Vue 2 默认导入、Vue 3 createApp/命名空间导入、链式 use/component/directive、prototype/globalProperties 赋值、全局样式和 Vue 2 根选项。原 App/render/mount 不复制。静态 import、纯 const 参数与第三方构造实例按原顺序保留；TS 注解只在草稿生成时擦除。

来源规则结合清单依赖和同源构建配置 AST。相对路径和业务别名默认不重放；参数里混入业务依赖也不能只复制插件部分。未知包、动态别名、条件/封装/可选注册、动态 import、被改写/传出的 const 都有明确诊断。多 Vue 3 根需要手工选择；多 Vue 2 根只保留共享全局注册，不合并不同根选项。副作用 JS import 要求手工确认。实际样式 import 保留顺序及自定义主题，不补造 profile 默认样式。

草稿为纯 JS/ES2018 ESM，所有选中的依赖均在 install 内动态 import；调用者必须先完成 bootstrap/Mock。业务或未解析项在诊断和草稿注释中列出，不能将不完整草稿自动当成原入口替代品。源表达式只留在本地分析对象/草稿中，不进入模型可见诊断或工具结果。必须经用户确认并保存 runtime.setup，再走已有执行指纹确认路径；Agent 不写批准。

当前 setup 契约仍为样本前草案：install 的可选返回值按本次挂载传入 createContext({ installation, ... })。生成草稿用它传递 rootOptions，避免模块级共享实例。原有不返回值的 install 仍可用；当前没有已发布消费者。具体 hook 要在真实 Vue 样本完成后冻结。

验证：macOS arm64 / Node 24.13.1 / TypeScript 5.9.3。新增 10 项定向回归；完整 tests 241 / pass 241 / fail 0 / skipped 0；typecheck/build 退出 0。生成代码通过 node --check，受控子进程使用临时自有包验证 import→use→component 顺序、别名/参数、根实例和两次 install 状态独立。这是编译/执行接缝测试，不是真实 Vue/UI 库样本。编译产物还只读分析 overview/web/src/main.ts，保留动态配置/业务来源诊断，未启动或修改项目。

2026-11-02 补充：分析与草稿已接入计划与用户流程——`planVue` 缺 `runtime.setup` 且入口有注册/诊断时返回 `SetupDraftPayload`（全文 + 第三方/业务/未解析分类项），Host 把全文写入 `<dataDir>/setup-drafts/<workspace-hash>/<projectId>.draft.js`，`open` 的 `needs_configuration` 结果经 `setupDraft` 回传路径与分类项（原文不进工具输出）。真实验收：入口 `app.use(ElementPlus)` + `app.use(./router)` 的项目 open → 草稿路径，零 Runner/零执行；草稿原样保存为 `runtime.setup` 后审批打开为 reachable（`tests/unit/vue-vite-public.test.mjs`）。

剩余：写入项目 `preview/setup.draft.js` 的可选入口、profile 数据参与草稿生成（Vuetify 2 根选项、Naive UI Provider 包裹）、项目作用域依赖解析、真实 Vue 2/3 挂载与 Vite/Vue CLI、HMR、场景/Mock、Tier 1 验收。CommonJS/动态根工厂等不能证明的入口需要手写 setup，不静默执行来补算。
