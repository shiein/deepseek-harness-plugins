# 同源 HTTP Mock 中间件

2026-11-01：`createMockMiddleware` 已实现 fixture/已加载 handler/未命中的完整处理，不再抛占位错误。它不创建服务、不加载项目模块、不安装依赖或发起后端请求；尚未挂到产品适配器，不能把这些独立 HTTP 测试当作 Vue mock-only、场景或全部网络通道的验收。

业务路径由调用方显式给出，支持完整 pathname、整段 `*`（一个非空段）和末尾 `**`（零或多段）。按实际路径段解码一次；其他 glob 语法明确报错。范围外请求交还资源处理器，不消费其 body；范围内请求只在当前预览 origin 下匹配，失败不交回构建器或项目代理。

请求体默认上限 64 KiB，可由调用方指定正整数。支持 application/json、+json 和 text/plain；空体表示未提供 body。畸形 JSON 返回 400、超限 413、不支持媒体类型 415；重复 query 键无法保留于当前字符串映射协议，明确返回 400，不静默丢掉重复值。错误响应为固定诊断码，onUnmatched 只接 method/path，不包含 query/body/凭据。

fixture 匹配复用同一 origin/method/query/body/路径参数规则。歧义返回 409/config_invalid，不执行任意 fixture 或 handler。fixture 命中优先；否则按已传入的 handler 顺序处理，全部返回 undefined 则 404/unmatched_request。项目 handler 只能由 Runner 在适用批准后加载并传入，这里不产生批准或执行动态 import；加载器尚待实现。handler 自行读写 ScenarioStore，插件不生成 CRUD。匹配 POST/PUT/PATCH/DELETE fixture 时显式提示响应为静态、不会改变后续读取的场景存储。

响应支持最终状态 200–599、明确 headers、JSON 值/文本，以及由 Runner 范围校验后的 readBodyFile 回调返回字节。文本默认 text/plain、JSON 默认 application/json，文件默认 octet-stream；可显式声明类型。HEAD 不发送响应体；204/205/304 不允许配置 body。body/bodyFile 不能同时存在，文件没有范围校验回调时拒绝。由服务管理的传输长度/连接 headers 不接受伪造值，headers 本身使用 Node 校验。handler 或文件读取异常交给 next(error)，由拥有服务的错误边界记录根因并产生安全诊断，不能当作未命中或空成功。

中间件只处理同源 HTTP。CSP/受控响应头、资源准入、WS/SSE/Worker/SW、项目配置的服务端出网和场景切换仍是独立边界；产品接入时必须继续验证，不允许凭本模块通过就把所有通道改成 mock/block。

## 实际验证

Node 24.13.1/macOS arm64；typecheck/build 退出 0，显式已有工具链目录的全量 tests 290 / pass 290 / fail 0 / skipped 0。6 项新测试启动自有 Node HTTP 服务，通过真实本地请求覆盖 JSON/text/headers/HEAD/204、body/query/路径参数、静态写提示、未命中/歧义零转发、400/413/415、handler 存储/重置/异常、范围校验文件读取和业务 glob。另用仍在发送的分块请求确认超限得到 413；业务前缀下畸形路径转义返回 400，不能流到资源处理器。测试消费方只发送固定 500 错误文本，不将项目异常内容放进响应；服务全部关闭。

后续 handler 的 default 数组格式和授权加载器已有真实 Node/HTTP 样本，见 `project-handler-loader.md`。未完成：产品接入、场景初始化/切换、用户确认到实际 handler 的完整链路、bodyFile 原路径预检、真实浏览器业务读写及网络覆盖验收。配置字段和 JSON Schema 未变；内部 MockMiddlewareOptions 新增显式 fixtures/handlers/文件读取/大小上限/诊断回调，之前为占位函数，没有产品消费方迁移。

后续 Vue 初始场景已接本中间件、businessPaths 和同源 fixture/范围校验文件响应，并在编译完整浏览器链路验收读取/未命中；参见 `vue-initial-scenarios.md`。自有响应策略头现在由 response-layer 的同一列表管理，fixture/handler 不能覆盖 CSP/CORS/cache/frame 策略。Node handler 产品接入、写交互、完整切换及其他网络通道仍未据此完成。
