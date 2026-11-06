# 配置校验与来源

对应方案 §8、§15.3。配置校验不会执行命令、加载 setup/handler、读取 `.env`、启动服务或生成执行批准。

2026-10-31 接入说明：schema/loader/paths 的唯一实现已放到 shared/config，core 原路径兼容导出；协议和 JSON Schema 不变。Runner 使用同一来源加载器重读配置，并比较完整 project 的稳定 JSON 指纹。带执行项的配置当前一律拒绝，ApprovalStore/用户批准交互尚未接通；无执行项的 static 文档已完成内部 Host→Runner 验收，见 [执行链路](2026-11-03-runner-ipc.md)。下文分项检查数量为各次提交时的历史结果。

## 结构与语义校验

`validateConfig(unknown)` 使用项目已有的 Zod `4.4.3`，返回校验后的配置或 `{path, message}` 问题列表。未知字段/版本、重复项目/目标 ID、重复 requirements、缺失默认场景、策略/适配器冲突和 project/attach 必需/禁止项均明确失败。

相对路径字段拒绝 POSIX、Windows 和 UNC 绝对路径；`command.cwd` 同样相对应用根。URL 目标限定为显式 loopback 来源且不带凭据。结构层不判断相对 `..` 是否越界，加载时另做下文真实路径检查；通过不表示页面可运行或已批准执行。

结构 JSON Schema 通过 `node scripts/generate-config-schema.mjs` 生成，单测核对仓库文件与生成结果一致。跨 ID/场景引用等语义不能仅由该结构 schema 保证，调用者必须使用 `validateConfig`。TS 补充了原 JSON Schema 已允许的可选 `$schema` 字段；其余字段名称和配置版本不变。没有已发布配置需要迁移；绝对 cwd 等违反原方案的输入现在会明确拒绝。

8 项定向测试已实际通过，包含方案 JSON 示例、完整可选字段、失败分支、诊断不回显合成敏感值，以及 JSON Schema 一致性。执行项指纹批准和 RunnerClient 仍未据此完成。

本项提交前实际检查：`npm run typecheck` 退出 0；`npm test` 输出 `tests 61; pass 61; fail 0; skipped 0`；`npm run build`、脚本语法和 `git diff --check` 均退出 0。

## 来源加载与真实路径

`loadEffectiveConfigs(workspaceRoot, explicit?, {dataDir?})` 不创建/写入配置，不从进程环境猜测插件 profile。工作区和传入的插件数据目录必须为绝对路径。

- 显式文件可为绝对路径或相对工作区路径，选择其完整内容；不存在/损坏时明确失败，不读其他来源。
- 默认读取工作区 `page-preview.config.json`，再按项目 ID 补充本地配置。相同 ID 只用完整 repo 项目，local 不读取、不合并，通过新增 `EffectiveProjectConfig.diagnostics` 返回 `config_source_ignored`。
- 本地目录由 `localConfigDirectory` 计算：`<dataDir>/config/<规范工作区路径 SHA-256>/<项目ID>.json`。每文件使用同一版本化协议且只含该项目；不同工作区分开，工作区的符号链接别名映射到同一目录。调用方未提供 dataDir 时只查 repo。
- 配置全部缺失时返回空数组，供后续 Detector 处理；不伪造 detected 配置。存在但坏 JSON、读取失败、目录或断链均报错，不当作“未配置”。结构/路径失败携带 ConfigLoadError 的字段问题，读取错误保留原错误；JSON 语法错误不回显原内容。

应用根必须是规范工作区内的现存目录。setup、styles、entry、publicRoot、command.cwd、文件目标、handler 与 bodyFile 统一用 `resolveProjectPath` 检查，按应用根与声明的 dependencyRoots 解析真实路径。不用字符串前缀判断范围；未创建的末级文件仍核对最近父目录，断链拒绝，防止丢失链接实际指向。自动 repo/local 配置文件自身不能通过符号链接越过来源根，`.env*` 在读取前被拒绝。

dependencyRoots 仅描述查询范围；配置加载不批准执行、不创建批准记录，后续执行仍须检查用户批准的执行项指纹。相对字段保留原值，使用路径的后续模块应再次调用同一解析函数，不把此检查当成未来文件不变的保证。

