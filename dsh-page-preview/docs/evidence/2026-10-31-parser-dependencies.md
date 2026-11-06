# 只读解析依赖确认清单

用于方案 §5.1、§5.2、§6.9、§11：Host 必须只读项目文件，JS/TS/JSX 入口重放必须使用 AST，UI 库版本必须按真实 semver 范围判定。Node 没有内置 HTML、YAML 或完整 JS/TS/JSX AST 解析器；不执行项目自己的解析器/构建配置来绕过 Host 边界。

拟新增为本插件的 dependencies，固定版本：

| 包 | 版本 | 用途 | 当前事实 |
| --- | --- | --- | --- |
| typescript | 5.9.3 | 解析 JS/TS/JSX 的 import/export、入口注册和依赖关系；只调用编译器解析 API，不执行业务模块 | 已是本仓库 devDependency、已安装；改为运行时依赖，不升级 |
| parse5 | 8.0.1 | 正确解析 HTML 的 script/link/base 与 SFC 脚本块位置，避免正则把注释/脚本文本当成真实入口 | 未安装；版本/API 已核对官方发布页与文档 |
| yaml | 2.9.1 | 只读 pnpm-workspace.yaml 工作区声明 | 当前已作为间接依赖安装；改为显式运行时依赖，不升级 |
| semver | 7.8.5 | 精确核对已安装 Vue/构建器/UI profile 的版本范围 | 当前已作为间接依赖安装；改为显式运行时依赖，不升级 |

parse5 官方依据：[发布记录](https://github.com/inikulin/parse5/releases)、[解析与源码位置选项](https://parse5.js.org/interfaces/parse5.ParserOptions.html)。其余版本来自当前本地安装包 package.json。依赖只安装到插件仓库，不自动安装/更改目标业务项目依赖、不升级 DSH、不调用模型。TypeScript 会增加插件运行时体积；改用自写 AST/版本/YAML 解析器会增加维护和错误成本，因此选择现有解析器。

项目 AGENTS.md §9 要求新增运行时依赖先获用户同意。2026-10-31 用户已批准本清单；已按固定版本安装并更新 package.json/锁文件，安装时使用 ignore-scripts，DSH 包版本不变。四个模块实际 import 成功，typecheck/build 退出 0，完整回归 tests 139; pass 139; fail 0; skipped 0。依赖安装本身不代表解析功能已经完成。

安装时 npm audit 报告 37 个 high 受影响包，均追溯到原有锁定 zod@4.4.3 的同一个内存耗尽告警（不是 37 个独立漏洞）；本次四个解析包未被命中。已核对 [GitHub 官方漏洞记录](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)：修复版本为 4.6.6。多个 DSH 0.2.1-rc.5 包精确依赖 4.4.3，仅升级插件顶层 zod 不能修复宿主/SDK 中的该版本；未做 npm audit fix、覆盖 SDK 依赖或升级用户 DSH。此项保留到兼容性/发布门槛评估，不把当前锁定 SDK 宣称为已消除告警。
