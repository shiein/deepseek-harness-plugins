# Host → Client 联动：依赖准入请求

状态：用户已于 2026-10-31 批准下表清单，已按固定版本写入 package.json 与锁文件。批准范围不包含真实模型图片调用；该能力按用户要求继续保留未验证。未采用展示降级。

## 已核对的事实

核对对象是本机 DSH `0.2.1-rc.5` 安装包的实际源码，不是凭文档推测：

- `dsh-client-modules/lib/index.js` 读取 `dsh.client`，要求 `platform`，并解析 `./client` export；Client 产物采用 `window.__ModuleLoader__.load({ id, factory })` 注册格式。
- `dsh-client-ui-sidebar-right` 的 `sidebarRight.openTab` 在 Client 侧。Host 当前无法直接调用它。
- `dsh-api-remotes/lib/index.js` 的 `$on` 使用固定转发事件表，其中没有插件自定义的 preview 事件。不能仅在 Host `emit` 一个事件就假定 Client 收到。
- `dsh-api-workspace-controller` 示范了 Host Service + 生成的 Remote 描述 + Client Gateway 挂载。Remote 支持 stream，可供 Client 订阅 Host 的状态/操作意图。
- 对应的官方产物使用 `dsh-typert-protocol` 和 Zod schema。直接依赖应显式声明，不能长期借用当前 node_modules 中的传递依赖。

## 拟新增的直接依赖

| 包 | 固定版本 | 声明位置 | 用途 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-typert-protocol` | `0.2.1-rc.5` | peerDependencies + devDependencies | Host Remote Service、协议和生成描述 |
| `@deepseek-ai/dsh-api-gateway` | `0.2.1-rc.5` | peerDependencies + devDependencies | Client 挂载官方 Remote 贡献 |
| `@deepseek-ai/dsh-client-connection` | `0.2.1-rc.5` | peerDependencies + devDependencies | Client 的 Remote 传输服务 |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | `0.2.1-rc.5` | peerDependencies + devDependencies | Browser tab 打开及更新的 Client API |
| `zod` | `4.4.3` | dependencies | 官方生成的 Remote 编解码 schema，与当前 DSH 同版本 |

独立探针已完成一个隔离会话的 loopback tab 打开、刷新、关闭验证，见 `phase0-verification.md`。只新增了开发用 `esbuild@0.28.2` 和锁定 Browser SDK 类型，产品包构建尚未接入 Client。

原生客户端探针随后增加了锁定 `0.2.1-rc.5` 的 `dsh-session-title`、`dsh-client-ui-workspace` 与 `dsh-api-session-controller` 开发类型。运行时使用 DSH 默认已有的服务，不增加产品运行时依赖，也不调用标题模型。实测标题不会改变会话的 `blank` 状态，导航必须等待 `sessions.refresh()` 完成；修订后原生 open/refresh/close 与两次文档加载均通过，见 `phase0-desktop-and-overview.md`。产品工具链及原生存储、HMR、截图仍未验收。

SDK 的 `dsh-typert-loader` 明确支持显式 wire schema。探针以同一份 Zod schema 推导 TS 类型、JSON Schema 和 Host/Client 编解码描述，通过 `createTypertRemoteInfo` 装配；没有另建控制端口或 RPC。公开的官方生成器依赖 DSH 内部工作区注册和完整声明合并，当前不用于这个外部插件，已从开发依赖移除。仓库源码保持可擦除语法。

Node 内置能力不能直接调用 DSH 的 Client Service。自行另起控制端口与 RPC 会引入另一条连接、鉴权与状态通道；本轮未实施该方案。上述依赖只接入官方 Host/Client 机制，不升级现有 DSH 版本。

项目 `AGENTS.md` §9 的依赖准入要求已满足。批准安装不等于运行验证通过；不把手动点 Browser 当成 Host 联动，也不自行采用系统浏览器降级。
