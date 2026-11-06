# Vue 隔离只读预检

2026-11-01：vue-vite/vue-cli 的 probe/discover/plan 已接同一 Vue 预检实现。start 仍待实现，适配器尚未加入产品 registry；支持范围保持空，候选能力保持 unknown，不能因 helper 探针通过而开始执行。

probe 按真实 Vue/构建宿主候选、明确模块选择器与 Quasar/Nuxt 排除规则判断。宿主多个时不猜测；用户明确配置 adapter 才绑定对应宿主。discover 只列有界扫描内的真实 SFC，标弱证据和 manualOnly，不把文件列表当成路由或影响关系。

plan 保留原 selector/scope/strategy/requirements，核对实际安装 Vue、构建器和匹配的 Vue 插件版本。不存在的包不安装；不执行项目配置、入口、setup 或编译器，不探测 HTTP。project/attach/static 绑定与 isolated 冲突时明确报错，不借用命令或 origin 绕过。

SFC 使用插件自带 parse5 提取顶层 script/setup/style/template；模板和 custom block 内的 script 不作为 SFC 脚本。JS/TS 导出由 TypeScript AST 核对。相对外部 script/style 在同一真实路径边界内读取；缺失、未声明导出、语法错误、不完整/重复块明确诊断。非相对 src、未知语言、JSX 插件与模板编译仍需要项目编译器证据，不假装已完成编译。

没有 runtime.setup 时，只读分析原入口。只要存在注册、全局样式、业务副作用或未解析初始化，就要求显式 reviewed setup；即使是第三方注册，也不自动执行生成草稿。显式 setup 核对文件和默认导出；动态入口可以由明确手工 setup 绑定，不擅自忽略初始化。执行批准仍由通用 Planner/Runner 的既有用户确认规则处理。

候选 source 指纹覆盖直接目标/外部块、入口、setup、显式 styles、构建配置、应用清单与已有本地锁/TS配置字节；依赖图仍不完整，不能标 current。只读模块本身不产生执行批准。场景/路由/断言/viewport 尚未接通时拒绝；所有网络控制仍为 none，scope/独立渲染 unknown，通用 Planner 不会把该候选当可执行计划。

验证：macOS arm64，Node 24.13.1，TypeScript 5.9.3。新增 9 项测试覆盖 SFC 块/导出、真实元数据候选、候选门禁、变化指纹、配置/入口不执行、手工 setup、外部块缺失、多宿主/缺包/未知版本、CLI 同源规则及环境文件链接拒绝。完整 tests 256 / pass 256 / fail 0 / skipped 0；typecheck/build 退出 0。编译产物只读检查 overview/web/src/App.vue：probe matched=true，plan missing=config_invalid（入口绑定不明确）；项目未启动或修改。

剩余：Vite/CLI start、项目工具链作用域解析、临时入口、Runner 接入和实际样本，Mock/场景/断言与 Client。真实运行后再填写受验证的版本组合，不能用只读测试提升 supported/verified。
