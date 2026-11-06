/** Vue 真实浏览器通道组合样本（方案 §6.8、§7.3、§15.3）；仅自有 loopback 后端，计数用于核对是否实际到达。 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectConfig } from '../../src/shared/config/schema.ts'
import type { createVueViteFixture } from './vue-vite-fixture.ts'

export async function prepareVueNetworkFixture(fixture: Awaited<ReturnType<typeof createVueViteFixture>>, project: ProjectConfig) {
  const hits: Record<string, number> = {}
  const count = (path: string) => { hits[path] = (hits[path] ?? 0) + 1 }
  const backend = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname
    if (path === '/stats') { res.end(JSON.stringify(hits)); return }
    count(path)
    res.setHeader('Access-Control-Allow-Origin', '*')
    const values: Record<string, [string, string]> = {
      '/sse': ['text/event-stream', 'data: external\n\n'],
      '/jsonp': ['text/javascript', 'window.__vueProbeJsonp("external")'],
      '/style.css': ['text/css', 'body { --external-probe: 1 }'],
      '/pixel.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'],
      '/frame.html': ['text/html', '<!doctype html><script>parent.postMessage({externalFrame:true},"*")</script>'],
    }
    const [type, body] = values[path] ?? ['application/json', '{"external":true}']
    res.writeHead(200, { 'Content-Type': type }); res.end(body)
  })
  backend.on('upgrade', (req, socket) => { count(new URL(req.url ?? '/', 'http://fixture.invalid').pathname); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') })
  await new Promise<void>((resolve, reject) => { backend.once('error', reject); backend.listen(0, '127.0.0.1', resolve) })
  const address = backend.address()
  if (!address || typeof address === 'string') throw new Error('Own network backend address missing')
  const entry = await fixture.ledger.record({ previewId: fixture.input.previewId, ownerSessionId: fixture.input.ownerSessionId, workspaceRoot: fixture.root, resource: { kind: 'port', port: address.port, pid: process.pid } })
  const origin = 'http://127.0.0.1:' + address.port
  const close = async () => { await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve())); await fixture.ledger.release(entry.id) }
  try {
    project.scenarios = { own: { businessPaths: ['/api/**'], http: [
      { method: 'GET', path: '/api/fixture', response: { status: 200, body: { value: 'owned-fixture' } } },
      { method: 'GET', path: '/api/events', response: { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'data: fixture-event\n\n' } },
    ] } }
    let config = await readFile(join(fixture.appRoot, 'vite.config.mjs'), 'utf8')
    config = `import {get as signalReached} from 'node:http'\nimport {createHash} from 'node:crypto'\n` + config.replace('plugins: [', `plugins: [{name:'own-network-probe',
      transformIndexHtml(){return [{tag:'script',injectTo:'head-prepend',children:'window.__vueNetworkInline = !!window.__DSH_PREVIEW__'}]},
      configureServer(vite){vite.config.server.hmr.server.on('upgrade',(req,socket)=>{
        if(new URL(req.url,'http://fixture.invalid').pathname !== '/api/socket')return
        const signal=signalReached(${JSON.stringify(origin + '/project-upgrade')},res=>res.resume()); signal.on('error',error=>{throw error})
        const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        socket.end('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n')
      })}
    },`)
    config = config.replace('resolve: { alias:', `server:{proxy:{'/api/proxy':{target:${JSON.stringify(origin)},changeOrigin:true}}},resolve: { alias:`)
    await fixture.put('vite.config.mjs', config)
    await fixture.put('theme.css', 'article { --probe-local: 1; padding: 16px; font-family: sans-serif } pre { white-space: pre-wrap }')
    const worker = `var external=${JSON.stringify(origin)};
      async function check(){var cross=await fetch(external+'/worker-data').then(()=> 'allowed',()=> 'blocked'); var same=await fetch('/api/fixture').then(r=>r.json()); var missing=await fetch('/api/unmatched').then(r=>r.status); return {cross:cross,fixture:same.value,unmatched:missing}}
      self.onmessage=async()=>self.postMessage(await check());`
    await fixture.put('public/__vue_net/worker.js', worker)
    await fixture.put('public/__vue_net/shared.js', worker.replace("self.onmessage=async()=>self.postMessage(await check());", "self.onconnect=function(event){var port=event.ports[0];port.onmessage=async()=>port.postMessage(await check());port.start()};"))
    await fixture.put('public/__vue_net/sw.js', `var external=${JSON.stringify(origin)};
      self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
      self.addEventListener('message',event=>event.waitUntil((async()=>{var cross=await fetch(external+'/service-worker-data').then(()=> 'allowed',()=> 'blocked'); var same=await fetch('/api/fixture').then(r=>r.json()); var missing=await fetch('/api/unmatched').then(r=>r.status); event.source.postMessage({cross:cross,fixture:same.value,unmatched:missing})})()));`)
    await fixture.put('public/__vue_net/frame.html', `<!doctype html><html><body><p>Owned child document</p><script>(async()=>{var cross=await fetch(${JSON.stringify(origin + '/frame-data')}).then(()=> 'allowed',()=> 'blocked');var missing=await fetch('/api/unmatched').then(r=>r.status);parent.postMessage({kind:'vue-net-frame',cross:cross,unmatched:missing},location.origin)})()</script></body></html>`)
    await fixture.put('src/network-probe.js', browserProbe(origin))
    await fixture.put('src/Target.vue', `<script setup>
      import {ref,onMounted} from 'vue'
      import {runNetworkProbe} from './network-probe.js'
      const count=ref(0)
      const results=ref({finished:false})
      onMounted(async()=>{try{results.value=await runNetworkProbe()}catch(error){results.value={finished:false,error:'Probe failed'}}})
    </script><template><article style="--probe-inline:1"><h1>Vue browser network boundary</h1><button @click="count++">Network counter: {{count}}</button><p>{{results.finished ? 'Vue network probe finished' : 'Network probe running'}}</p><pre id="network-results">{{JSON.stringify(results,null,2)}}</pre></article></template>`)
    return { origin, hits, close }
  } catch (error) { await close(); throw error }
}

function browserProbe(origin: string): string {
  return `export async function runNetworkProbe() {
    var external=${JSON.stringify(origin)}
    var results={inlineScript:window.__vueNetworkInline===true,eval:eval('1+1')===2,inlineStyle:getComputedStyle(document.querySelector('article')).getPropertyValue('--probe-inline').trim()==='1',localStyle:getComputedStyle(document.querySelector('article')).getPropertyValue('--probe-local').trim()==='1'}
    function bounded(run,dispose){return new Promise(resolve=>{var done=false;var timer=setTimeout(()=>finish('timeout'),2000);function finish(value){if(done)return;done=true;clearTimeout(timer);if(dispose)dispose();resolve(value)}run(finish)})}
    function socket(url){var ws;return bounded(done=>{ws=new WebSocket(url);ws.onopen=()=>done('allowed');ws.onerror=()=>done('blocked')},()=>{if(ws)ws.close()})}
    function sse(url,readMessage){var stream;return bounded(done=>{stream=new EventSource(url);stream.onopen=()=>{if(!readMessage)done('allowed')};stream.onmessage=event=>{if(readMessage)done(event.data)};stream.onerror=()=>done('blocked')},()=>{if(stream)stream.close()})}
    results.fetch=await fetch(external+'/fetch').then(()=> 'allowed',()=> 'blocked')
    results.xhr=await bounded(done=>{var xhr=new XMLHttpRequest();xhr.open('GET',external+'/xhr');xhr.onload=()=>done('allowed');xhr.onerror=()=>done('blocked');xhr.send()})
    results.beaconQueued=navigator.sendBeacon(external+'/beacon','own-probe')
    results.crossSocket=await socket(external.replace('http:','ws:')+'/ws')
    results.businessSocket=await socket(location.origin.replace('http:','ws:')+'/api/socket?private=DO_NOT_REPORT_QUERY')
    results.crossSse=await sse(external+'/sse')
    results.businessSse=await sse('/api/unmatched')
    results.fixtureSse=await sse('/api/events',true)
    results.fixture=await fetch('/api/fixture').then(r=>r.json())
    results.proxy=await fetch('/api/proxy').then(r=>r.status)
    var worker;results.worker=await bounded(done=>{worker=new Worker('/__vue_net/worker.js');worker.onmessage=event=>done(event.data);worker.onerror=()=>done('error');worker.postMessage('probe')},()=>{if(worker)worker.terminate()})
    var blobUrl=URL.createObjectURL(new Blob(['fetch('+JSON.stringify(external+'/blob-worker-data')+').then(()=>self.postMessage("allowed"),()=>self.postMessage("blocked"))'],{type:'text/javascript'}));var blobWorker
    results.blobWorker=await bounded(done=>{blobWorker=new Worker(blobUrl);blobWorker.onmessage=event=>done(event.data);blobWorker.onerror=()=>done('error')},()=>{if(blobWorker)blobWorker.terminate();URL.revokeObjectURL(blobUrl)})
    var shared
    if(typeof SharedWorker==='undefined')results.sharedWorker='unavailable'
    else results.sharedWorker=await bounded(done=>{shared=new SharedWorker('/__vue_net/shared.js');shared.port.onmessage=event=>done(event.data);shared.onerror=()=>done('error');shared.port.start();shared.port.postMessage('probe')},()=>{if(shared)shared.port.close()})
    var registration
    try {
      registration=await navigator.serviceWorker.register('/__vue_net/sw.js',{scope:'/__vue_net/'})
      var active=registration.active||registration.installing||registration.waiting
      if(active.state!=='activated')await bounded(done=>{active.addEventListener('statechange',()=>{if(active.state==='activated')done('activated')})})
      var listener
      results.serviceWorker=await bounded(done=>{listener=event=>{if(event.source===active)done(event.data)};navigator.serviceWorker.addEventListener('message',listener);active.postMessage('probe')},()=>navigator.serviceWorker.removeEventListener('message',listener))
    } catch(error){results.serviceWorker='unavailable'}
    finally{if(registration)results.serviceWorkerUnregistered=await registration.unregister()}
    var child;var message
    results.localFrame=await bounded(done=>{child=document.createElement('iframe');child.title='Owned network child';message=event=>{if(event.source===child.contentWindow&&event.origin===location.origin&&event.data.kind==='vue-net-frame')done(event.data)};window.addEventListener('message',message);child.src='/__vue_net/frame.html';document.body.appendChild(child)},()=>{if(message)window.removeEventListener('message',message);if(child)child.remove()})
    var jsonp
    results.jsonp=await bounded(done=>{jsonp=document.createElement('script');window.__vueProbeJsonp=()=>done('allowed');jsonp.onerror=()=>done('blocked');jsonp.src=external+'/jsonp';document.head.appendChild(jsonp)},()=>{delete window.__vueProbeJsonp;if(jsonp)jsonp.remove()})
    results.image=await bounded(done=>{var image=new Image();image.onload=()=>done('allowed');image.onerror=()=>done('blocked');image.src=external+'/pixel.svg'})
    var style
    results.stylesheet=await bounded(done=>{style=document.createElement('link');style.rel='stylesheet';style.onload=()=>done('allowed');style.onerror=()=>done('blocked');style.href=external+'/style.css';document.head.appendChild(style)},()=>{if(style)style.remove()})
    var frame;var policy
    results.crossFrame=await bounded(done=>{frame=document.createElement('iframe');policy=event=>{if(event.effectiveDirective==='frame-src')done('blocked')};document.addEventListener('securitypolicyviolation',policy);frame.src=external+'/frame.html';document.body.appendChild(frame)},()=>{document.removeEventListener('securitypolicyviolation',policy);if(frame)frame.remove()})
    results.finished=true
    return results
  }`
}
