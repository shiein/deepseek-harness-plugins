# 状态与停止工具验收

对应方案 §4.1、§4.2、§9.2、§15.3。page_preview_status 与 page_preview_stop 已接通 Registry→RunnerClient→真实 Runner，capture 对当前未接通的画面采集返回 unsupported。2026-11-01 已进一步接通静态 public open/目标解析/Planner，见 open-tool.md；Client 展示及其他策略仍未完成，不能据此宣称完整插件可用。

## 身份与状态来源

默认调用者来自 exec.agent.session.id，工作区来自不可变的 session.header.cwd，再按规范路径核对。锁定 DSH 0.2.1-rc.5 的类型与真实 SessionStore 测试证明 header.cwd 是创建目录；workingDirectory.get 是可变的有效目录，不能把 cd 当作预览工作区切换。缺少 Agent/明确 cwd 时返回 needs_configuration，不使用 Host 的 process.cwd，也不从用户参数接受 ownerSessionId。

RunnerClient.inspect 将已受理的计划副本、Runner 快照和有界诊断合并；Registry 不再维护第二份会话状态。计划在开始异步启动前复制，等待或复用期间修改调用方对象不会改变显示的能力。返回数据也复制；锁定 SDK 的真实工具管线会进一步冻结结果。

查询不创建进程、启动适配器、修复资源或对账；空工作区查询甚至不创建插件数据目录。Host 中已经观察到的异常退出状态按实际事实读取，不回退成旧 ready。目录删除后仍可查询/停止已拥有的会话；文件系统范围仍使用同一 shared/config/paths 实现。

## 输出与清理

- status 无 previewId 时列出当前工作区、当前调用者最近三项预览；旧 ID 仍可单独读取。带 ID 时返回单项摘要；detail=true 且指定 ID 才返回计划/完整能力表。freshness、三层就绪按实际值保留，不从 reachable 推断 ready。
- 每个预览保留最近 32 条诊断，默认输出最近 8 条；detail 可看保留的全部诊断。diagnosticsTruncated 累加已丢弃历史和本次输出截断。45 条样本默认返回 8 条、截断 37 条；detail 返回 32 条、截断 13 条。
- 计划中的命令参数/执行环境值不进入工具输出，内部计划/指纹保持不变。managed 公开 DisplayedPreviewPlan 使用 executionDetailsOmitted 明确标记，不伪装成空参数/可执行计划。终止/失败/残留状态不再提供可打开的旧 URL；摘要只列未获支持的能力，不能把声明变成验证证据。
- stop 要求 previewId 或 all:true，两者互斥。all 处理当前调用者/工作区的全部历史记录，列表展示的三项上限不影响清理范围；重复停止返回当前实际结果，不停止其他会话或工作区的服务。
- Root 负确认携带的 cleanup_failed 和残留会保留。Root 已退出时只核对账本，不删除仍存活的路径；外部清理完成后再次 stop 才能确认 stopped。传输失败返回 error、已知状态和“无法确认”的说明，不编造清理成功。原错误保存在内部 lastError，不回显任意错误内容。
- capture 先检查相同访问范围；未知/异属 ID 返回 not_found，已知 ID 返回 unsupported_capability，没有截图或模型调用。

现有工具参数、结果字段、配置 JSON 与 IPC 未变。RunnerClient 新增内部 inspect，Registry 构造器可注入可信 CallerResolver，默认实现读取真实 Agent/Session；测试注入仅为在独立 SDK 管线中选择合成会话，不是 Agent 可填写的权限参数。内存记录可用于 Agent 压缩后找回 ID；没有实现 Host 重启后恢复完整计划。

## 实际证据

环境 macOS 15.7.7 arm64、Node v24.13.1、DSH SDK 0.2.1-rc.5。新增 10 项测试，其中 8 项通过实际 ToolRuntime 执行产品工具，其余核对真实 SessionStore 身份/目录和输出协议；它们使用独立内存 Context 和临时文件，不访问用户 DSH profile、模型或后端。

覆盖空查询零分配；真实状态/详情/快照副本；跨 owner/工作区隔离；停止全部/重复停止；最近三项及旧 ID；32/8 条诊断预算；真实 Root 负确认和 SIGKILL 后残留；删除项目目录后停止；传输失败不伪造状态；缺少调用者配置；环境值省略及截断累计。

```text
npm run typecheck → 退出 0
npm test          → tests 129; pass 129; fail 0; skipped 0
npm run build     → 退出 0
node --check      → 编译产物烟测脚本通过
git diff --check  → 退出 0
```

自动化覆盖：`tests/unit/session-registry.test.ts` 的 "status returns actual readiness, immutable summaries and explicit detail; capture reports unsupported"、"status exposes the redacted page-text observation after a browser report"、"empty status, unknown IDs and invalid stop requests never allocate a Runner"。原编译烟测 `scripts/verify-host-runner.mjs` 已随 R4-5 删除；历史记录（Host PID <pid>、Runner PID <pid>，publicStatusStop=verified-through-DSH-tool-runtime，currentViewCapture=unsupported）保存在 output/host-runner-static.json。它使用真实 SDK SessionStore/ToolRuntime 与编译产物，但不等于在用户 DSH Agent/UI 中加载产品。

上面的 129 项和 PID 是状态工具初次验收记录；当前完整回归与公共 open 编译烟测见 development-progress.md、open-tool.md。未验证：原生 DSH Agent 调用本轮产品工具的完整链路、Client 显示与重连、目标挂载、源码对应关系、其他运行平台。原文件 HTTP 页面仍为 reachable，targetMounted/freshness 为 unverified。
