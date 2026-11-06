# 托管项目预览命令

project-command 已接入 public open→官方用户批准接缝→独立 Runner→托管子进程。它运行明确配置的原项目命令，不推断 dev 脚本、拼接自然语言 shell、安装依赖或生成替代页面。当前提供原服务观察模式；通用代理/Mock、场景、Vue 隔离和产品 Client 仍按进度表开发。

## 启动与批准

配置须包含 executable/args/cwd、probePath、serviceDeadlineMs 和明确的目标 route/URL；文件须有显式 route 映射。可提供固定 loopback origin，否则在启动后查找唯一的自有 loopback HTTP 监听端口。绝对可执行文件缺失/不可执行在只读预检报告；裸命令按显式子进程环境解析，缺失时报告，不自动改命令或安装依赖。建议使用明确的绝对可执行路径，或配置所需 PATH。

probe/discover/plan 不执行脚本/构建配置或发 HTTP。默认/已保存 mock-only 不会被工具请求清空；只有已授权、保存 requirements:[] 的观察配置可走当前无数据边界的通用路径。需要 Mock、隔离渲染、setup/handler、场景、视口或断言时明确拒绝，不能以整站服务冒充组件隔离。

Core 查询当前执行指纹批准。完整预检唯一剩余条件是批准时，Host 才消费官方 ctx.approval：原始命令只在用户界面展示；界面给出来源、应用根、执行项变化和哈希，明确请求“批准本工作区/项目本次预览运行的执行项”（官方只有「允许一次」，链终止后再次运行需要重新确认）。缺少服务/Agent/开放轮次、拒绝或取消均不能创建批准。确认期间重读配置和字节，变化后不记录旧提案；批准后重新执行完整预检。

Runner 在接收计划时核对批准，并在真正 spawn 前再次重读配置/指纹。执行项变化优先返回 config_changed_needs_approval；其他配置变化使旧计划无效。批准只能来自可信用户服务，没有 Agent 可填写的 approved 参数或 approve 工具。

内部 PreviewPlan 始终保留真实命令。公开 plan/detail 使用 DisplayedPreviewPlan，managed 进程省略 args/env，显式标注 executionDetailsOmitted:["args","env"]。它不可作为可执行计划，不能把省略误读为空参数；未发布的工具输入/配置 JSON 不变，后续调用方应使用展示类型。

## 运行与清理

spawnManaged 使用 shell:false、明确 cwd 和显式 env，不继承 Host 环境。用户批准的原项目代码仍以本机权限运行，可能自行读文件、环境或访问真实服务；这不是 OS 沙箱。项目自身构建输出需单独记录，插件不改业务源码、清单、锁文件或构建配置。

进程先按 PID/PGID/启动时间登记。Runner 通过实际进程树和 lsof 监听核对端口，归属成立后才发无凭据 GET 探针，不从 stdout URL 猜来源。固定来源被其他进程占用时拒绝，不向其试探；动态发现多个端口要求配置来源，不取第一个。服务探针启动期可重试至明确截止时间，重定向始终不跟随。

HTTP 观察沿用 attach 的共同实现：正常时每次完成后间隔 1 秒探测、单次最多 2 秒；失败或实际进程退出进入失败清理。服务成功仅为 reachable，文档/挂载与 freshness 仍 unverified；没有原生 HMR/编译错误或当前画面验证就不宣称提供这些能力。所有数据通道 none，真实后端访问仍可能发生。

原始 stdout/stderr 持续排空，避免管道反压，但不自动转发/持久化，防止项目日志带出凭据。启动/退出、期限、归属和清理结果以安全诊断报告；这不等于采集了业务运行错误，能力保持 unknown。

stop 取消自身观察，按进程身份停止拥有的进程树，核对端口消失后释放账本。启动失败、超时和端口歧义执行同一回滚；残留或无法核对时 cleanup_failed，不伪造 stopped。取消工具等待不丢失已受理预览，status/stop 可找回。已有用户服务继续由 attach 管理，不能被此路径接管或误停。

## 实际验证

2026-11-01，macOS arm64、Node v24.13.1、DSH SDK 0.2.1-rc.5：typecheck/build 退出 0，完整回归 tests 222 / pass 222 / fail 0 / skipped 0。覆盖无副作用预检、映射/要求/绑定拒绝、执行前校验器、批准前零分配、明确环境/字面参数、批准复用/变化重问、来源被他人占用、多端口歧义及显式来源选择、启动期限/退出、取消提问和受理后取消、批准审计提交失败、空闲调用者、Runner 拒绝旧计划，以及实际 PID/端口/账本清理。

自动化覆盖：`tests/unit/project-command.test.mjs`（完整 apply 入口→官方确认→真实命令→清理）与 `tests/unit/execution-approval.test.mjs`（批准先于分配、同指纹一次提问、参数/环境省略）。原 `scripts/verify-project-command.mjs` 已随 R4-5 删除；历史记录（Host <pid>、Root <pid>、命令 <pid>，六个原文件不变，stop/dispose 后无自有 PID/端口/账本残留）见 output/project-command.json。

SDK/插件入口/真实进程均为实际执行；Agent 身份与用户答复为隔离测试合成，不驱动模型，不等于真实 Agent loop 或原生用户弹窗验收。没有访问用户 DSH profile、生产数据或模型服务。原生产品安装/Client、真实业务项目、跨平台和框架 HMR 仍待验收，完整项目尚未完成。
