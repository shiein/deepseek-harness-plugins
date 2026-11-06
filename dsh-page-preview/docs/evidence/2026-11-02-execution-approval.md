# 执行指纹与用户批准存储

2026-11-01 已完成共同执行指纹 v2、私有文件批准存储及官方 ApprovalService 接缝，并接入公共项目命令/Runner 复核。用户已批准直接 peer/dev 依赖并完成声明，见 execution-approval-dependency.md。222 项回归和编译完整插件入口已验证；实际 Agent loop/原生用户 UI 仍未验证，不把合成测试答复当作真实用户确认。

## 指纹与记录

实际复现了 v1 的缺口：只含 env 的项目从应用根 a 改到 b，执行指纹仍相同。v2 始终绑定规范 appRoot；命令实际 cwd、显式 env、setup/handler 声明路径、规范位置、内容和场景绑定保持原规则。规范路径相同的目录别名仍得到同一指纹。Host/Runner 共用 shared/config/fingerprint，core 原路径兼容导出。

批准记录按规范工作区和项目 ID 保存在插件数据目录 approvals/ 下。只保存当前已批准指纹、各执行项标签/哈希、时间和确认会话/调用 ID；不保存命令参数、环境值和源码。写入使用私有目录、0600 临时文件与 rename；缺失查询不创建目录，损坏/错工作区/错项目/未知版本/链接记录明确失败。更新批准会替换旧指纹，不能把之前的任意哈希都算作仍有批准。

ApprovalStore.approve 仅供可信用户确认路径调用，不作为 Agent 工具、配置字段或模型可传参数。测试中的合成用户确认只写到临时目录并删除，没有为真实工作区创建批准。

内部 ExecutionItems 从 v1 改为 v2，配置 JSON 和工具参数不变。此前没有已实现/发布的批准记录需要迁移；旧内存计划重新预检，旧指纹不自动继承批准。

## 官方确认接缝

requestExecutionApproval 只接受 Host 持有的官方 service 和真实执行上下文。服务/Agent 缺失、会话身份不匹配均不写记录；SDK 要求开放轮次，负责 asked/decided 审计并在取消时丢弃迟到答复。原始命令仅在非持久化 displayReason 给用户检查；reason 只含项目 ID/指纹，环境只展示名称。

UI 明确请求“批准本工作区/项目本次预览运行的执行项”，文案写明批准只覆盖本次运行、之后再次运行需要重新确认，不把一次运行许可暗中扩大为长期授权。展示体含四段（P1-12）：当前执行项（命令原文/环境变量名/setup·handler 路径）、`Changes since the last approval` 人读差异（`- setup file setup.js changed`、`- environment variable EXTRA added (value is never shown)`，区分 added/changed/removed；首次批准明示全部为新增，无差异时如实写 `- none`）、`Details (component hashes)` 十二位组件哈希对照、64 位整体指纹。差异只描述组件标签、绑定路径和状态，环境值与文件内容不进展示体。只有 allowed-once 可以进入后续复核：重新加载同一配置来源、核对项目配置和执行项字节，再写批准。确认期间变化返回 changed；拒绝/取消/通道缺失保持未批准。项目命令执行前还必须在 Runner 复核当前指纹，不能由 Host 的一次计算替代。

## 已验证与未验证

typecheck/build 退出 0；完整回归实际输出 tests 204 / pass 204 / fail 0 / skipped 0。存储覆盖缺失零分配、工作区/项目/指纹隔离、目录别名、替换、0600、无原文、损坏/错身份/链接拒绝和应用根变更。原有执行项失败路径仍通过。

7 项官方 service/SessionStore 接缝测试覆盖每次调用均重新询问、文案不暗示持久化、拒绝/无答复/异常、取消迟到答复、确认期间变更、缺失/错身份、无开放轮次及审计提交失败。后续 public open→批准→真实命令与编译 apply 验证见 project-command.md；Runner 在接收和 spawn 前均重新核对当前批准。官方批准/审计异常单独报告确认阶段，不伪装为 Runner 连接问题；没有审计结果就不写批准。Agent 为最小合成身份对象，不驱动模型，不等于真实 Agent loop 或原生 UI。

编译只读预检可用 verify-config-preflight.mjs 对自身 non-vite-existing-server 样本复现 v2 与原文件哈希不变，不运行项目命令。原生产品安装、真实用户 UI、完整执行恢复和其他平台不据此宣称通过。

## 2026-11-02 一次性授权语义修正（P1-7）

