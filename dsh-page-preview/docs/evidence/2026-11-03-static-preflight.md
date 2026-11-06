# 静态页面只读预检

对应方案 §5.2、§6.1、§6.2、§6.6、§6.8、§11、§15.3。static.probe/discover/plan 已接通真实通用 Planner；public open 与应用自动识别尚待接入，不把内部链路当作完整产品验收。

Host/Runner 共用 shared/static-files 的同一 MIME、publicRoot、真实路径、点文件/越界拒绝及显式 SPA 规则。预检的路由以实际导航 URL 解析相对资源；SPA 不能用 index 掩盖缺失脚本，文件位置不能替代浏览器 base。默认发现只扫描源 HTML，忽略隐藏/依赖/生成目录；显式选择的 publicRoot 可指向产物目录。符号链接目录不自动遍历，发现达到 5000 条目时明确报告限制。

HTML 使用已批准 parse5，JS/TS/JSX 使用已批准 TypeScript AST，只读文本，不执行项目模块。明确声明的模块、Worker、SW 与资源逐项检查；缺失、裸 import、外部来源、JSX/TypeScript 或语法错误返回缺失条件。计算引用、CSS 完整依赖和图预算之外的输入保留已知差异，source 指纹仅标识已读取输入，freshness 不因此变成 current。

shared/html 同时定位真正的 head/html/doctype，注入仍保留原文。注释、字符串、带 > 的属性不会被当作 head；缺少 head 时保留 doctype，避免为了 reporter 改变文档模式。模板里的非活动脚本不作为立即执行入口。

当前静态运行时不支持组件独立渲染、场景/额外初始化、导出/文件导航绑定、目标断言、载体视口控制；对应请求明确失败。刷新只声明需要人工重载，截图保持未知/未接通。meta CSP 可能进一步限制 reporter，错误采集按条件能力报告，不放宽页面原有策略。

Adapter.probe 新增可选 target，Core 传入已解析目标，避免把同一应用中的任意 HTML 当作可编译 Vue/TS 目标的证据。适配器接口仍框架中立，旧实现可忽略可选形参。配置 JSON/工具入参未变。

环境 macOS 15.7.7、Node v24.13.1；12 项新增测试覆盖真实静态计划/发现、输入哈希、声明资源失败、源码不执行、语法/TS/JSX、SPA 基准、功能拒绝、范围/环境文件别名与 HTML 注入。业务文本故意包含 throw；预检未执行它。Mock fetch 明确证明预检不会访问远程服务。

```text
npm run typecheck → 退出 0
npm test          → tests 160; pass 160; fail 0; skipped 0
npm run build     → 退出 0
node --check      → 编译烟测脚本通过
git diff --check  → 退出 0
```

自动化覆盖：`tests/unit/session-registry.test.ts`（public open→static.plan→真实 Runner 链路）与 `tests/unit/static-preflight.test.ts`（loader→resolveTarget→buildPlan 真实路径）。原编译烟测 `scripts/verify-host-runner.mjs` 已随 R4-5 删除；历史记录（Host PID <pid>、Runner PID <pid>，staticPreflight=verified-through-config-target-planner-and-product-adapter）保存在 output/host-runner-static.json，不含 HTML/nonce。

实际浏览器的网络/资源控制另见 network-boundary.md。这里未验证 DSH Native/public open、框架 HMR、目标挂载、自动刷新或全部动态依赖；没有设置 profile.verified=true 或声称 ready/current。
