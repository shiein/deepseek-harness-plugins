/*
 * 受控响应层注入的 bootstrap（方案 §6.8）。以内联 <script> 注入到文档最前，早于任何业务脚本。
 *
 * 约束（见 AGENTS.md）：
 *  - 普通 JavaScript（ES2017），经典脚本 + IIFE；不 import 任何模块，不依赖 TS
 *  - 只做观测与上报，不修改业务逻辑；唯一的请求改写是把跨源 fetch/XHR 导回同源自有 Mock 层（不转发）
 *  - 上报走同源回传通道 /__dsh_preview/report，带会话 nonce
 *
 * Runner 注入前把 __DSH_PREVIEW_CONFIG__ 占位替换为 JSON：{ previewId, nonce, assertions, pageTextLimit }
 */
;(function () {
  'use strict'
  var config = /*__DSH_PREVIEW_CONFIG__*/ null
  if (!config) return
  var endpoint = '/__dsh_preview/report'

  // 跨源业务请求导回自有 Mock 层（方案 §0.3 第 10 条）：fetch/XHR 发往其他 origin 的 http(s) 地址改写为
  // 同源 /__dsh_preview/remote/<origin>/<path>，由响应层按 fixture 的 origin 匹配，未命中明确失败并带原 origin；
  // 绝不转发真实后端。同源请求与非 http(s) 地址不变。
  var remotePrefix = '/__dsh_preview/remote/'
  function remoteUrl(raw) {
    try {
      var url = new URL(raw, location.href)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === location.origin) return undefined
      return location.origin + remotePrefix + encodeURIComponent(url.origin) + url.pathname + url.search
    } catch (e) {
      return undefined
    }
  }
  if (typeof window.fetch === 'function') {
    var nativeFetch = window.fetch
    window.fetch = function (input, init) {
      var raw = typeof input === 'string' ? input : input && (input.url || input.href)
      var rewritten = typeof raw === 'string' ? remoteUrl(raw) : undefined
      if (rewritten === undefined) return nativeFetch.call(this, input, init)
      if (typeof Request === 'function' && input instanceof Request) {
        return nativeFetch.call(this, new Request(rewritten, input), init)
      }
      return nativeFetch.call(this, rewritten, init)
    }
  }
  if (typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open) {
    var nativeOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function () {
      var args = Array.prototype.slice.call(arguments)
      var rewritten = args[1] !== undefined && args[1] !== null ? remoteUrl(String(args[1])) : undefined
      if (rewritten !== undefined) args[1] = rewritten
      return nativeOpen.apply(this, args)
    }
  }

  // Service Worker 边界（R5-1e）：只有检出项目 MSW（config.serviceWorker）才放行注册——
  // SW 命中请求在文档内被拦截、插件层不可见，未启用时隐藏 API 使 service-worker 通道的
  // block 声明成立；项目代码调用注册会以可见的 TypeError 失败，而非静默放行。
  if (!config.serviceWorker && typeof navigator === 'object' && 'serviceWorker' in navigator) {
    try {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true, enumerable: true,
        get: function () { return undefined },
      })
    } catch (e) {
      // defineProperty 失败时保持原 API；如实依赖运行环境，不假装已拦截。
    }
  }

  function report(payload) {
    try {
      var body = JSON.stringify({ nonce: config.nonce, previewId: config.previewId, report: payload })
      if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body)
      else fetch(endpoint, { method: 'POST', body: body, keepalive: true })
    } catch (e) {
      // 上报失败不得影响页面；Runner 侧以“未收到”判定 unverified
    }
  }

  window.addEventListener('error', function (event) {
    report({ kind: 'runtime-error', message: String(event.message), stack: event.error && event.error.stack, source: event.filename })
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason
    report({ kind: 'unhandled-rejection', message: String(reason && reason.message ? reason.message : reason), stack: reason && reason.stack })
  })
  document.addEventListener('securitypolicyviolation', function (event) {
    report({ kind: 'csp-violation', blockedURI: event.blockedURI, directive: event.violatedDirective })
  })
  document.addEventListener('DOMContentLoaded', function () {
    // __DSH_BUILD__ 由响应层按当前编译版本注入；缺失时省略字段（无构建宿主的文档不带版本证据）。
    var payload = { kind: 'document-loaded', url: location.href }
    if (typeof window.__DSH_BUILD__ === 'string') payload.build = window.__DSH_BUILD__
    report(payload)
    checkAssertions()
    observeText()
  })

  // R2-P0-2：同源构建长轮询。当前文档带 __DSH_BUILD__ 印章时启用——
  // since/seq 变化（新编译成功或手动 refresh）即 location.reload()；无变化由服务端挂起。
  var buildStamp = typeof window.__DSH_BUILD__ === 'string' ? window.__DSH_BUILD__ : undefined
  // fetch 缺失（旧环境/沙箱）如实不启用轮询——freshness 保持 unverified 而非崩溃。
  // 只有宿主声明了构建长轮询端点（__DSH_BUILD_POLL__）才启用；Vite 的 HMR 路径没有该端点。
  if (buildStamp !== undefined && window.__DSH_BUILD_POLL__ === true && typeof fetch === 'function') {
    var buildSeq
    var pollTimer
    function schedulePoll(delay) { pollTimer = setTimeout(pollBuild, delay) }
    function pollBuild() {
      var query = '/__dsh_preview/build?nonce=' + encodeURIComponent(config.nonce)
      if (buildSeq !== undefined) query += '&since=' + encodeURIComponent(buildStamp) + '&seq=' + buildSeq
      fetch(query).then(function (res) {
        if (!res.ok) throw new Error('build poll ' + res.status)
        return res.json()
      }).then(function (data) {
        if (!data || typeof data.build !== 'string' || typeof data.seq !== 'number') { schedulePoll(2000); return }
        if (buildSeq !== undefined && (data.build !== buildStamp || data.seq !== buildSeq)) {
          location.reload(); return
        }
        buildSeq = data.seq
        schedulePoll(0)
      }).catch(function () { schedulePoll(2000) })
    }
    window.addEventListener('pagehide', function () {
      if (pollTimer) clearTimeout(pollTimer)
    })
    pollBuild()
  }

  var mounted = false
  var assertions = config.assertions || []
  var assertionTimer
  var assertionDeadline
  var previousAssertions
  function visible(element) {
    if (!element || !element.isConnected || !element.getClientRects().length) return false
    for (var current = element; current; current = current.parentElement) {
      var style = window.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false
    }
    return true
  }
  function checkAssertions() {
    if (!assertions.length) return
    var results = assertions.map(function (assertion) {
      if (assertion.kind === 'mount-signal') return mounted
      if (assertion.kind === 'text-present') return !!document.body && document.body.innerText.indexOf(assertion.text) !== -1
      if (assertion.kind === 'selector-visible') {
        try { return Array.prototype.some.call(document.querySelectorAll(assertion.selector), visible) }
        catch (error) { return false }
      }
      return false
    })
    var serialized = JSON.stringify(results)
    if (serialized !== previousAssertions) {
      previousAssertions = serialized
      // 一次报告同一时刻的全部断言，Runner 不拼接不同时间的部分成功。
      report({ kind: 'assertions', url: location.href, results: results })
    }
    if (results.every(Boolean)) stopAssertions()
  }
  function stopAssertions() {
    if (assertionTimer) clearInterval(assertionTimer)
    if (assertionDeadline) clearTimeout(assertionDeadline)
    assertionTimer = undefined
    assertionDeadline = undefined
  }
  if (assertions.length) {
    assertionTimer = setInterval(checkAssertions, 100)
    assertionDeadline = setTimeout(stopAssertions, config.targetDeadlineMs)
    window.addEventListener('pagehide', stopAssertions)
  }
  // 可见文本摘要（限长 config.pageTextLimit），供 page_preview_status 的文本验证信号；
  // 文本经回传通道边界脱敏后才进入工具输出。
  var textObserver
  var textTimer
  var previousText
  // P2-10：innerText 读取会强制重排。首帧与 mounted() 仍立即采集；DOM 变化合并为每
  // PAGE_TEXT_INTERVAL_MS 至多一次。attributeFilter 的 class/style/hidden/open 会改变可见文本
  // （弹窗、折叠），保留观察，只靠节流降低重排次数。
  var PAGE_TEXT_INTERVAL_MS = 1000
  function queueText() {
    if (!textTimer) textTimer = setTimeout(sendText, PAGE_TEXT_INTERVAL_MS)
  }
  function sendText() {
    var timer = textTimer
    textTimer = undefined
    if (timer) clearTimeout(timer)
    if (!document.body) return
    var limit = config.pageTextLimit || 2048
    var content = document.body.innerText.trim()
    var text = content.slice(0, limit)
    var truncated = content.length > limit
    var signature = JSON.stringify([location.href, text, truncated])
    if (signature === previousText) return
    previousText = signature
    report({ kind: 'page-text', url: location.href, text: text, truncated: truncated })
  }
  function observeText() {
    sendText()
    // 真实浏览器必有 MutationObserver；缺失时仍保留初次与挂载后的采集，不影响页面。
    if (document.body && !textObserver && typeof MutationObserver === 'function') {
      textObserver = new MutationObserver(queueText)
      textObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] })
    }
  }
  window.addEventListener('pagehide', function () {
    if (textObserver) textObserver.disconnect()
    if (textTimer) clearTimeout(textTimer)
    textTimer = undefined
  })
  window.__DSH_PREVIEW__ = {
    // 预览入口模块上报已应用的 HMR 版本（module-updated）；未经 nonce 的项目脚本伪造不了通道。
    report: report,
    // mock-only 的业务数据控制在服务端自有响应层（方案 §0.3 方案 A）：本脚本只会由该层注入文档，
    // 文档到达浏览器时未命中即失败、fixture 应答、CSP connect-src 'self' 均已生效，因此就绪是既成事实。
    // 2026-11-03 实机：此前从未设置该信号，默认 mock-only 的 Vue 入口一律抛错、页面空白。
    mockReady: Promise.resolve('response-layer'),
    mounted: function (detail) {
      mounted = true
      report({ kind: 'target-mounted', detail: detail })
      checkAssertions()
      sendText()
    },
  }
})()
