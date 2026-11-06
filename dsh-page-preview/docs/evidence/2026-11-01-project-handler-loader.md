# 项目 handler 授权加载

2026-11-01：`loadProjectHandlers` 已实现执行前复核、路径边界、Node 动态导入和导出校验。它只供每预览 Runner 执行器调用，不在 Host 的 detect/probe/plan 中使用；模块 import 本身无文件或进程副作用。

模块相对应用根，按同一 resolveProjectPath 核对应用/声明依赖根、真实文件及 JS/TS 扩展；环境文件和指向环境文件的别名不能作为 handler 导入。缺少 Runner verifyExecution 回调时直接 config_changed_needs_approval，路径缺项 config_invalid。紧邻 import 前调用当前执行项复核；可信 RunnerSessionError 保留原诊断，原始回调异常保留内部 cause、对外只给安全批准诊断。取消在解析前、复核后和 import 完成后检查；已开始的 Node 模块求值不能由该函数回滚，执行器生命周期负责停止其拥有进程和资源。

首个样本固定导出格式为 `export default [handler, ...]`，CJS 对应 `module.exports = [handler, ...]`。不自动选择 named handlers、单函数或其他框架格式。每项必须是函数；返回复制后的数组，响应继续由 HTTP Mock 中间件校验。函数参数为 HttpRequestInfo/ScenarioStore，返回响应或 undefined；fixture 优先，handler 间顺序保持项目声明，不推导 CRUD。

原路径导入保留 Node 原有依赖解析、相对 import 和模块缓存；不复制业务模块或添加时间戳。每个预览独立执行器限定缓存生命周期；后续场景切换不能只 reset 内存 Map 就宣称项目模块/浏览器身份已干净。支持的 `.js/.mjs/.cjs/.ts/.mts/.cts` 是否能执行取决于实际独立 Node；本轮实际验收 Node 24.13.1 的 mjs/ts/cjs，其他工具链不外推。它不是文件/网络沙箱，模块自身仍是获准项目代码。

## 实际验证

macOS arm64 / Node 24.13.1；typecheck/build 退出 0，显式已有工具链目录的完整 tests 294 / pass 294 / fail 0 / skipped 0。4 项新增回归使用临时文件及真实托管子进程，合成 verifyExecution 不写真实用户批准记录。

- 缺复核/复核拒绝、已知配置错误及取消：模块 marker 不存在，没有 import；越界、环境别名、缺失及不支持源文件在复核前失败。
- 自建 mjs/ts/cjs default 数组各在独立 Node 进程求值，marker PID 等于登记子进程且不同于测试进程。通过真实 HTTP POST→GET→DELETE 验证项目 handler 的场景数据读写/重置；监听 PID 对应已登记进程，停止后进程/端口/账本消失。
- 模块抛错、缺少 default、默认单函数及数组中的非函数：明确 runtime_error/config_invalid，无其他导出 fallback；专用 IPC 的安全诊断不含原始项目错误值。原始 stdout/stderr 排空，不作为控制消息。

后续已接到公开 Vue 场景选择、官方批准接缝和编译完整入口/IAB 原组件写读删除；handler import 前通过专用 IPC 等待 Root 当前复核，见 vue-node-handlers.md。真实用户 UI/Agent loop 仍未验收，默认 mock-only 继续阻断。执行指纹仍由现有收集器绑定 setup/handlers 的路径、内容、应用根和场景引用，批准只来自可信用户确认。
