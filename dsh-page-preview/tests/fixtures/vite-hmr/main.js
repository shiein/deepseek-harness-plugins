/** Phase 0 HMR 页面（方案 §6.8、§9.2、§14）：监听真实 Vite 事件，模块更新与文档加载分别记录。 */
import { revision } from './target.js'
import './style.css'

const label = document.querySelector('#revision')
const status = document.querySelector('#status')
const counter = document.querySelector('#increment')
document.querySelector('#bootstrap').textContent = window.__DSH_PREVIEW__ ? 'bootstrap 先于业务模块' : '失败：bootstrap 缺失'
let count = 0
counter.addEventListener('click', () => {
  count++
  counter.textContent = '交互计数：' + count
})
function render(value) {
  label.textContent = value
  status.textContent = 'current · ' + value
  if (window.__DSH_PREVIEW__) window.__DSH_PREVIEW__.mounted(value)
}
render(revision)
if (import.meta.hot) {
  import.meta.hot.accept('./target.js', (module) => {
    if (module) render(module.revision)
    else status.textContent = 'update_error · 模块加载失败，保留 ' + label.textContent
  })
  import.meta.hot.on('vite:beforeUpdate', () => { status.textContent = 'updating' })
  import.meta.hot.on('vite:error', (payload) => {
    status.textContent = 'compile_error · 保留 ' + label.textContent + ' · ' + payload.err.message
  })
}
