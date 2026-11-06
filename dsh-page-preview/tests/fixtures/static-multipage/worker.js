/* Worker 也需要脚本响应的 CSP；文档响应的策略不能替代它。 */
fetch('http://localhost:' + location.port + '/phase0/cross-origin').then(function () {
  postMessage('失败：跨源 fetch 被放行')
}, function () { postMessage('跨源 fetch 已阻断') })
