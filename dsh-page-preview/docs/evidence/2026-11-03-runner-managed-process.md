# 托管进程基础设施验收

对应方案 §9.2、§15.3、§16 第 3 项。`src/runner/process-tree.ts` 已替换骨架；完整 Runner IPC、Host 工具和适配器尚未接入，产品仍不可用。

## 行为与接口

- `spawnManaged` 在 macOS 创建独立进程组，只传入调用者明确给定的环境，关闭 shell 展开。进程账本写入后才返回句柄，不登记参数或环境值。
- `ManagedProcess.pgid` 改为必填，新增 `startTime` 与 `stop(graceMs?)`。现有适配器仍为骨架，没有已实现调用方需要迁移；账本 JSON 结构不变。调用方停止资源应使用句柄的 `stop`，而不是自行释放账本。
- 停止核对 PID/PGID/启动时间，再向进程组发 SIGTERM。超时后只对初始快照中身份仍匹配的组内进程发 SIGKILL。启动失败或取消同样执行身份核对与回滚。
- 组长已退出时只返回组内残留，不猜测所有权发信号。观察到的脱组后代在终止组长前单独落盘，不自动终止；重复调用保留其身份与残留。只有核对其消失后才释放相应记录。
- 低层 `killTree` 要求 PID/PGID/启动时间，仅终止与报告残留，不释放账本。身份不符使用既有 `ownership_unverified`，回滚或登记残留失败使用既有 `cleanup_failed`。
- 进程检查不可用时在启动前失败。Linux/Windows 尚未验证，在分配资源前明确拒绝。未观察到的脱组后代无法保证发现，不能据此宣称进程树已全部回收。

## 自动化验证

`tests/unit/process-tree.test.ts` 使用临时目录与自己创建的真实子进程。9 项覆盖：显式环境/字面参数与重复停止；错误身份不发信号及监听后代清理；忽略 TERM 的 KILL 升级；登记失败回滚；登记期间取消及预取消；启动失败；脱组后代跨重复停止保留；脱组登记失败不先发信号且可重试；组长先退出后保留残留。

实测 macOS、Node `v24.13.1`。完整命令实际通过：

```text
npm run typecheck   → tsc --noEmit，退出 0
npm test           → tests 43; pass 43; fail 0; skipped 0
npm run build      → tsc + copy-browser，退出 0
```

## 自动化覆盖（R4-5 起取代原编译烟测）

`tests/unit/runner-session.test.ts`（"real managed non-Vite service reaches only reachable and repeated stop releases PID, port and ledger"、"real unexpected service exit fails after verified cleanup and retains runtime diagnostics"）、`tests/unit/process-tree.test.ts`、`tests/unit/port-ownership.test.ts`。原 `scripts/verify-managed-process.mjs` 已随 R4-5 删除：它先比对 6 个文件与登记 fixture 的 SHA-256，仅运行该零依赖模拟服务；不加载业务配置、读取 `.env`、安装依赖或调用模型，交叉核对启动时间、lsof 实际监听和归属端口后请求 `/health`，停止后核对退出、PID/端口消失、账本为空及源文件哈希不变。

2026-10-31 实际结果（原始记录 `output/phase1/managed-smoke/managed-process-smoke.json`）：

```json
{"platform":"darwin","node":"v24.13.1","pid":<port>,"startTime":"Sat Oct 31 14:38:47 2026","port":<port>,"ownership":"verified","exitCode":0,"residualPids":[],"ledgerEmpty":true,"sourceHashesUnchanged":true}
```

这些结果只证明 macOS 托管进程模块与样本服务的清理。Host 崩溃后恢复整组所有权、完整 Runner IPC 的取消/退出、会话所有权与 `attach.stop` 仍须分别实现和验收；此前探针不能代替这些集成。
