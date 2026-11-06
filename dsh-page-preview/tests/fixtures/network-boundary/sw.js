/* 私有样本 SW；仅响应本样本页面主动请求，不缓存/拦截用户流量。 */
self.addEventListener('install', function (event) { event.waitUntil(self.skipWaiting()) })
self.addEventListener('message', function (event) {
  event.waitUntil((async function () {
    var external = new URLSearchParams(self.location.search).get('external')
    var cross = await fetch(external + '/service-worker-data').then(function () { return 'allowed' }, function () { return 'blocked' })
    var same = await fetch('./api/unmatched').then(function (response) { return response.status })
    event.source.postMessage({ cross: cross, unmatched: same })
  })())
})