对本机安装的 DeepSeek Harness.app 内 `dsh-client-ui-approval@0.2.1-rc.5`（与锁定 SDK 同版）的核实结论：官方 UI 按钮为「允许一次 / Allow once」与「拒绝 / Reject」；`ApprovalOutcome` 只有 `allowed-once` 一种授权，SDK 无 `allow-always`、无记忆规则、无撤销接口、无内置批准库，每项批准只适用于对应请求。

此前实现把 `allowed-once` 当作长期批准：`isApproved` 命中即跳过询问，记录无限期复用。现改为一次性执行链语义：每次 `open` 都必须经官方 `ApprovalService.request` 询问；写下的记录只作为链内差异对照与临时授权凭证，由 `SessionRegistry.chains`（previewId → workspace/project/owner）界定有效期——链存活期间 Runner 的多次复核（分配前、worker boot、handler import、发布前）和同一预览的同计划重复 `open` 复用该记录；链到达终态（`failed`/`stopped`/`cleanup_failed`）且无同项目其他存活链、本 owner 无其他存活预览时，记录只按授权人 sessionId 匹配删除。链外残留记录在询问前惰性清除，不算授权依据。过期语义不受影响：指纹变化仍返回 `config_changed_needs_approval`。

证据：`project-command` 公开测试覆盖「链存活时同计划 open 免再问 → stop 消费记录 → 同指纹再 open 重新询问并开新预览」；接缝测试断言文案含 "this preview run only" 且不含 remember/reused；存储新增 `remove` 覆盖精确删除/缺失容忍/路径拒绝；364 项回归通过、0 跳过。未验证项：原生弹窗真机展示未截图，按钮文案以 app 包内 locale 资源为准。

## 2026-11-02 弹窗内容人读化与 locale 修正（P1-12）

对本机 app 包 `dsh-client-ui-approval`/`dsh-client-locale`/`dsh-client-ui-chat` 编译产物实读的结论：弹窗 headline 渲染 `displayReason`（经 `ctx.locale.resolveText` 本地化解析）；等宽详情块由 `conversation.approval.detail` 槽渲染，占用者 `ApprovalCommand`（client-ui-chat）只回显工具参数的 `command` 字段——本插件工具参数无该字段，详情块天然为空，`displayReason` 是唯一内容载体。

据此 `requestExecutionApproval` 的展示体重构为四段：当前执行项（命令原文/环境变量名/setup·handler 路径）；`Changes since the last approval` 人读差异——按 added/changed/removed 描述「哪条命令、哪个文件、哪个变量变了」（`- setup file setup.js changed`、`- environment variable EXTRA added (value is never shown)`），首次批准明示全部为新增，无差异如实写 `- none`；`Details (component hashes)` 十二位哈希对照；64 位整体指纹。环境值、文件内容与源码不进展示体（该边界有测试断言）。

**修正的缺陷**：displayReason 中文文案原挂在 `'zh-CN'` 键，官方 `resolveText` 只查 `zh`/`en` 键（内置 locale 仅 `zh`、`en`）——中文用户实际回退到英文文案。已改为 `zh` 键并有断言。未验证项：原生弹窗实机渲染（官方 CSS 无 `white-space: pre-wrap`，`\n` 塌陷为空格，`- ` 项目符仍保留可读结构）；「哈希放进 `conversation.approval.detail` 详情块」需注册已被占用的 single 槽、会遮蔽官方渲染器，未做。

## 2026-11-02 R2-1/R2-2：一次性授权改经 start IPC 传递，批准不再落盘

第二轮 review 指出原实现过复杂且有竞态：批准写持久文件、内存 `chains` 表异步消费、Runner 启动中多次重读文件；同项目切换目标时旧链 `releaseChain` 可能在新链登记前删掉记录，使在飞启动在执行前复核时失败。

现改为：官方 `allowed-once` 之后 `requestExecutionApproval` 只把 `{fingerprint, hashes}` 交还 Host；`SessionRegistry` 用内存 `grants`（key = workspace+projectId+owner+fingerprint → 授权与链上 preview 集合）维持有效期；`buildPlan` 在批准门禁通过时把执行项指纹附在 `PlanOutcome.executionFingerprint`，Host 将其作为 `start` 消息的 `approval.fingerprint` 发给 Runner；Runner 在接收时与执行前（`verifyCurrentExecution`）各自重算当前指纹并与消息携带值核对，不再读盘。弹窗差异对照的「上一次批准」改由存活授权的内存哈希提供。

用户可感知行为不变：每次 open 都需一次批准；同项目同执行项的链内 open/切换目标不重复询问；链全部终止后再次运行重新询问。竞态测试（双目标切换 + 链终止再开）与「无指纹/错指纹 start 被拒」均有覆盖；持久化批准存储 `shared/config/approvals.ts` 与其测试一并删除。
