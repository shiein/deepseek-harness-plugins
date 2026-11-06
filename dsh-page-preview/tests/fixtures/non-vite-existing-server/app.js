/** 原生 ESM 业务页（方案 §14、§15.1）：本地 fixture API、history 路由、仅本样本的持久筛选偏好。 */
const filter = document.querySelector('#filter')
const body = document.querySelector('#orders')
const loadStatus = document.querySelector('#load-status')
const preference = 'page-preview-non-vite-demo:status'
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 })
let orders = []

function showDetail(id) {
  const order = orders.find((item) => item.id === id)
  if (!order) return
  document.querySelector('#detail-title').textContent = order.customer
  const detail = document.querySelector('#detail')
  detail.replaceChildren()
  const fields = [['订单编号', order.id], ['服务内容', order.item], ['创建日期', order.date], ['当前状态', order.status], ['订单金额', money.format(order.amount)]]
  const list = document.createElement('dl')
  fields.forEach(([label, value]) => {
    const term = document.createElement('dt')
    const description = document.createElement('dd')
    term.textContent = label; description.textContent = value
    list.append(term, description)
  })
  detail.append(list)
}

function render() {
  const visible = orders.filter((order) => filter.value === '全部' || order.status === filter.value)
  body.replaceChildren()
  visible.forEach((order) => {
    const row = document.createElement('tr')
    const customer = document.createElement('td')
    const name = document.createElement('strong')
    const id = document.createElement('small')
    name.textContent = order.customer; id.textContent = order.id
    customer.append(name, id); row.append(customer)
    ;[order.item, money.format(order.amount), order.status].forEach((text) => {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell)
    })
    const action = document.createElement('td')
    const link = document.createElement('a')
    link.href = '/orders/' + order.id; link.textContent = '查看详情'
    link.setAttribute('aria-label', '查看 ' + order.customer + ' 的订单详情')
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault(); history.pushState(null, '', link.href); showDetail(order.id)
    })
    action.append(link); row.append(action); body.append(row)
  })
  document.querySelector('#empty').hidden = visible.length !== 0
  loadStatus.textContent = '数据已加载 · ' + visible.length + ' 条订单'
}

async function start() {
  const saved = localStorage.getItem(preference)
  if (['全部', '待处理', '进行中', '已完成'].includes(saved)) filter.value = saved
  const response = await fetch('/api/orders')
  if (!response.ok) throw new Error('订单接口返回 HTTP ' + response.status)
  const payload = await response.json()
  orders = payload.orders
  render(); showDetail(location.pathname.split('/')[2])
  filter.addEventListener('change', () => {
    localStorage.setItem(preference, filter.value); render()
  })
  window.addEventListener('popstate', () => {
    document.querySelector('#detail-title').textContent = '选择一个订单'
    document.querySelector('#detail').textContent = '点击列表中的“查看详情”，在这里查看项目摘要。'
    showDetail(location.pathname.split('/')[2])
  })
}
start().catch((error) => {
  loadStatus.textContent = '加载失败：' + error.message
  loadStatus.setAttribute('role', 'alert')
})
