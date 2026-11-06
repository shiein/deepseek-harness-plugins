# 自有静态服务的浏览器网络边界

对应方案 §6.8、§7.3、§15.3。为接入真实 static 预检，使用产品 RunnerClient→Runner→static.start，在自建回环接口验证文档、Worker/SW 和资源通道；没有访问真实后端、调用模型或改变用户 DSH profile。

## 发现与修正

原策略只有 connect-src/form-action：真实浏览器中 fetch、Worker/SW 跨源请求被阻断，但 JSONP 执行成功，自建接口计数 /jsonp=1。补 script-src 后继续实测，外部图片、样式、iframe 仍各收到一次请求。仅检查 fetch 失败不能证明 mock-only 的浏览器路径已覆盖。

受控响应现在增加 default-src self，并分别规定 script/style/worker/frame/img/font/media 来源。脚本仅同源，保留原页内联与动态编译；样式保留同源/内联；Worker 保留同源/blob；图片/字体/媒体保留同源/data/blob；子文档仅同源。现有显式 HMR connectSources 仍只用于连接来源，不放行远程业务脚本。CSP 继续叠加页面自身更严格的策略，没有改写业务逻辑或生成替代页面。

这是浏览器数据边界，不是 JS 安全沙箱；unsafe-inline/unsafe-eval 为兼容本地业务代码而保留。远程 CDN 资源现在明确被阻断并产生 blocked_request；需要项目本地资源或明确可验证的接入方式，不自动下载替代依赖。策略不约束 Node/OS 进程，也不能覆盖离开受控来源后的顶层页面；不据此宣称所有环境零外联。

## 实际证据

macOS 15.7.7、Node v24.13.1、产品 SDK 0.2.1-rc.5、IAB Chrome 156.0.0.0。每轮探针独立目录/端口；接口允许 CORS，避免把普通跨源失败误判为 CSP；额外核对接口实际命中次数。Worker/SW 由产品静态服务器返回，脚本响应带同一 CSP。

最终结果：fetch/WS/SSE、JSONP、外部 Worker、图片、样式、iframe 均被阻断，自建外部接口计数为空；页面收到 connect-src/script-src-elem/img-src/style-src-elem/frame-src 违规事件。Worker/SW 跨源 fetch 拒绝、同源未匹配请求返回 404。内联/本地脚本、eval、内联/本地 CSS、Blob Worker、本地 iframe 均正常。只注销探针自己的 SW，serviceWorkerUnregistered=true。

最后探针 PID <pid> 经启动时间核对后停止，PTY 实际 exit 0；Runner dispose residual=[]，探针账本 residual=0。前几轮也均实际 exit 0、无残留。没有按进程名清理、清空用户存储或重启用户应用。

复现：先 npm run build，再运行 node tools/probes/probe-static-network.mjs；在独立浏览器打开输出 URL，读取页面 #results 和输出 stats URL，结束时 Ctrl-C。测试程序本身不把未知结果改成成功；超时/unavailable 会原样显示。样本位于 tests/fixtures/network-boundary。安全结果/截图在 output/network-browser-after.json、output/network-browser-after.jpg；每轮计数/清理记录在独立 output/network-browser-* 目录，不输出 HTML 或 nonce。

typecheck/build/浏览器脚本语法/diff 检查退出 0。首轮完整回归为 147 通过、1 失败：旧集成断言要求 connect/form/frame-ancestors 指令紧邻，新增资源指令后该顺序假设失效；浏览器中的策略和嵌入白名单行为正常。断言改为分别核对关键指令后，实际重新运行完整回归 tests 148; pass 148; fail 0; skipped 0。CSP 单测核对来源规则，真实浏览器记录提供运行时证据；两者不互相替代。

原生 DSH Chrome 152、产品 web iframe 联动、Vue CLI/Vite 真实框架 HMR、所有 Worker 形式仍需各自验收，不能把本次 Chrome 156 结果推广为全部通过。目标挂载与源码对应关系未据此标 ready/current。
