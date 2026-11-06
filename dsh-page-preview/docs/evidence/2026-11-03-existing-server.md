# 已有服务接入与脱离

existing-server 已进入公开注册表，提供 attach 观察模式。它导航到明确配置的 HTTP(S) loopback 来源，不启动、接管或停止目标服务，不注入脚本、代理响应或操作浏览器状态。它不提供 mock-only、独立组件渲染或真实身份隔离。

## 配置与预检

已有服务必须显式配置 origin。只有已保存 requirements:[] 的观察模式可运行；省略时保留默认 mock-only，工具请求清空 requirements 也不能自行放宽默认/已保存约束。以下仅为配置格式示例，地址和项目 ID 要与被授权来源对应：

```json
{
  "schemaVersion": 1,
  "projects": [{
    "id": "existing",
    "root": ".",
    "runtime": {
      "adapter": "existing-server",
      "strategy": "attach",
      "origin": "http://127.0.0.1:<port>",
      "requirements": [],
      "readiness": { "probePath": "/health", "serviceDeadlineMs": 5000 }
    },
    "targets": [{ "id": "orders", "selector": { "kind": "route", "path": "/orders/:id", "params": { "id": "DEMO-101" } } }]
  }]
}
```

probe/discover/plan 只转换配置，不发 HTTP、不推断 dev 命令或执行项目代码。URL 必须匹配配置 origin；路由参数/query/hash 按共同路由规则保留。文件目标必须有明确 route 映射，不从文件名猜 URL。setup/env/command/handler、场景、额外入口/样式、静态根、视口控制和目标断言尚不可用于 attach，明确拒绝。

计划按七个网络通道报告 none，并注明现有页面/服务可能访问真实后端。错误采集、挂载、源码新旧、HMR、嵌入头和身份条件均未验证。观察模式不承诺禁网或免后端，不复用浏览器登录态到 Runner。

## Runner 行为

启动时只对声明的 probePath 发无凭据 GET；未声明时探测目标 URL，hash 不参与请求。GET 必须返回 2xx；不跟随任何重定向，不读取/回传响应正文，不绕过 HTTPS 证书检查。健康探针应由来源拥有者选择，插件不会自动猜另一条路径或切换方法制造成功。

成功仅证明当时的服务可达，状态为 reachable，文档/目标挂载和 freshness 仍 unverified。运行期间每次完成后间隔 1 秒探测，单次上限 2 秒；失败报告具体服务层证据失败并脱离，不能保留旧 reachable。不会因探测失败向目标 PID 发信号。

stop 取消自身计时器及请求，等待观察任务结束，释放自身引用。目标 PID/端口不进入插件服务资源账本；已有 Cookie/Storage/缓存、服务进程和文件均不清理。Runner/Host 关闭也遵守同一语义。后续重开仍要按相同来源和约束预检。

## 实际证据

2026-11-01，macOS arm64、Node v24.13.1、DSH SDK 0.2.1-rc.5：typecheck/build 退出 0；完整回归 tests 193 / pass 193 / fail 0 / skipped 0。新回归覆盖纯只读预检、显式文件映射、动态路由/query/hash、缺失/越界来源、数据边界拒绝、未支持绑定、公共 attach/脱离、服务退出、启动不可达及不跟随重定向。

自动化覆盖：`tests/unit/session-registry.test.ts`（"public attach observes a separate non-Vite process; detach/dispose leave its PID, port and state intact"、"attach monitors service loss without killing or taking ownership of the user process"、"attach rejects an unhealthy probe and does not follow even a same-origin redirect"）与 `tests/unit/existing-server-preflight.test.ts`。原 `scripts/verify-existing-server.mjs` 已随 R4-5 删除；历史记录（Host <pid>、Runner <pid>、独立非 Vite 服务 <pid>，公共 ToolRuntime 接入成功，原响应未注入，六个源文件哈希未变，插件 stop 与 Runner 退出后独立服务全部保留）见 output/existing-server.json。

这些是 HTTP/进程与工具链证据。没有在本轮安装产品到用户原生 DSH；Client 展示/重连、浏览器 Cookie/Storage 通道、任意项目 HMR、真实业务服务以及 Linux/Windows 未据此验收。Phase 0 的非 Vite Browser 展示/存储探针仍是独立证据，见 phase0-non-vite-demo.md。
