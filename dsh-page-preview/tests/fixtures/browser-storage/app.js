/** 存储样本交互（方案 §7.4、§14）：只操作一个本次随机 localStorage key，Cookie 观察由服务端过滤。 */
const base = location.pathname
const label = document.querySelector('#label')
label.value = new URLSearchParams(location.search).get('label') === 'B' ? 'B' : 'A'
const result = document.querySelector('#result')
let config
async function request(path, options) {
  const response = await fetch(path, options)
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return response.status === 204 ? null : response.json()
}
function localValue() {
  const value = localStorage.getItem(config.storageKey)
  return value === null || value === 'A' || value === 'B' ? value : 'unexpected'
}
async function inspect(name) {
  const value = localValue()
  const cookies = await request(base + 'read?case=' + name)
  document.querySelector('#local').textContent = value === null ? '未写入' : value
  document.querySelector('#cookies').textContent = JSON.stringify(cookies.present)
  await request(base + 'report', { method: 'POST', body: JSON.stringify({ case: name, label: label.value, local: value, topLevel: window.top === window }) })
  result.textContent = name + ' · 已记录样本观察'
}
function bind(id, operation) {
  document.querySelector(id).addEventListener('click', () => {
    void operation().catch((error) => { result.textContent = '失败：' + error.message })
  })
}
async function start() {
  config = await request(base + 'config')
  document.querySelector('#origin').textContent = location.origin
  document.querySelector('#alias').href = config.aliasOrigin + base + '?label=' + label.value
  document.querySelector('#other').href = config.otherOrigin + base + '?label=' + label.value
  document.querySelector('#navigate').href = config.aliasOrigin + base + 'read?case=cross-navigation'
  bind('#write', async () => { await request(base + 'seed'); localStorage.setItem(config.storageKey, label.value); await inspect('written') })
  bind('#inspect', () => inspect('recheck'))
  bind('#clear', async () => { await request(base + 'clear'); localStorage.removeItem(config.storageKey); await inspect('cleared') })
  bind('#cross', async () => {
    const value = await request(config.aliasOrigin + base + 'read?case=cross-fetch', { credentials: 'include' })
    result.textContent = 'cross-fetch · site=' + value.site + ' · ' + JSON.stringify(value.present)
  })
  await inspect('initial')
}
start().catch((error) => { result.textContent = '失败：' + error.message })
