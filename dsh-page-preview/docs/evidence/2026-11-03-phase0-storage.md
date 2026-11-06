# 原生 Browser 的 Cookie 与工作区存储验证

2026-10-31。结论：本机原生 DSH 的同工作区 Browser 重开会保留样本状态；不同工作区的同一来源在本次实测中隔离。更换端口只隔离 localStorage，没有隔离 Cookie。这个结果不能直接提供每个 preview 独占的身份环境。

## 环境与方法

macOS `15.7.7` arm64；DSH `0.2.1-rc.5`；Electron `44.7.0` / Chrome `152.0.7977.130`；独立 Node `24.13.1`。使用用户当前原生客户端，没有重启、安装插件、调整第三方 Cookie 策略或调用模型。

`tools/probes/phase0-storage.mjs` 启动两个随机 loopback 端口。样本来源为 `127.0.0.1:<端口1>`、`localhost:<端口1>` 与 `127.0.0.1:<端口2>`，仅这些来源可使用带凭据 CORS。未知来源拒绝，未知资源返回 unmatched_request，不访问真实后端。

每轮使用随机公开 runId，生成一个 localStorage key 和四个同路径 Cookie 名。Cookie 值均为固定人工标记，且设为 HttpOnly；服务端只记录四个 Cookie 的布尔存在状态。没有保存原始 Cookie、其他名称/值或浏览器登录状态，页面不读取 document.cookie、不枚举 Storage。上报只接受固定标签、固定事件和有限数据；未知字段、畸形 JSON、超过 4 KiB 的正文明确拒绝。

工作区 A 为已有 `overview`，工作区 B 为本轮通过官方目录选择器注册的 `workspace/demo/dsh-page-preview-non-vite`。**A/B 页面标签是测试注释，实际工作区切换由原生 DSH UI 操作另行核对**。不能只改标签就声称换了工作区。未向任一会话发送消息。

## 实际结果

| 检查 | 实际观察 | 含义与限制 |
| --- | --- | --- |
| 页面上下文 | 样本报告 window.top === window | 原生 webview 是本样本的顶层上下文；不继承 web iframe 结论 |
| 同工作区关闭重开 | A 的 localStorage 标记 A 和已接受的 Cookie 都保留 | 关闭 tab 不等于清理身份状态 |
| 同主机不同端口 | 另一端口 localStorage 未写入，但 Cookie 标记均仍存在 | Cookie 不按端口隔离，随机端口不能代替身份隔离 |
| 不同主机名 | localhost 初始没有 127.0.0.1 的标记 | 只覆盖本次 host-only Cookie 与样本 key |
| 跨工作区 | B 在相同 URL 初始为空；B 写入 B 后，返回 A 仍显示 A | 与工作区分区一致；不是每个 preview 或同工作区内不同角色独占 |
| 精确清理 | A 的 127.0.0.1、A 的 localhost、B 的 127.0.0.1 均回到空值和四项 Cookie false | 只移除本轮样本 key/Cookie，未调用 clearStorage、清理缓存或删除分区 |

Cookie 设置和请求结果（true 表示该测试 Cookie 到达样本服务）：

| Cookie 属性 | 同源请求 | 跨站 fetch | 跨站顶层 GET 导航 |
| --- | --- | --- | --- |
| SameSite=Strict | true | false | false |
| SameSite=Lax | true | false | true |
| SameSite=None; Secure | true | true | true |
| SameSite=None，未加 Secure | false | false | false |

跨站测试由 127.0.0.1 页面请求/导航到 localhost，服务端实际收到 Sec-Fetch-Site: cross-site，fetch 的 mode 为 cors，导航的 mode 为 navigate。只允许明确的样本 origin 和 credentials，没有使用通配来源或放宽浏览器保护。Secure Cookie 在本机这些 HTTP loopback 来源被此版本内核接受，不能推广为任意 HTTP 域名都可接受。

锁定源码与观察一致：Browser Client 以 `cwd:<workspace.path>` 选择工作区 account，未分组会话使用 `session:<id>`；Desktop 主进程为 account 维护进程生命周期内的分区，释放 tab lease 时保留存储。上述为 SDK 源码核对，跨工作区 A→B→A 和关闭重开为运行时证据。应用重启后的行为未实测；未重启用户客户端来推断它。

对方案 §7.4 的影响：已有服务仍只能在授权观察范围内使用，不能清理用户状态来模拟角色切换。同工作区分区被共享；没有预览专属上下文或经确认的完整项目重置机制时，角色切换继续保持不支持/需配置。不能仅凭跨工作区隔离就声明 preview 独占身份已实现。

## 复现与清理

1. 执行 `node tools/probes/phase0-storage.mjs <输出绝对目录>`。记录它打印的 origin、aliasOrigin、otherOrigin、base；runId 是公开样本命名空间。
2. 在工作区 A 的 Browser 打开 `<origin><base>?label=A`。先点“仅清理本次样本”取得空基线，再写入 A。
3. 关闭并重开同一 URL，检查 A 保留。打开“另一端口样本”，检查 Cookie 仍在、localStorage 为空。
4. 打开 localhost 样本并写入 A，再返回 origin 样本。依次执行“跨站读取 localhost”和“跨站导航到 localhost Cookie 回显”，核对上表及 Sec-Fetch-Site。
5. 通过 DSH 实际选择第二个工作区 B，打开与 A 相同的 origin/base，仅把人工标签设为 B。确认初始为空，写入 B，再切回 A 确认仍是 A。
6. 在 A 的 origin、A 的 aliasOrigin、B 的 origin 分别精确清理本轮样本，并确认空值。关闭本轮 tab，恢复原工作区和草稿。
7. 按记录的 PID 与启动时间核对后给样本发送 SIGTERM；两个服务关闭并释放进程/端口账本。运行 `node tools/probes/verify-phase0-storage.mjs <输出目录>/storage-observations.json [观察起点偏移]` 校验完整序列。

本轮证据保存在忽略目录 `output/phase0/storage`。因中断期间有探索操作，受控序列起点单独记录于 controlled-start.json（偏移 14），校验从该位置开始，不把探索记录或单纯标签变化当成工作区证据。脚本最终实际输出：

```json
{"sameWorkspaceReopen":"preserved","crossPort":"cookies-shared-localStorage-separated","manualWorkspaceSequence":"A/B/A-markers-separated","crossSiteFetch":"NoneSecure-only","crossSiteNavigation":"Lax-and-NoneSecure","sampleStateCleared":true,"probeStopped":true}
```

进程已正常退出、两个端口无监听、账本为空。测试 tab 与本轮样本状态已清理，当前恢复 overview 和原有未发送草稿。demo 工作区注册保留供后续手动预览链路验证使用；没有删除其目录、源码或会话。

检查：typecheck/build 与新增脚本/浏览器 ESM 语法检查通过；npm test 实际为 tests 34、pass 34、fail 0、skipped 0。仍未验证 web iframe、IndexedDB/Cache/Service Worker 的工作区隔离、应用重启、同工作区不同会话、预览专属上下文或真实业务登录；不据此扩大支持矩阵。
