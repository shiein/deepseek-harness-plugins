/* 浏览器真实 API 探针（方案 §6.8、§7.3）；仅自建 loopback 接口，注销自己创建的 SW。 */
(async function () {
  var external = new URL(new URLSearchParams(location.search).get('external'))
  if (external.protocol !== 'http:' || external.hostname !== '127.0.0.1' || !external.port || external.username || external.password) throw new Error('Expected owned loopback probe')
  var origin = external.origin
  var results = { userAgent: navigator.userAgent, inlineScript: window.__networkProbeInline === true, localScript: true, eval: eval('1 + 1') === 2 }
  results.inlineStyle = getComputedStyle(document.body).getPropertyValue('--network-probe-inline').trim() === '1'
  results.localStyle = getComputedStyle(document.body).getPropertyValue('--network-probe-local').trim() === '1'
  var violations = []
  document.addEventListener('securitypolicyviolation', function (event) { if (event.blockedURI.indexOf(origin) === 0 || event.blockedURI.indexOf(origin.replace('http:', 'ws:')) === 0) violations.push(event.effectiveDirective) })
  function timeout(promise) {
    return Promise.race([promise, new Promise(function (resolve) { setTimeout(function () { resolve('timeout') }, 7000) })])
  }
  results.fetch = await fetch(origin + '/fetch').then(function () { return 'allowed' }, function () { return 'blocked' })
  results.websocket = await timeout(new Promise(function (resolve) {
    var socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws')
    socket.onopen = function () { socket.close(); resolve('allowed') }
    socket.onerror = function () { socket.close(); resolve('blocked') }
  }))
  results.sse = await timeout(new Promise(function (resolve) {
    var events = new EventSource(origin + '/sse')
    events.onopen = function () { events.close(); resolve('allowed') }
    events.onerror = function () { events.close(); resolve('blocked') }
  }))
  results.blobWorker = await timeout(new Promise(function (resolve) {
    var url = URL.createObjectURL(new Blob(['self.postMessage("allowed")'], { type: 'text/javascript' }))
    var worker = new Worker(url)
    worker.onmessage = function (event) { worker.terminate(); URL.revokeObjectURL(url); resolve(event.data) }
    worker.onerror = function () { worker.terminate(); URL.revokeObjectURL(url); resolve('blocked') }
  }))
  results.worker = await timeout(new Promise(function (resolve) {
    var worker = new Worker('./worker.js?external=' + encodeURIComponent(origin))
    worker.onmessage = function (event) { worker.terminate(); resolve(event.data) }
    worker.onerror = function () { worker.terminate(); resolve('error') }
  }))
  var registration
  try {
    registration = await navigator.serviceWorker.register('./sw.js?external=' + encodeURIComponent(origin), { scope: './' })
    var active = registration.active || registration.installing || registration.waiting
    if (active.state !== 'activated') await timeout(new Promise(function (resolve) {
      active.addEventListener('statechange', function () { if (active.state === 'activated') resolve() })
    }))
    results.serviceWorker = await timeout(new Promise(function (resolve) {
      function message(event) {
        if (event.source !== active) return
        navigator.serviceWorker.removeEventListener('message', message)
        resolve(event.data)
      }
      navigator.serviceWorker.addEventListener('message', message)
      active.postMessage('probe')
    }))
  } catch (_) { results.serviceWorker = 'unavailable' }
  finally { if (registration) results.serviceWorkerUnregistered = await registration.unregister() }
  results.jsonp = await timeout(new Promise(function (resolve) {
    var script = document.createElement('script')
    window.__networkProbeJsonp = function () { resolve('allowed') }
    script.onload = function () { script.remove(); delete window.__networkProbeJsonp }
    script.onerror = function () { script.remove(); delete window.__networkProbeJsonp; resolve('blocked') }
    script.src = origin + '/jsonp'
    document.head.appendChild(script)
  }))
  results.externalWorker = await timeout(new Promise(function (resolve) {
    var worker
    try {
      worker = new Worker(origin + '/external-worker.js', { type: 'module' })
      worker.onmessage = function () { worker.terminate(); resolve('allowed') }
      worker.onerror = function () { worker.terminate(); resolve('blocked') }
    } catch (_) { resolve('blocked') }
  }))
  results.image = await timeout(new Promise(function (resolve) {
    var image = new Image()
    image.onload = function () { resolve('allowed') }
    image.onerror = function () { resolve('blocked') }
    image.src = origin + '/pixel.svg'
  }))
  results.localFrame = await timeout(new Promise(function (resolve) {
    var frame = document.createElement('iframe')
    function message(event) {
      if (event.origin !== location.origin || !event.data.networkProbeLocalFrame) return
      window.removeEventListener('message', message)
      frame.remove()
      resolve('allowed')
    }
    window.addEventListener('message', message)
    frame.src = './frame.html'
    document.body.appendChild(frame)
  }))
  results.stylesheet = await timeout(new Promise(function (resolve) {
    var link = document.createElement('link')
    link.rel = 'stylesheet'
    link.onload = function () { link.remove(); resolve('allowed') }
    link.onerror = function () { link.remove(); resolve('blocked') }
    link.href = origin + '/style.css'
    document.head.appendChild(link)
  }))
  results.frame = await timeout(new Promise(function (resolve) {
    var frame = document.createElement('iframe')
    function message(event) {
      if (event.origin !== origin || !event.data.networkProbeFrame) return
      window.removeEventListener('message', message)
      document.removeEventListener('securitypolicyviolation', policy)
      frame.remove()
      resolve('allowed')
    }
    function policy(event) {
      if (event.effectiveDirective !== 'frame-src') return
      document.removeEventListener('securitypolicyviolation', policy)
      window.removeEventListener('message', message)
      frame.remove()
      resolve('blocked')
    }
    window.addEventListener('message', message)
    document.addEventListener('securitypolicyviolation', policy)
    frame.src = origin + '/frame.html'
    document.body.appendChild(frame)
  }))
  results.finished = true
  results.violations = violations
  document.getElementById('results').textContent = JSON.stringify(results, null, 2)
})().catch(function () { document.getElementById('results').textContent = JSON.stringify({ finished: false, error: 'Probe failed' }) })
