# 官方用户批准服务的直接依赖申请

2026-11-01 用户已批准在 peerDependencies 和 devDependencies 各声明 `@deepseek-ai/dsh-user-approval`，固定 `0.2.1-rc.5`。已用 npm --ignore-scripts --offline 完成声明/锁文件更新，实际包原本就由 SDK 间接安装；仅新增直接依赖身份，没有升级其他包。产品确认/执行已通过 SDK 与编译插件入口测试，实际 Agent loop/原生用户 UI 尚待验收。项目 AGENTS.md §9 要求新增运行时依赖先确认，本次授权已满足，不再重复询问。

用途是消费 DSH 官方 ApprovalService.request，由用户界面答复，并让 SDK 在开放轮次内写 approval/asked 与 approval/decided 审计。只接受 allowed-once；拒绝、取消、通道缺失、身份不匹配和确认期间配置变化都不写批准。经同版 `dsh-client-ui-approval` 核实，官方 UI 按钮为「允许一次」，没有「始终允许」；UI 明确请求“批准本工作区/项目本次预览运行的执行项”，不把一次执行同意暗中扩大为持久授权（每次运行都重新询问，链终止即消费记录）。

没有自建 Agent 可调用的 approve 工具、approved 参数或通过改配置生成批准。执行前 Host/Runner 仍要重新核对同一指纹，旧批准不能放行变化后的命令/env/setup/handler。记录仅含哈希和审计身份；环境值和源码不入持久记录，命令参数仅在非持久化 displayReason 给用户检查，不进入 SDK reason/日志。

具体可审阅实现：src/host/execution-approval.ts、src/shared/config/approvals.ts。已用当前实际安装的官方 service 与 SessionStore 跑过 6 项接缝测试：批准、拒绝/通道缺失/异常、取消迟到答复、确认期间文件/配置变化、身份缺失及无开放轮次。Agent 身份使用最小合成对象；不是实际 Agent loop 或原生用户 UI 验收。批准记录只写入测试临时目录并清理，没有为真实项目创建批准。

依赖授权后把产品入口接到 ctx.approval，并完成公共 open→用户确认→指纹复核→项目命令的端到端测试。真实 DSH 产品安装/原生弹窗验收另按既有安装授权边界处理。

离线 npm 输出未包含在线审计数据，不能把本次 found 0 vulnerabilities 当作旧 zod 告警已修复；锁定 zod 4.4.3 和先前发布门槛保持不变。

该依赖不升级 DSH，不修改/安装业务项目依赖，不调用模型，不产生外部费用。现有模型图片调用继续保持未验证。
