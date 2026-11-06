# Runner 会话生命周期验收

对应方案 §9.2、§11、§15.3。`RunnerSession` 已实现启动、三层就绪证据、刷新、取消、异常退出和停止清理。工作区占用与调用者隔离、内部 Host/IPC 静态文档分派已接入，见 [执行链路](2026-11-03-runner-ipc.md)；公共 open 与执行批准交互仍待完成，产品仍不可用。下文检查数量是各分项提交时的历史结果。

## 行为与边界

- 先核对计划/适配器/项目 ID，拒绝复用仍有持久资源的 previewId。StartContext 新增 previewId/ownerSessionId，供适配器使用既有资源账本登记归属，不新增工具参数。
- 单有 HTTP/服务证据只进入 reachable。句柄尚未返回时不发布 URL；服务、文档、目标三层证据齐备后才 ready，freshness 仍须独立证据。快照复制就绪数据，外部修改不会改变内部证据。
- 服务期限来自 plan.readiness.serviceDeadlineMs；存在显式目标断言时，在服务确认后另等 targetDeadlineMs。超时取消并清理，不在超时后制造成功。启动完成后移除调用方取消监听，不把之后的信号误当成停止预览。
- 清理默认最多等待 5 秒，检查实际句柄结果和账本。未完成启动/清理、账本剩余资源或检查失败都为 cleanup_failed；不能只信句柄的空 residual。会话本身不删账本或发进程信号，不终止用户已有服务。
- 并发停止共用一次清理，完成后重复停止返回空残留。启动/清理迟到完成时，再检查并继续回收，防止服务复活；清理失败可重试。失败后回收干净才为 failed，明确 stop 回收干净才为 stopped。
- 编译失败保留更新前状态、freshness=stale 并保留诊断；适配器没有细节时明确报告“无细节的编译失败”。成功更新按实际 outcome 恢复；需要重启时标 stale、清理并失败，不自行生成替代计划。停止后的迟到刷新不恢复旧状态。
- 内部 lastCleanupError 保留清理根因，IPC/模型输出只含安全诊断和残留。`stopped` 消息只用于停止事务；失败清理通过实际 state 报告。

Adapter.start 仍须遵守“分配后登记、失败自行回滚”的契约。会话对迟到句柄提供回收，但不能发现完全未登记且不返回句柄的任意外部副作用；不能把独立子进程当成安全沙箱。批准存储/执行前检查尚未实现，本轮未生成批准记录。

## 实际验证

macOS `15.7.7` arm64、Node `24.13.1`。15 项定向测试覆盖：证据不足、乱序三层证据、服务/目标期限、预取消与运行中取消、取消监听解除、启动/清理迟到、重复停止、账本残留、ID 重用、错误 origin/凭据、编译恢复、必须重启与迟到更新。

其中 3 项实际运行 Node HTTP 非 Vite 样本，通过 PID/启动时间和 lsof 交叉核对监听；分别验证正常停止、真正进程退出，以及故意忽略取消后迟到返回的真实服务回收。最终 PID/端口消失、账本为空。其余测试使用合成句柄验证状态与失败分支；不把它们当作浏览器就绪或产品适配器支持证据。

实际检查输出：

```text
npm run typecheck → 退出 0
npm test          → tests 95; pass 95; fail 0; skipped 0
npm run build     → 退出 0
node --check      → 生命周期烟测脚本通过
git diff --check  → 退出 0
```

## 自动化覆盖（R4-5 起取代原编译烟测）

`tests/unit/runner-session.test.ts`（生命周期、"ready requires all three proofs plus the returned handle, even when proofs arrive out of order"、"a failed session stays failed when late cleanup retries settle; only clean explicit stops reach stopped"）、`tests/unit/runner-workspace.test.ts`、`tests/unit/ledger.test.ts`、`tests/unit/port-ownership.test.ts`、`tests/unit/state-machine.test.ts`。原 `scripts/verify-runner-session.mjs` 已随 R4-5 删除：它先验证 6 个原文件与登记 fixture 相同，再由编译产物加载合成配置、用独立生命周期测试适配器启动该服务；没有修改业务文件、安装依赖、读取 `.env`、调用模型或访问真实后端；也没有调用产品 project-command 适配器或 DSH Client。

实际输出（原始记录 `output/phase1/runner-session/session-smoke.json`）：

```json
{"platform":"darwin","node":"v24.13.1","pid":<port>,"startTime":"Sat Oct 31 15:57:41 2026","port":<port>,"beforeStop":"reachable","targetMounted":"unverified","afterStop":"stopped","ledgerEmpty":true,"sourceHashesUnchanged":true}
```

内部 StartContext 增加两个归属字段，现有 RunnerSession 构造和更新接口保留。产品适配器均尚为骨架，无已实现调用方要迁移。其他平台、完整 Host/Runner 崩溃恢复、跨 Runner 的工作区互斥与真正 attach.stop 未据此验收。

## 工作区会话编排

`RunnerWorkspace` 只管理一个规范工作区，在一个实例内约束单活动目标；Host 仍须保证每规范工作区只创建一个 Runner。它不是跨进程全局锁，不替代公共工具调用者鉴权或执行批准。

- open/切换/stop 串行登记，实际异步启动不阻塞 get/list 状态读取。规范路径别名可匹配同一工作区，不接受其他工作区上下文。
- 相同拥有者、完整计划一致时复用原 ID 与启动 Promise，不偷偷建立第二份预览。Session 复制计划，后续修改调用方对象不会改变已登记事实。相同 ID 对应不同计划时返回 busy；失败/停止的旧 ID 不自动重建。
- 同属会话切换目标时，先复用 Session 的纯校验，再等待旧 stop 结果。无效或预取消的新计划不影响旧目标，任何残留都阻止启动新目标。
- 异属会话的活动预览返回 busy，get/stop 不给访问，list 只列调用者拥有的记录。该限制属于内部编排；工具/IPC 尚未接入，不声称公共工具已经实现权限控制。
- shutdown 立即关闭新建入口，收束全部本实例会话；并发 shutdown 共用任务，有残留时可再次重试。一次操作错误不会永久阻断后续队列，原错误仍明确返回给调用者。

10 项新增定向测试通过，包括真实非 Vite 服务切换：在第二次调用适配器启动之前，已用 OS 核对旧 PID 不存在、旧端口无监听；shutdown 后两份账本均为空。其余覆盖并发拥有者、复用、别名与不匹配工作区、切换清理、计划快照、无效/取消新计划、shutdown 和失败启动。所有资源均为本轮临时资源，未停止用户服务。

编译产物烟测脚本已扩展为经 RunnerWorkspace 调用 RunnerSession，另验证异属会话 busy/禁止读取停止、同属计划复用；不会新增审批记录。完整检查实际输出为 `tests 105; pass 105; fail 0; skipped 0`，typecheck/build/脚本语法/diff 检查退出 0。

本轮最终编译产物烟测输出（`output/phase1/runner-workspace-final/session-smoke.json`，另外核对异属 stop 后原 PID/监听仍在）：

```json
{"platform":"darwin","node":"v24.13.1","pid":<port>,"startTime":"Sat Oct 31 16:17:24 2026","port":<port>,"beforeStop":"reachable","targetMounted":"unverified","afterStop":"stopped","workspaceBusy":"verified","ownerIsolation":"verified","reuse":"verified","ledgerEmpty":true,"sourceHashesUnchanged":true}
```
