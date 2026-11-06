/* 私有样本 Worker；响应带产品 CSP，实际请求结果经消息回传。 */
(async function () {
  var external = new URLSearchParams(self.location.search).get('external')
  var cross = await fetch(external + '/worker-data').then(function () { return 'allowed' }, function () { return 'blocked' })
  var same = await fetch('./api/unmatched').then(function (response) { return response.status })
  self.postMessage({ cross: cross, unmatched: same })
})()