11 项真实文件系统测试通过，使用 macOS `15.7.7` / Node `24.13.1` 的可丢弃临时目录；覆盖显式/repo/local、工作区隔离、坏来源不回退、真实符号链接、断链、所有路径字段及模块不执行。初轮两个断言误用 `/var` 临时别名比较规范 `/private/var`，已修正测试路径基准；实现继续返回真实路径。其他平台尚未实测，不据此声明兼容。

内部接口新增可选 loader options、必填 EffectiveProjectConfig.diagnostics；尚无已实现调用方需要迁移。配置 JSON 版本和字段不变。

来源/路径项提交前实际检查：`npm run typecheck`、`npm run build`、`git diff --check` 退出 0；`npm test` 输出 `tests 72; pass 72; fail 0; skipped 0`。

## 执行项指纹

后续修正：共享 JSON 指纹改用与 locale 无关的键排序。真实 Node 子进程中 en-US 与 sv-SE 对 ä/z 的 localeCompare 顺序不同，而 Host 与独立环境 Runner 可能使用不同 locale，会把相同配置误判为变化；三种 locale 和反向插入顺序已有回归。尚无已实现批准存储或已发布数据需要迁移；旧内存计划需重建，不自动复用不同哈希的批准。

`collectExecutionItems(appRoot, project)` 只读取显式命令/env 和经过同一路径核对的 setup/handler 字节；返回内容哈希，不导入模块或读取 `.env*`。缺失模块、越界、环境文件及无效 cwd 明确失败，不用空哈希冒充通过。命令参数与环境复制后参与内部计算，不回传模型，也不继承 Host 环境。

原草案只保存路径/内容集合，交换两个场景的 handler 后集合仍相同，会错误复用旧批准。现在 ExecutionItems version 1 同时包含 setup/场景绑定的声明路径、规范位置和命令实际 cwd。命令、参数顺序、环境、字节、声明引用、链接目标或场景归属变化都改变指纹；mtime 和对象键顺序不改变指纹。文件原文不进入返回值。

8 项定向测试通过，包含真正写入并哈希的模块、抛错模块不被执行、字节变化与 mtime 区别、handler 互换、相同内容的链接目标变化、cwd 链接变化，以及失败路径。全部使用可丢弃临时目录，未写批准记录。

这是内部执行项格式变更，配置 JSON 不变。ApprovalStore 仍只有接口，尚无已持久化批准和已实现调用方需要迁移；后续接入必须由用户确认并在实际执行前检查指纹，不能把本轮收集或通过测试当作执行批准。

2026-11-01 后续：执行项已升级 v2，始终绑定规范应用根；共享实现、批准文件存储和官方确认接缝见 execution-approval.md。204 项回归通过，但产品入口和 Runner 授权执行闭环尚待接入，直接 SDK 确认服务依赖授权仍待用户答复。上面的 v1/80 项是原阶段记录，不当作当前执行批准。

指纹项提交前实际检查：`npm run typecheck`、`npm run build`、脚本语法及 `git diff --check` 退出 0；`npm test` 输出 `tests 80; pass 80; fail 0; skipped 0`。

自动化覆盖：`tests/unit/config-loader.test.ts`、`tests/unit/config-fingerprint.test.ts`、`tests/unit/planner.test.ts`（schema→loader→路径核对→指纹收集全链路）。原 `scripts/verify-config-preflight.mjs` 已随 R4-5 删除；历史记录：它读取用户已授权的 `/Users/aesc/Documents/workspace/demo/dsh-page-preview-non-vite`，只在仓库 `output/phase1/config-preflight` 写入合成配置和摘要，没有执行配置中的命令，6 个样本文件 SHA-256 均未改变。

实际输出：

```json
{"platform":"darwin","node":"v24.13.1","selectedSource":"explicit","projectCount":1,"executionItemsVersion":1,"fingerprint":"4dc7d88a34120171b3b89757d437dee09f6e9936e32d203daa38bfb8dda901d6","sourceHashesUnchanged":true,"mode":"configuration-only"}
```

这仅证明只读配置预检链路，不代表策略能力、命令执行、页面就绪或完整 Runner 生命周期通过。
