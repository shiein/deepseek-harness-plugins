/* Phase 0 浏览器样本（方案 §14、§15.1）：只请求本机探针，不访问真实业务服务。 */
document.getElementById('result').textContent = window.__DSH_PREVIEW__ ? 'bootstrap 先于业务脚本' : '失败：bootstrap 未就绪'
function note(text) {
  var item = document.createElement('li')
  item.textContent = text
  document.getElementById('checks').appendChild(item)
}
document.getElementById('errors').onclick = function () {
  setTimeout(function () { throw new Error('phase0-runtime-error') }, 0)
  Promise.reject(new Error('phase0-unhandled-rejection'))
}
document.getElementById('network').onclick = function () {
  fetch('/api/unmatched').then(function (response) { note('同源未匹配请求：' + response.status) })
  fetch('http://localhost:' + location.port + '/phase0/cross-origin').then(function () {
    note('失败：跨源请求被放行')
  }, function () { note('跨源 fetch 已阻断') })
  var socket = new WebSocket('ws://' + location.host + '/phase0/ws')
  socket.onopen = function () { note('同源 WebSocket 已连接'); socket.close() }
  socket.onerror = function () { note('同源 WebSocket 失败') }
  var events = new EventSource('/phase0/events')
  events.onmessage = function () { note('同源 SSE 已连接'); events.close() }
}
document.getElementById('worker').onclick = function () {
  var worker = new Worker('/worker.js')
  worker.onmessage = function (event) { note('Worker：' + event.data); worker.terminate() }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/sw-scope/' }).then(function (registration) {
      note('Service Worker 可以注册（专用 /sw-scope/）')
      return registration.unregister()
    }, function (error) { note('Service Worker 注册失败：' + error.name) })
  }
}
