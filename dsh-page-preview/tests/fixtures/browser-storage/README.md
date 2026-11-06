# 原生 Browser Cookie / Storage 样本

方案 §7.4、§14。运行 `node tools/probes/phase0-storage.mjs <输出绝对目录>`，通过两个随机 loopback 端口和 localhost 别名观察 Cookie、localStorage、跨站请求及人工选择的 DSH 工作区差异。

每轮生成公开的随机样本命名空间，不作为鉴权 nonce。只写一个专用 localStorage key，Cookie 使用本轮名称、路径和固定人工值。页面不读取 document.cookie 或枚举其他存储；服务端只输出这四个测试 Cookie 的存在与否，不保存原始 Cookie。

A/B 是人工测试标签，不是工作区身份或隔离证明；必须先通过 DSH UI 实际选择不同工作区，再对照观察。测试结束只清理本轮命名空间，不调用全局清理或删除用户状态。详细复现见 `docs/phase0-storage.md`。
