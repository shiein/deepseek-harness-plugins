# Vue 只读识别

2026-11-01：实现 detectVueApp、构建配置 AST 和组件库精确版本匹配。此记录只证明元数据识别，不证明隔离挂载、构建器兼容或组件库可用。

探测使用插件已有 TypeScript/parse5/semver；只读取清单、实际安装 package.json、构建配置文本和入口文本。共用 shared/profile 的路径、断链、环境文件和元数据错误规则，不加载项目解析器或配置。不读取 .env、不执行脚本、不安装依赖、不生成用户批准。

- Vue 2.6/2.7/3 来自实际安装版本；缺包、2.5 或未知版本保留 unknown。workspaceRoot 显式约束祖先依赖查询范围。
- Vite/Vue CLI 同时存在时保留歧义；可显式指定 buildHost。Quasar/Nuxt 记录不走隔离的原因。
- 静态配置支持字面量入口/别名、defineConfig 对象、CJS 对象、以绝对基准计算的 Node path 表达式和 fileURLToPath(new URL(..., import.meta.url))。动态函数、对象展开、chainWebpack、多配置文件及可执行改写标为 unknown；不执行来补算。
- Vite 从实际 HTML 的活动 module script 找入口，忽略注释、template 和 modulepreload；保留多页面/多入口。内联初始化、外部/参数化脚本要求显式入口。CLI 读取 pages/configureWebpack.entry；无声明才检查 main.js/ts，二者同时存在不猜测。显式 entry 可以绑定动态配置，但不消除别名等其他未知条件。
- profile 必须同时匹配实际安装版本与 Vue 大版本。匹配不改变 verified；所有样本验收状态保持原值。

内部 API：VueAppInfo 新增 entryCandidates、unresolved、isolationExcluded，vue.major 可为 unknown；findUiKitProfile 现在必须接收安装版本和 Vue 大版本。尚未挂接公开适配器，无已有用户配置迁移。

验证：macOS arm64，Node 24.13.1，TypeScript 5.9.3。新增 9 项回归覆盖配置不执行、真实安装与声明范围冲突、多入口/多宿主、动态配置、URL 特殊字符、环境文件链接和损坏元数据。typecheck/build 退出 0；完整测试 tests 231 / pass 231 / fail 0 / skipped 0。编译产物另只读探测 overview/web；业务项目未启动或修改。

剩余：入口 AST 重放、setup 草稿及用户确认、实际 Vue 构建/挂载、HMR、Mock、Tier 1 样本。这里的识别结果不能作为 supported 能力证据。
