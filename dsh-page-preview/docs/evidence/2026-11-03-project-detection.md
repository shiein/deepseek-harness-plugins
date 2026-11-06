# 只读应用识别

目标是为手动预览提供应用边界和可追溯画像。`shared/profile.ts` 是 Host/Runner 的共同实现。它只解析 JSON/YAML、目录项和包版本，不 import 构建配置、运行项目模块或执行脚本。

- 识别 npm/yarn `workspaces` 数组或 `packages` 对象、`pnpm-workspace.yaml` 的正负 glob。纯工作区管理根不冒充应用；有自身入口/构建配置/框架依赖的根保留为候选。
- 包清单、已知构建配置文件和无清单 HTML 可以形成候选根。嵌套应用的源码不计入父应用。HTML 子页面归到上层 HTML 应用，不按遍历顺序随机拆分。
- 默认跳过隐藏目录、node_modules、dist/build/output/coverage 和符号链接目录。显式配置的生成物根仍可检查。单次目录扫描上限 5000 个条目，达到限制在画像 unresolved 中说明；空目录不伪造应用。
- 源文件后缀只作为候选语法证据，不能据 `.ts` 推断 React，也不据 `.js` 排除 JSX。框架依赖和构建配置存在都只是 candidate；不等于已验证适配能力。
- 框架/构建器版本来自应用至工作区根的 node_modules 中实际 package.json；未安装时保留未知，不把声明范围当成实际版本。只返回合法 Node 范围和包管理器版本，不返回脚本正文或 `.env` 内容。
- 已存在但损坏的 JSON/YAML、非法结构、断链、环境文件别名明确报错。不把错误当作无配置继续猜测。

`shared/config/projects.ts#loadWorkspaceProjects` 先复用唯一来源加载器。已配置根保持整份配置；其他候选根使用 source=detected、空 runtime 和 `app-` 加工作区相对根稳定 JSON 哈希前 24 位的 ID。该过程不写配置或执行批准。ID 被显式配置占用时要求配置明确映射。显式来源只检查所选应用，不追加检测结果或读取无关工作区清单。

公共 open 接入时进一步固定范围：配置应用已经拥有的普通 HTML 子目录不再生成另一个检测应用；独立清单/构建配置仍作为嵌套应用边界。Host 与 Runner 使用相同规则，避免同一静态页出现虚假歧义。

验证：13 项定向测试覆盖 npm/pnpm 边界、排除模式、不同 Vue 版本、未安装版本、含 JSX 的 JS、无清单多页、嵌套应用、生成物显式根、绝不执行构建配置、损坏来源和断链；配置集成覆盖来源优先级、稳定 ID、规范工作区别名和显式来源隔离。完整回归实际输出 tests 174 / pass 174 / fail 0 / skipped 0，typecheck/build 退出 0。编译产物只读检查 overview 得到 web 应用、Vue 3.4.27 和 Vite 5.2.12 候选，未执行/修改该业务项目。它们不证明 Vue 隔离、项目命令、公共 open 或 DSH 产品联动已经完成。
