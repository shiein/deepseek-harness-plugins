/**
 * Agent Token Usage — Client half.
 *
 * Registers a left-sidebar panel entry and a one-screen dashboard rendered in the center column.
 * Layout: header + KPI strip + tab/filter bar + a single fill-height content pane per tab.
 * Nothing scrolls — every list paginates to its measured pane height and the panel itself is
 * `overflow: hidden`. Data comes from the plugin's loopback JSON API; a scan only runs on Refresh.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-agent-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'agent-usage';
    const PANEL_ID = 'agent-usage';
    const PANEL_ORDER = 20;
    const API = {
      snapshot: '/api/dsh-agent-usage/snapshot',
      scan: '/api/dsh-agent-usage/scan',
    };

    // ---------------------------------------------------------------------------------------
    // Copy (zh is the source language, en mirrors every key)
    // ---------------------------------------------------------------------------------------

    const zh = {
      'entry.label': 'Agent 用量',
      'page.title': 'Agent 用量',
      'page.subtitle': '本机 AI 编程 Agent 的 Token 消耗 · 仅手动刷新时扫描',
      'action.refresh': '刷新',
      'action.refreshing': '扫描中',
      'action.scanNow': '扫描本机用量',
      'action.retry': '重试',
      'state.loading': '正在读取上次扫描结果…',
      'state.empty.title': '还没有用量数据',
      'state.empty.body': '扫描本机 Agent 保存的会话文件，统计 Token 消耗与估算费用。扫描只在点击时运行，不会定时读取文件。',
      'state.empty.supported': 'Claude Code · Codex · DeepSeek Harness · OpenCode · Cursor · Trae · Qoder · Devin · Pi · Copilot CLI · Gemini CLI · Cline · Goose · Crush · Aider · Zed …',
      'state.error.title': '读取失败',
      'state.noMatch': '当前筛选下没有数据',
      'scan.never': '尚未扫描',
      'scan.at': '刷新于 {time}',
      'scan.meta': '{units} 个统计单元 · {duration}',
      'scan.manual': '手动刷新',
      'range.7': '7 天',
      'range.30': '30 天',
      'range.90': '90 天',
      'range.all': '全部',
      'filter.agent': 'Agent',
      'filter.model': '模型',
      'filter.allAgents': '全部 Agent',
      'filter.allModels': '全部模型',
      'kpi.totalTokens': '有效 Token',
      'kpi.cost': '估算费用',
      'kpi.cacheHit': '缓存命中率',
      'kpi.messages': '模型消息',
      'kpi.effectiveHint': '总 {total} · 缓存读 {read}',
      'kpi.costHint': '按公开 API 价格估算，非账单',
      'kpi.cacheHint': '缓存读 {read} · 缓存写 {write}',
      'kpi.messageHint': '{agents} Agent · {models} 模型',
      'tab.trend': '趋势',
      'tab.agent': '按 Agent',
      'tab.model': '按模型',
      'tab.date': '按日期',
      'tab.sources': '数据来源',
      'chart.title': '每日用量',
      'chart.total': '{tokens} Token',
      'chart.effectiveTotal': '有效 {tokens}',
      'chart.avg': '日均 {tokens}',
      'chart.modeEffective': '有效',
      'chart.modeFull': '含缓存',
      'chart.empty': '所选范围内没有每日数据',
      'legend.input': '输入',
      'legend.output': '输出',
      'legend.cacheRead': '缓存读',
      'legend.cacheWrite': '缓存写',
      'rank.agents': 'Agent 排行',
      'rank.models': '模型排行',
      'table.col.total': 'Token',
      'table.col.input': '输入',
      'table.col.output': '输出',
      'table.col.cacheRead': '缓存读',
      'table.col.cacheWrite': '缓存写',
      'table.col.messages': '消息',
      'table.col.cost': '费用',
      'table.col.share': '占比',
      'table.empty': '当前筛选下没有可显示的记录',
      'pager.range': '{from}–{to} / {total}',
      'pager.prev': '上一页',
      'pager.next': '下一页',
      'sources.title': '数据来源',
      'sources.count': '{readable} / {total} 个适配器有数据',
      'sources.files': '{files} 文件',
      'sources.status.ok': '已读取',
      'sources.status.empty': '无本地用量',
      'sources.status.not-installed': '未安装',
      'sources.status.error': '读取失败',
      'sources.status.broken': '插件异常',
      'sources.warn': '提示',
      'footer.pricing': '价目表 v{version}',
      'footer.pricingHint': '按公开 API 价格估算（美元 / 百万 token）；插件配置的 prices 字段可覆盖或补充单价',
      'footer.overrides': '自定义单价',
      'footer.overrideCount': '自定义 {n} 项',
      'footer.invalid': '无效的自定义单价（未生效）',
      'footer.invalidCount': '{n} 项自定义单价无效',
      'footer.unpriced': '没有单价的模型',
      'footer.dir': '{dir}',
    };

    const en = {
      'entry.label': 'Agent Usage',
      'page.title': 'Agent Usage',
      'page.subtitle': 'Token usage of local coding agents · scan only on refresh',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Scanning',
      'action.scanNow': 'Scan this machine',
      'action.retry': 'Retry',
      'state.loading': 'Loading the last scan…',
      'state.empty.title': 'No usage data yet',
      'state.empty.body': 'Scan session files saved by local coding agents to see token usage and estimated cost. Nothing reads files on a timer.',
      'state.empty.supported': 'Claude Code · Codex · DeepSeek Harness · OpenCode · Cursor · Trae · Qoder · Devin · Pi · Copilot CLI · Gemini CLI · Cline · Goose · Crush · Aider · Zed …',
      'state.error.title': 'Request failed',
      'state.noMatch': 'No data for the current filters',
      'scan.never': 'Never scanned',
      'scan.at': 'Refreshed {time}',
      'scan.meta': '{units} buckets · {duration}',
      'scan.manual': 'manual refresh only',
      'range.7': '7d',
      'range.30': '30d',
      'range.90': '90d',
      'range.all': 'All',
      'filter.agent': 'Agent',
      'filter.model': 'Model',
      'filter.allAgents': 'All agents',
      'filter.allModels': 'All models',
      'kpi.totalTokens': 'Effective tokens',
      'kpi.cost': 'Est. cost',
      'kpi.cacheHit': 'Cache hit rate',
      'kpi.messages': 'Model messages',
      'kpi.effectiveHint': 'total {total} · cache read {read}',
      'kpi.costHint': 'public API prices, not a bill',
      'kpi.cacheHint': 'cache read {read} · write {write}',
      'kpi.messageHint': '{agents} agents · {models} models',
      'tab.trend': 'Overview',
      'tab.agent': 'By agent',
      'tab.model': 'By model',
      'tab.date': 'By date',
      'tab.sources': 'Sources',
      'chart.title': 'Daily usage',
      'chart.total': '{tokens} tokens',
      'chart.effectiveTotal': 'effective {tokens}',
      'chart.avg': 'avg {tokens}',
      'chart.modeEffective': 'Effective',
      'chart.modeFull': 'With cache',
      'chart.empty': 'No daily data in the selected range',
      'legend.input': 'Input',
      'legend.output': 'Output',
      'legend.cacheRead': 'Cache read',
      'legend.cacheWrite': 'Cache write',
      'rank.agents': 'Top agents',
      'rank.models': 'Top models',
      'table.col.total': 'Tokens',
      'table.col.input': 'Input',
      'table.col.output': 'Output',
      'table.col.cacheRead': 'Cache read',
      'table.col.cacheWrite': 'Cache write',
      'table.col.messages': 'Msgs',
      'table.col.cost': 'Cost',
      'table.col.share': 'Share',
      'table.empty': 'No rows for the current filters',
      'pager.range': '{from}–{to} / {total}',
      'pager.prev': 'Previous page',
      'pager.next': 'Next page',
      'sources.title': 'Data sources',
      'sources.count': '{readable} / {total} adapters have data',
      'sources.files': '{files} files',
      'sources.status.ok': 'Read',
      'sources.status.empty': 'No local usage',
      'sources.status.not-installed': 'Not installed',
      'sources.status.error': 'Read error',
      'sources.status.broken': 'Plugin error',
      'sources.warn': 'Note',
      'footer.pricing': 'price table v{version}',
      'footer.pricingHint': 'Estimated from public API list prices (USD per 1M tokens); the plugin config field prices overrides or adds rates',
      'footer.overrides': 'Custom rates',
      'footer.overrideCount': '{n} custom',
      'footer.invalid': 'Invalid custom rates (not applied)',
      'footer.invalidCount': '{n} invalid custom rates',
      'footer.unpriced': 'Models without a price',
      'footer.dir': '{dir}',
    };

    const DICTS = { zh, en };

    function makeTranslate(ctx) {
      function currentLocale() {
        try {
          const snapshot = ctx.locale.getSnapshot();
          // LocaleRuntime snapshots are { active, locales, revision }.
          const id = snapshot?.active || snapshot?.locale || snapshot?.id || snapshot?.language || '';
          if (typeof id === 'string' && id.toLowerCase().startsWith('zh')) return 'zh';
          if (typeof id === 'string' && id !== '') return 'en';
        } catch {
          // fall through
        }
        return 'zh';
      }
      function translate(key, values) {
        const locale = currentLocale();
        const dict = DICTS[locale] || zh;
        let text = dict[key] ?? en[key] ?? key;
        if (values) {
          for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
      }
      translate.currentLocale = currentLocale;
      return translate;
    }

    // ---------------------------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------------------------

    function formatCount(value) {
      const number = Number(value) || 0;
      if (number < 1000) return String(Math.round(number));
      if (number < 1_000_000) return `${(number / 1000).toFixed(number < 10_000 ? 1 : 0)}K`;
      if (number < 1_000_000_000) return `${(number / 1_000_000).toFixed(number < 10_000_000 ? 1 : 0)}M`;
      return `${(number / 1_000_000_000).toFixed(number < 10_000_000_000 ? 2 : 1)}B`;
    }

    function formatInt(value) {
      return Math.round(Number(value) || 0).toLocaleString('en-US');
    }

    function formatCost(value) {
      const number = Number(value) || 0;
      if (number === 0) return '$0';
      if (number < 0.01) return `$${number.toFixed(4)}`;
      if (number < 1) return `$${number.toFixed(3)}`;
      if (number < 1000) return `$${number.toFixed(2)}`;
      return `$${number.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    }

    function formatPercent(value, digits = 1) {
      if (!Number.isFinite(value)) return '—';
      return `${(value * 100).toFixed(digits)}%`;
    }

    function formatClock(epochMs) {
      if (!epochMs) return '';
      const date = new Date(epochMs);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      const today = new Date();
      const sameDay =
        today.getFullYear() === date.getFullYear() &&
        today.getMonth() === date.getMonth() &&
        today.getDate() === date.getDate();
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      return sameDay ? clock : `${date.getMonth() + 1}-${pad(date.getDate())} ${clock}`;
    }

    function formatDuration(ms) {
      const number = Number(ms) || 0;
      if (number < 1000) return `${Math.max(1, Math.round(number))}ms`;
      return `${(number / 1000).toFixed(1)}s`;
    }

    function localDayOffset(days) {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - Math.max(0, days - 1));
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    function weekdayOf(day, locale) {
      const parts = String(day || '').split('-').map(Number);
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return '';
      const date = new Date(parts[0], parts[1] - 1, parts[2]);
      if (Number.isNaN(date.getTime())) return '';
      return locale === 'zh' ? WEEKDAYS_ZH[date.getDay()] : WEEKDAYS_EN[date.getDay()];
    }

    // ---------------------------------------------------------------------------------------
    // Data access
    // ---------------------------------------------------------------------------------------

    async function requestJson(path, options) {
      const response = await fetch(path, {
        method: options?.method || 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload;
    }

    /** [agent, model, day, input, output, cacheRead, cacheWrite, costUsd, messages, tier] */
    const CELL = { AGENT: 0, MODEL: 1, DAY: 2, INPUT: 3, OUTPUT: 4, CACHE_READ: 5, CACHE_WRITE: 6, COST: 7, MESSAGES: 8 };

    function cellTokens(cell) {
      return cell[CELL.INPUT] + cell[CELL.OUTPUT] + cell[CELL.CACHE_READ] + cell[CELL.CACHE_WRITE];
    }

    function aggregate(snapshot, filters) {
      const cells = snapshot.cells || [];
      const agentScoped = filters.agent === '' ? cells : cells.filter((cell) => cell[CELL.AGENT] === filters.agent);
      const ranged = filters.cutoff === null ? agentScoped : agentScoped.filter((cell) => cell[CELL.DAY] >= filters.cutoff);
      const scoped = filters.model === '' ? ranged : ranged.filter((cell) => cell[CELL.MODEL] === filters.model);

      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0, tokens: 0 };
      const byAgent = new Map();
      const byModel = new Map();
      const byDay = new Map();

      for (const cell of scoped) {
        const input = cell[CELL.INPUT];
        const output = cell[CELL.OUTPUT];
        const cacheRead = cell[CELL.CACHE_READ];
        const cacheWrite = cell[CELL.CACHE_WRITE];
        const cost = cell[CELL.COST];
        const messages = cell[CELL.MESSAGES];
        const tokens = input + output + cacheRead + cacheWrite;

        totals.input += input;
        totals.output += output;
        totals.cacheRead += cacheRead;
        totals.cacheWrite += cacheWrite;
        totals.cost += cost;
        totals.messages += messages;
        totals.tokens += tokens;

        const add = (map, key) => {
          let entry = map.get(key);
          if (!entry) {
            entry = { key, tokens: 0, cost: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            map.set(key, entry);
          }
          entry.tokens += tokens;
          entry.cost += cost;
          entry.messages += messages;
          entry.input += input;
          entry.output += output;
          entry.cacheRead += cacheRead;
          entry.cacheWrite += cacheWrite;
        };
        add(byAgent, cell[CELL.AGENT]);
        add(byModel, cell[CELL.MODEL]);
        add(byDay, cell[CELL.DAY]);
      }

      const agentMeta = new Map((snapshot.agents || []).map((agent) => [agent.id, agent]));
      const agentRows = [...byAgent.values()]
        .map((entry) => ({
          ...entry,
          label: agentMeta.get(entry.key)?.name || entry.key,
          color: agentMeta.get(entry.key)?.color || 'var(--dsw-alias-brand-primary)',
        }))
        .filter((row) => row.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens);
      const modelRows = [...byModel.values()]
        .map((entry) => ({ ...entry, label: entry.key }))
        .filter((row) => row.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens);
      const dayRows = [...byDay.values()].map((entry) => ({ ...entry, label: entry.key })).sort((a, b) => (a.key < b.key ? -1 : 1));
      // The trend chart needs a continuous calendar: a day without usage is a zero bar, not a
      // missing column (otherwise gaps silently compress the x-axis).
      const trendDays = fillDays(dayRows, filters.cutoff);

      return {
        totals,
        agentRows,
        modelRows,
        dayRows,
        trendDays,
        activeAgents: agentRows.length,
        activeModels: modelRows.length,
        cellsInScope: scoped.length,
      };
    }

    function dayKey(date) {
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    /** Zero-fill every calendar day from `cutoff` (or the first data day) to today / the last data day. */
    function fillDays(rows, cutoff) {
      if (rows.length === 0) return [];
      const byKey = new Map(rows.map((row) => [row.key, row]));
      const first = cutoff || rows[0].key;
      const today = dayKey(new Date());
      const last = rows[rows.length - 1].key > today ? rows[rows.length - 1].key : today;
      const [y, m, d] = first.split('-').map(Number);
      const cursor = new Date(y, m - 1, d);
      if (Number.isNaN(cursor.getTime())) return rows;
      const out = [];
      for (let guard = 0; guard < 1100; guard += 1) {
        const key = dayKey(cursor);
        if (key > last) break;
        out.push(byKey.get(key) || { key, label: key, tokens: 0, cost: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        cursor.setDate(cursor.getDate() + 1);
      }
      // Very long "all" ranges: keep the chart readable by showing the most recent ~13 months.
      return out.length > 400 ? out.slice(-400) : out;
    }

    // ---------------------------------------------------------------------------------------
    // Hooks
    // ---------------------------------------------------------------------------------------

    function useMeasuredSize() {
      const ref = useRef(null);
      const [size, setSize] = useState({ height: 0, width: 0 });
      useEffect(() => {
        const element = ref.current;
        if (!element) return undefined;
        const update = () =>
          setSize({
            height: element.clientHeight || 0,
            width: element.clientWidth || 0,
          });
        update();
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
      }, []);
      return [ref, size];
    }

    function useLocaleTick(subscribeLocale) {
      const [tick, setTick] = useState(0);
      useEffect(() => {
        if (typeof subscribeLocale !== 'function') return undefined;
        let dispose = null;
        try {
          dispose = subscribeLocale(() => setTick((value) => value + 1));
        } catch {
          dispose = null;
        }
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      }, [subscribeLocale]);
      return tick;
    }

    // ---------------------------------------------------------------------------------------
    // Atoms
    // ---------------------------------------------------------------------------------------

    function IconGauge({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', { d: 'M2.5 12.5h11' }),
        h('path', { d: 'M5 12.5V9.2' }),
        h('path', { d: 'M8 12.5V6.4' }),
        h('path', { d: 'M11 12.5V4.4' }),
      );
    }

    function IconRefresh() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 13,
          height: 13,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', { d: 'M13 7.4a5 5 0 1 0 .2 2' }),
        h('path', { d: 'M13.2 3.6v3.9H9.3' }),
      );
    }

    function IconChevron({ direction = 'right' }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', transform: direction === 'left' ? 'rotate(180deg)' : undefined },
        },
        h('path', { d: 'M6 3.5 10.5 8 6 12.5' }),
      );
    }

    function Spinner({ size = 12 }) {
      return h('span', { className: 'au-spinner', style: { width: size, height: size }, 'aria-hidden': 'true' });
    }

    function AgentUsageIcon({ size = 20 }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', { d: 'M2.6 12.6h10.8' }),
        h('rect', { x: 3.4, y: 8.4, width: 2.1, height: 4.2, rx: 0.7, fill: 'currentColor', stroke: 'none', opacity: 0.75 }),
        h('rect', { x: 6.95, y: 6.1, width: 2.1, height: 6.5, rx: 0.7, fill: 'currentColor', stroke: 'none' }),
        h('rect', { x: 10.5, y: 3.6, width: 2.1, height: 9, rx: 0.7, fill: 'currentColor', stroke: 'none', opacity: 0.6 }),
        h('path', { d: 'M2.6 7.2c1.7-1.8 4.1-2.7 6.7-2.2', opacity: 0.9 }),
        h('circle', { cx: 9.5, cy: 4.8, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      );
    }

    function KpiCard({ label, value, hint, dot }) {
      return h(
        'div',
        { className: 'au-kpi' },
        h(
          'div',
          { className: 'au-kpi-label' },
          dot ? h('span', { className: 'au-kpi-dot', style: { background: dot } }) : null,
          label,
        ),
        h('div', { className: 'au-kpi-value' }, value),
        hint ? h('div', { className: 'au-kpi-hint' }, hint) : null,
      );
    }

    function TabButton({ active, label, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': active,
          className: `au-tab${active ? ' is-active' : ''}`,
          onClick,
        },
        label,
      );
    }

    function Segmented({ value, options, onChange }) {
      return h(
        'div',
        { className: 'au-seg', role: 'group' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: `au-seg-item${value === option.value ? ' is-active' : ''}`,
              onClick: () => onChange(option.value),
              'aria-pressed': value === option.value,
            },
            option.label,
          ),
        ),
      );
    }

    function Select({ value, onChange, options, ariaLabel }) {
      return h(
        'div',
        { className: 'au-select' },
        h(
          'select',
          { value, onChange: (event) => onChange(event.target.value), 'aria-label': ariaLabel },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        ),
      );
    }

    function Pager({ page, pageCount, from, to, total, onChange, t }) {
      return h(
        'div',
        { className: 'au-pager' },
        h('span', { className: 'au-pager-label' }, t('pager.range', { from, to, total })),
        h(
          'button',
          {
            type: 'button',
            className: 'au-pager-btn',
            onClick: () => onChange(Math.max(0, page - 1)),
            disabled: page <= 0,
            title: t('pager.prev'),
            'aria-label': t('pager.prev'),
          },
          h(IconChevron, { direction: 'left' }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'au-pager-btn',
            onClick: () => onChange(Math.min(pageCount - 1, page + 1)),
            disabled: page >= pageCount - 1,
            title: t('pager.next'),
            'aria-label': t('pager.next'),
          },
          h(IconChevron, { direction: 'right' }),
        ),
      );
    }

    function Badge({ status, t }) {
      const labels = {
        ok: 'sources.status.ok',
        empty: 'sources.status.empty',
        'not-installed': 'sources.status.not-installed',
        error: 'sources.status.error',
        broken: 'sources.status.broken',
      };
      return h('span', { className: `au-badge au-badge-${status}` }, t(labels[status] || 'sources.status.error'));
    }

    // ---------------------------------------------------------------------------------------
    // Chart
    // ---------------------------------------------------------------------------------------

    const SERIES = [
      { key: 'input', legend: 'legend.input', color: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))' },
      { key: 'output', legend: 'legend.output', color: 'var(--dsw-alias-state-success-primary)' },
      { key: 'cacheRead', legend: 'legend.cacheRead', color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' },
      { key: 'cacheWrite', legend: 'legend.cacheWrite', color: 'var(--dsw-alias-state-warn-primary)' },
    ];

    /** Bottom-to-top stacking: cached tokens first, freshly generated tokens on top. */
    const STACK_ORDER = ['cacheRead', 'cacheWrite', 'input', 'output'];

    function seriesColor(key) {
      return (SERIES.find((series) => series.key === key) || {}).color || 'var(--dsw-alias-brand-primary)';
    }

    function TrendChart({ days, t }) {
      const [mode, setMode] = useState('effective');
      const [hover, setHover] = useState(-1);

      const activeSeries = useMemo(
        () => (mode === 'effective' ? SERIES.filter((series) => series.key !== 'cacheRead') : SERIES),
        [mode],
      );
      const stackOrder = mode === 'effective' ? ['input', 'cacheWrite', 'output'] : ['cacheRead', 'input', 'cacheWrite', 'output'];
      const valueOf = useCallback(
        (day) =>
          mode === 'effective'
            ? day.input + day.output + day.cacheWrite
            : day.input + day.output + day.cacheWrite + day.cacheRead,
        [mode],
      );

      if (days.length === 0) return h('div', { className: 'au-chart-empty' }, t('chart.empty'));
      const maxValue = days.reduce((max, day) => Math.max(max, valueOf(day)), 0) || 1;
      const total = days.reduce((sum, day) => sum + valueOf(day), 0);
      const average = days.length > 0 ? total / days.length : 0;
      const labelStep = Math.max(1, Math.ceil(days.length / 10));
      const hovered = hover >= 0 && hover < days.length ? days[hover] : null;

      return h(
        'div',
        { className: 'au-chart' },
        h(
          'div',
          { className: 'au-chart-head' },
          h('div', { className: 'au-chart-title' }, t('chart.title')),
          h(
            'div',
            { className: 'au-chart-total' },
            `${mode === 'effective' ? t('chart.effectiveTotal', { tokens: formatCount(total) }) : t('chart.total', { tokens: formatCount(total) })} · ${t('chart.avg', { tokens: formatCount(average) })}`,
          ),
          h(
            'div',
            { className: 'au-chart-mode' },
            h(
              'button',
              {
                type: 'button',
                className: `au-chart-mode-btn${mode === 'effective' ? ' is-active' : ''}`,
                onClick: () => setMode('effective'),
              },
              t('chart.modeEffective'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `au-chart-mode-btn${mode === 'full' ? ' is-active' : ''}`,
                onClick: () => setMode('full'),
              },
              t('chart.modeFull'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'au-chart-legend' },
          activeSeries.map((series) =>
            h(
              'span',
              { key: series.key, className: 'au-legend-item' },
              h('span', { className: 'au-legend-dot', style: { background: series.color } }),
              t(series.legend),
            ),
          ),
        ),
        h(
          'div',
          { className: 'au-chart-plot' },
          h('div', { className: 'au-grid-line au-grid-line-1' }),
          h('div', { className: 'au-grid-line au-grid-line-2' }),
          h('div', { className: 'au-grid-line au-grid-line-3' }),
          h('div', { className: 'au-chart-scale' }, formatCount(maxValue)),
          average > 0
            ? h('div', {
                className: 'au-chart-avg',
                style: { top: `${Math.max(2, Math.min(98, Math.round((1 - average / maxValue) * 100)))}%` },
              })
            : null,
          h(
            'div',
            { className: 'au-chart-bars' },
            days.map((day, index) =>
              h(
                'div',
                {
                  key: day.day,
                  className: `au-chart-col${hover === index ? ' is-hover' : ''}`,
                  onMouseEnter: () => setHover(index),
                  onMouseLeave: () => setHover(-1),
                },
                h(
                  'div',
                  { className: 'au-chart-bar', style: { height: `${Math.max(2, Math.round((valueOf(day) / maxValue) * 100))}%` } },
                  stackOrder.map((key) =>
                    day[key] > 0
                      ? h('span', { key, className: 'au-chart-seg', style: { flexGrow: day[key], background: seriesColor(key) } })
                      : null,
                  ),
                ),
              ),
            ),
          ),
          hovered
            ? h(
                'div',
                {
                  className: 'au-chart-tip',
                  style: { left: `${Math.max(7, Math.min(93, ((hover + 0.5) / days.length) * 100))}%` },
                },
                h('div', { className: 'au-chart-tip-day' }, hovered.day),
                activeSeries
                  .slice()
                  .filter((series) => hovered[series.key] > 0)
                  .map((series) =>
                    h(
                      'div',
                      { key: series.key, className: 'au-chart-tip-row' },
                      h('span', { className: 'au-legend-dot', style: { background: series.color } }),
                      h('span', { className: 'au-chart-tip-name' }, t(series.legend)),
                      h('span', { className: 'au-chart-tip-value' }, formatCount(hovered[series.key])),
                    ),
                  ),
                h(
                  'div',
                  { className: 'au-chart-tip-row au-chart-tip-total' },
                  h('span', null, mode === 'effective' ? t('chart.modeEffective') : t('chart.modeFull')),
                  h('span', { className: 'au-chart-tip-value' }, formatCount(valueOf(hovered))),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'au-chart-axis' },
          days.map((day, index) =>
            h('span', { key: day.day, className: 'au-chart-tick' }, index % labelStep === 0 ? h('span', null, day.day.slice(5)) : null),
          ),
        ),
      );
    }

    function RankList({ rows, t, colorFor }) {
      if (rows.length === 0) return h('div', { className: 'au-chart-empty' }, t('state.noMatch'));
      const max = Math.max(...rows.map((row) => row.tokens), 1);
      return h(
        'div',
        { className: 'au-rank' },
        rows.map((row) =>
          h(
            'div',
            { className: 'au-rank-row', key: row.key, title: `${row.label} · ${formatInt(row.tokens)} tokens · ${formatCost(row.cost)}` },
            h(
              'div',
              { className: 'au-rank-top' },
              h(
                'span',
                { className: 'au-rank-name' },
                h('span', { className: 'au-rank-dot', style: { background: colorFor(row) } }),
                h('span', { className: 'au-ellipsis' }, row.label),
              ),
              h('span', { className: 'au-rank-value' }, formatCount(row.tokens)),
            ),
            h(
              'div',
              { className: 'au-rank-track' },
              h('div', {
                className: 'au-rank-fill',
                style: { width: `${Math.max(3, Math.round((row.tokens / max) * 100))}%`, background: colorFor(row) },
              }),
            ),
            h('div', { className: 'au-rank-sub' }, formatCost(row.cost)),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Tabs
    // ---------------------------------------------------------------------------------------

    function TrendTab({ data, t }) {
      const [agentsRef, agentsSize] = useMeasuredSize();
      const [modelsRef, modelsSize] = useMeasuredSize();
      const agentRowsToShow = Math.max(2, agentsSize.height ? Math.floor((agentsSize.height - 24) / 42) : 4);
      const modelRowsToShow = Math.max(2, modelsSize.height ? Math.floor((modelsSize.height - 24) / 42) : 4);

      return h(
        'div',
        { className: 'au-trend-grid' },
        h(
          'div',
          { className: 'au-card au-trend-card' },
          h(TrendChart, {
            days: data.trendDays.map((row) => ({
              day: row.key,
              input: row.input,
              output: row.output,
              cacheRead: row.cacheRead,
              cacheWrite: row.cacheWrite,
              total: row.tokens,
            })),
            t,
          }),
        ),
        h(
          'div',
          { className: 'au-rank-col' },
          h(
            'div',
            { className: 'au-card au-rank-card' },
            h(
              'div',
              { className: 'au-card-head' },
              h('div', { className: 'au-card-title' }, t('rank.agents')),
              h('div', { className: 'au-card-meta' }, data.agentRows.length),
            ),
            h(
              'div',
              { className: 'au-rank-body', ref: agentsRef },
              h(RankList, { rows: data.agentRows.slice(0, agentRowsToShow), t, colorFor: (row) => row.color }),
            ),
          ),
          h(
            'div',
            { className: 'au-card au-rank-card' },
            h(
              'div',
              { className: 'au-card-head' },
              h('div', { className: 'au-card-title' }, t('rank.models')),
              h('div', { className: 'au-card-meta' }, data.modelRows.length),
            ),
            h(
              'div',
              { className: 'au-rank-body', ref: modelsRef },
              h(RankList, {
                rows: data.modelRows.slice(0, modelRowsToShow),
                t,
                colorFor: () => 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))',
              }),
            ),
          ),
        ),
      );
    }

    function TableTab({ rows, kind, t, locale }) {
      const [fillRef, fillSize] = useMeasuredSize();
      const [page, setPage] = useState(0);
      const rowHeight = 32;
      const rowsPerPage = Math.max(3, fillSize.height ? Math.floor((fillSize.height - 31) / rowHeight) : 7);
      const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
      const safePage = Math.min(page, pageCount - 1);

      useEffect(() => {
        if (page > pageCount - 1) setPage(pageCount - 1);
      }, [page, pageCount]);

      const start = safePage * rowsPerPage;
      const visible = rows.slice(start, start + rowsPerPage);
      const total = rows.reduce((sum, row) => sum + row.tokens, 0) || 1;
      const nameLabel = kind === 'date' ? t('tab.date') : kind === 'model' ? t('filter.model') : t('filter.agent');

      return h(
        'div',
        { className: 'au-card au-table-card' },
        h(
          'div',
          { className: 'au-card-head' },
          h(
            'div',
            { className: 'au-card-title' },
            kind === 'date' ? t('tab.date') : kind === 'model' ? t('tab.model') : t('tab.agent'),
            h('span', { className: 'au-card-meta' }, rows.length),
          ),
          h(Pager, {
            page: safePage,
            pageCount,
            from: rows.length === 0 ? 0 : start + 1,
            to: Math.min(rows.length, start + visible.length),
            total: rows.length,
            onChange: setPage,
            t,
          }),
        ),
        h(
          'div',
          { className: 'au-tablefill', ref: fillRef },
          h(
            'table',
            { className: 'au-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { className: 'au-th' }, nameLabel),
                h('th', { className: 'au-th au-num' }, t('table.col.total')),
                h('th', { className: 'au-th au-num au-detail' }, t('table.col.input')),
                h('th', { className: 'au-th au-num au-detail' }, t('table.col.output')),
                h('th', { className: 'au-th au-num au-detail' }, t('table.col.cacheRead')),
                h('th', { className: 'au-th au-num au-detail' }, t('table.col.cacheWrite')),
                h('th', { className: 'au-th au-num' }, t('table.col.messages')),
                h('th', { className: 'au-th au-num' }, t('table.col.cost')),
                h('th', { className: 'au-th au-sharehead' }, t('table.col.share')),
              ),
            ),
            h(
              'tbody',
              null,
              visible.length === 0
                ? h(
                    'tr',
                    null,
                    h('td', { className: 'au-td au-empty-cell', colSpan: 9 }, rows.length === 0 ? t('table.empty') : t('state.noMatch')),
                  )
                : visible.map((row) =>
                    h(
                      'tr',
                      { className: 'au-tr', key: row.key },
                      h(
                        'td',
                        { className: 'au-td au-namecell' },
                        kind === 'agent'
                          ? h(
                              'span',
                              { className: 'au-name' },
                              h('span', { className: 'au-dot', style: { background: row.color } }),
                              h('span', { className: 'au-ellipsis' }, row.label),
                            )
                          : h(
                              'span',
                              { className: 'au-name' },
                              h('span', { className: 'au-mono au-ellipsis' }, row.label),
                              kind === 'date' ? h('span', { className: 'au-weekday' }, weekdayOf(row.label, locale)) : null,
                            ),
                      ),
                      h('td', { className: 'au-td au-num au-strong' }, formatInt(row.tokens)),
                      h('td', { className: 'au-td au-num au-detail' }, formatInt(row.input)),
                      h('td', { className: 'au-td au-num au-detail' }, formatInt(row.output)),
                      h('td', { className: 'au-td au-num au-detail' }, formatInt(row.cacheRead)),
                      h('td', { className: 'au-td au-num au-detail' }, formatInt(row.cacheWrite)),
                      h('td', { className: 'au-td au-num' }, formatInt(row.messages)),
                      h('td', { className: 'au-td au-num' }, formatCost(row.cost)),
                      h(
                        'td',
                        { className: 'au-td au-share' },
                        h(
                          'span',
                          { className: 'au-share-track' },
                          h('span', {
                            className: 'au-share-fill',
                            style: { width: `${Math.max(1, Math.round((row.tokens / total) * 100))}%` },
                          }),
                        ),
                        h('span', { className: 'au-share-text' }, formatPercent(row.tokens / total, 0)),
                      ),
                    ),
                  ),
            ),
          ),
        ),
      );
    }

    const STATUS_ORDER = { ok: 0, empty: 1, error: 2, broken: 3, 'not-installed': 4 };

    function SourcesTab({ agents, t }) {
      const [fillRef, fillSize] = useMeasuredSize();
      const [page, setPage] = useState(0);
      const cardHeight = 64;
      const perColumn = Math.max(1, fillSize.height ? Math.floor((fillSize.height + 8) / (cardHeight + 8)) : 4);
      const pageSize = Math.max(2, perColumn * 2);
      const sorted = [...(agents || [])].sort(
        (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.tokens - a.tokens || a.name.localeCompare(b.name),
      );
      const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
      const safePage = Math.min(page, pageCount - 1);

      useEffect(() => {
        if (page > pageCount - 1) setPage(pageCount - 1);
      }, [page, pageCount]);

      const start = safePage * pageSize;
      const visible = sorted.slice(start, start + pageSize);

      return h(
        'div',
        { className: 'au-card au-sources-card' },
        h(
          'div',
          { className: 'au-card-head' },
          h(
            'div',
            { className: 'au-card-title' },
            t('sources.title'),
            h(
              'span',
              { className: 'au-card-meta' },
              t('sources.count', {
                readable: sorted.filter((agent) => agent.status === 'ok').length,
                total: sorted.length,
              }),
            ),
          ),
          h(Pager, {
            page: safePage,
            pageCount,
            from: sorted.length === 0 ? 0 : start + 1,
            to: Math.min(sorted.length, start + visible.length),
            total: sorted.length,
            onChange: setPage,
            t,
          }),
        ),
        h(
          'div',
          { className: 'au-sources-grid', ref: fillRef },
          visible.map((agent) => {
            const existing = (agent.sources || []).find((source) => source.exists);
            return h(
              'div',
              { className: `au-source${agent.status === 'ok' ? '' : ' is-muted'}`, key: agent.id },
              h(
                'div',
                { className: 'au-source-top' },
                h('span', { className: 'au-dot', style: { background: agent.color || 'var(--dsw-alias-label-tertiary)' } }),
                h('span', { className: 'au-source-name au-ellipsis' }, agent.name),
                h(Badge, { status: agent.status, t }),
              ),
              h(
                'div',
                { className: 'au-source-sub' },
                h(
                  'code',
                  { className: 'au-source-path au-ellipsis', title: existing?.path || agent.sources?.[0]?.path || '' },
                  existing?.path || agent.sources?.[0]?.path || agent.id,
                ),
              ),
              h(
                'div',
                { className: 'au-source-foot' },
                h('span', { className: 'au-source-stat' }, formatCount(agent.tokens)),
                h('span', { className: 'au-source-stat' }, formatCost(agent.costUsd)),
                h('span', { className: 'au-source-files' }, t('sources.files', { files: agent.files || 0 })),
                agent.warnings?.length
                  ? h('span', { className: 'au-source-warn', title: agent.warnings[0] }, t('sources.warn'))
                  : null,
              ),
            );
          }),
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------------------------

    const RANGES = [
      { value: '7', key: 'range.7' },
      { value: '30', key: 'range.30' },
      { value: '90', key: 'range.90' },
      { value: 'all', key: 'range.all' },
    ];

    const TABS = [
      { id: 'trend', key: 'tab.trend' },
      { id: 'agent', key: 'tab.agent' },
      { id: 'model', key: 'tab.model' },
      { id: 'date', key: 'tab.date' },
      { id: 'sources', key: 'tab.sources' },
    ];

    function AgentUsagePage({ t, subscribeLocale }) {
      const localeTick = useLocaleTick(subscribeLocale);

      const [loading, setLoading] = useState(true);
      const [scanning, setScanning] = useState(false);
      const [snapshot, setSnapshot] = useState(null);
      const [error, setError] = useState(null);
      const [dataDir, setDataDir] = useState('');
      const [range, setRange] = useState('30');
      const [agentFilter, setAgentFilter] = useState('');
      const [modelFilter, setModelFilter] = useState('');
      const [tab, setTab] = useState('trend');
      const mountedRef = useRef(true);
      const [rootRef, rootSize] = useMeasuredSize();

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const runScanRef = useRef(null);
      const loadSnapshot = useCallback(() => {
        setLoading(true);
        setError(null);
        requestJson(API.snapshot)
          .then((payload) => {
            if (!mountedRef.current) return;
            setSnapshot(payload.snapshot || null);
            setDataDir(payload.dataDir || '');
            setLoading(false);
            // A scan started elsewhere (another window, an earlier visit) is still running: join it
            // (the Host shares one scan between callers) so this page gets its result and its
            // refresh button comes back.
            if (payload.scanning) runScanRef.current?.();
          })
          .catch((requestError) => {
            if (!mountedRef.current) return;
            setError(requestError.message || String(requestError));
            setLoading(false);
          });
      }, []);

      useEffect(() => {
        loadSnapshot();
      }, [loadSnapshot]);

      const runScan = useCallback(() => {
        setScanning(true);
        setError(null);
        requestJson(API.scan, { method: 'POST' })
          .then((payload) => {
            if (!mountedRef.current) return;
            setSnapshot(payload.snapshot || null);
            setDataDir(payload.dataDir || '');
            setScanning(false);
          })
          .catch((scanError) => {
            if (!mountedRef.current) return;
            setError(scanError.message || String(scanError));
            setScanning(false);
          });
      }, []);
      runScanRef.current = runScan;

      const cutoff = range === 'all' ? null : localDayOffset(Number(range));
      const filters = useMemo(() => ({ agent: agentFilter, model: modelFilter, cutoff }), [agentFilter, modelFilter, cutoff]);
      const snapshotSafe = snapshot || { cells: [], agents: [] };
      const data = useMemo(() => aggregate(snapshotSafe, filters), [snapshotSafe, filters]);
      const locale = typeof t.currentLocale === 'function' ? t.currentLocale() : 'zh';

      const agentOptions = useMemo(() => {
        const meta = new Map((snapshotSafe.agents || []).map((agent) => [agent.id, agent]));
        const ids = new Set((snapshotSafe.cells || []).map((cell) => cell[CELL.AGENT]));
        return [
          { value: '', label: t('filter.allAgents') },
          ...[...ids]
            .map((id) => ({ value: id, label: meta.get(id)?.name || id }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        ];
      }, [snapshotSafe, t, localeTick]);

      const modelOptions = useMemo(() => {
        const scoped =
          agentFilter === ''
            ? snapshotSafe.cells || []
            : (snapshotSafe.cells || []).filter((cell) => cell[CELL.AGENT] === agentFilter);
        const ids = [...new Set(scoped.map((cell) => cell[CELL.MODEL]))].sort();
        return [{ value: '', label: t('filter.allModels') }, ...ids.map((id) => ({ value: id, label: id }))];
      }, [snapshotSafe, agentFilter, t, localeTick]);

      useEffect(() => {
        if (modelFilter !== '' && !modelOptions.some((option) => option.value === modelFilter)) setModelFilter('');
      }, [modelOptions, modelFilter]);

      const totals = data.totals;
      const cacheHit = totals.input + totals.cacheRead > 0 ? totals.cacheRead / (totals.input + totals.cacheRead) : NaN;
      const hasData = (snapshot?.cells || []).length > 0;
      const isShort = rootSize.height > 0 && rootSize.height < 520;
      const isNarrow = rootSize.width > 0 && rootSize.width < 900;

      const staleNotice = error && snapshot ? error : null;
      const fatalError = error && !snapshot ? error : null;

      return h(
        'div',
        { className: `au-root${isShort ? ' is-short' : ''}${isNarrow ? ' is-narrow' : ''}`, ref: rootRef },
        h('style', null, CSS),
        h(
          'div',
          { className: 'au-panel' },
          h(
            'div',
            { className: 'au-header', 'data-window-drag': true },
            h(
              'div',
              { className: 'au-brand' },
              h('span', { className: 'au-brand-icon' }, h(IconGauge, { size: 15 })),
              h(
                'div',
                { className: 'au-brand-text' },
                h('div', { className: 'au-title' }, t('page.title')),
                h('div', { className: 'au-subtitle' }, t('page.subtitle')),
              ),
            ),
            h(
              'div',
              { className: 'au-header-right' },
              h(
                'div',
                { className: 'au-scan-meta' },
                h(
                  'div',
                  { className: 'au-scan-line' },
                  snapshot?.scannedAt ? t('scan.at', { time: formatClock(snapshot.scannedAt) }) : t('scan.never'),
                ),
                snapshot?.scannedAt
                  ? h(
                      'div',
                      { className: 'au-scan-sub' },
                      t('scan.meta', { units: snapshot.cells.length, duration: formatDuration(snapshot.durationMs) }),
                    )
                  : h('div', { className: 'au-scan-sub' }, t('scan.manual')),
              ),
              h(
                'button',
                { type: 'button', className: 'au-btn au-btn-primary', onClick: runScan, disabled: scanning },
                scanning ? h(Spinner, { size: 11 }) : h(IconRefresh),
                h('span', null, scanning ? t('action.refreshing') : t('action.refresh')),
              ),
            ),
          ),
          h(
            'div',
            { className: 'au-kpis' },
            h(KpiCard, {
              label: t('kpi.totalTokens'),
              value: formatCount(totals.input + totals.output + totals.cacheWrite),
              hint: t('kpi.effectiveHint', { total: formatCount(totals.tokens), read: formatCount(totals.cacheRead) }),
              dot: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))',
            }),
            h(KpiCard, {
              label: t('kpi.cost'),
              value: formatCost(totals.cost),
              hint: t('kpi.costHint'),
              dot: 'var(--dsw-alias-state-success-primary)',
            }),
            h(KpiCard, {
              label: t('kpi.cacheHit'),
              value: Number.isNaN(cacheHit) ? '—' : formatPercent(cacheHit),
              hint: t('kpi.cacheHint', { read: formatCount(totals.cacheRead), write: formatCount(totals.cacheWrite) }),
              dot: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
            }),
            h(KpiCard, {
              label: t('kpi.messages'),
              value: formatCount(totals.messages),
              hint: t('kpi.messageHint', { agents: data.activeAgents, models: data.activeModels }),
              dot: 'var(--dsw-alias-state-warn-primary)',
            }),
          ),
          h(
            'div',
            { className: 'au-toolbar' },
            h(
              'div',
              { className: 'au-tabs', role: 'tablist' },
              TABS.map((item) =>
                h(TabButton, { key: item.id, active: tab === item.id, label: t(item.key), onClick: () => setTab(item.id) }),
              ),
            ),
            h(
              'div',
              { className: 'au-filters' },
              tab !== 'sources'
                ? h(Segmented, {
                    value: range,
                    options: RANGES.map((option) => ({ value: option.value, label: t(option.key) })),
                    onChange: setRange,
                  })
                : null,
              tab !== 'sources'
                ? h(Select, { value: agentFilter, onChange: setAgentFilter, options: agentOptions, ariaLabel: t('filter.agent') })
                : null,
              tab !== 'sources'
                ? h(Select, { value: modelFilter, onChange: setModelFilter, options: modelOptions, ariaLabel: t('filter.model') })
                : null,
            ),
          ),
          scanning ? h('div', { className: 'au-progress' }) : null,
          h(
            'div',
            { className: 'au-content' },
            loading && !hasData && !fatalError
              ? h('div', { className: 'au-state' }, h(Spinner, { size: 14 }), h('span', null, t('state.loading')))
              : fatalError
                ? h(
                    'div',
                    { className: 'au-state au-state-error' },
                    h('div', { className: 'au-state-title' }, t('state.error.title')),
                    h('div', { className: 'au-state-body' }, fatalError),
                    h('button', { type: 'button', className: 'au-btn', onClick: loadSnapshot }, t('action.retry')),
                  )
                : !hasData
                  ? h(
                      'div',
                      { className: 'au-state au-state-empty' },
                      h('span', { className: 'au-brand-icon' }, h(IconGauge, { size: 16 })),
                      h('div', { className: 'au-state-title' }, t('state.empty.title')),
                      h('div', { className: 'au-state-body' }, t('state.empty.body')),
                      h(
                        'button',
                        { type: 'button', className: 'au-btn au-btn-primary', onClick: runScan, disabled: scanning },
                        scanning ? h(Spinner, { size: 11 }) : h(IconRefresh),
                        h('span', null, scanning ? t('action.refreshing') : t('action.scanNow')),
                      ),
                      h('div', { className: 'au-state-hint' }, t('state.empty.supported')),
                    )
                  : h(
                      React.Fragment,
                      null,
                      staleNotice
                        ? h(
                            'div',
                            { className: 'au-inline-error' },
                            h('span', { className: 'au-ellipsis' }, staleNotice),
                            h('button', { type: 'button', className: 'au-linkbtn', onClick: runScan }, t('action.retry')),
                          )
                        : null,
                      h(
                        'div',
                        { className: 'au-tabbody' },
                        tab === 'trend'
                          ? h(TrendTab, { data, t })
                          : tab === 'agent'
                            ? h(TableTab, { key: 'agent', rows: data.agentRows, kind: 'agent', t, locale })
                            : tab === 'model'
                              ? h(TableTab, { key: 'model', rows: data.modelRows, kind: 'model', t, locale })
                              : tab === 'date'
                                ? h(TableTab, { key: 'date', rows: data.dayRows, kind: 'date', t, locale })
                                : h(SourcesTab, { agents: snapshot.agents, t }),
                      ),
                    ),
          ),
          h(
            'div',
            { className: 'au-footline' },
            h('span', { className: 'au-foot-left au-ellipsis' }, t('footer.dir', { dir: dataDir || '~/.dsh/agent-usage' })),
            h('span', {
              className: `au-foot-right${snapshot?.pricing?.invalid?.length ? ' is-warn' : ''}`,
              title: snapshot?.pricing ? [
                t('footer.pricingHint'),
                snapshot.pricing.overrides?.length ? `${t('footer.overrides')}: ${snapshot.pricing.overrides.join(', ')}` : '',
                snapshot.pricing.invalid?.length ? `${t('footer.invalid')}: ${snapshot.pricing.invalid.join(', ')}` : '',
                snapshot.unpricedModels?.length ? `${t('footer.unpriced')}: ${snapshot.unpricedModels.join(', ')}` : '',
              ].filter(Boolean).join('\n') : undefined,
            },
              t('footer.pricing', { version: snapshot?.pricing?.version ?? snapshot?.pricingVersion ?? '—' }),
              snapshot?.pricing?.fetched ? ` · ${snapshot.pricing.fetched}` : '',
              snapshot?.pricing?.overrides?.length ? ` · ${t('footer.overrideCount', { n: snapshot.pricing.overrides.length })}` : '',
              snapshot?.pricing?.invalid?.length ? ` · ${t('footer.invalidCount', { n: snapshot.pricing.invalid.length })}` : ''),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Styles — DSH design tokens, one-screen / scroll-free
    // ---------------------------------------------------------------------------------------

    const CSS = `
.au-root { height: 100%; min-height: 0; overflow: hidden; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
.au-root *, .au-root *::before, .au-root *::after { box-sizing: border-box; }
.au-root ::-webkit-scrollbar { width: 0; height: 0; }
.au-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 9px; }
.au-header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 32px; }
html[data-platform=darwin] .au-panel { padding-top: 6px; }
html[data-platform=darwin] .au-header { min-height: max(40px, calc(var(--dsh-frame-top-clearance, 0px) - 6px));
  padding-left: max(0px, calc(var(--dsh-frame-leading-clearance, 0px) - 8px)); }
.au-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.au-brand-icon { width: 27px; height: 27px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 12%, transparent); }
.au-brand-text { min-width: 0; }
.au-title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; }
.au-subtitle { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46vw; }
.au-header-right { display: flex; align-items: center; gap: 12px; flex: none; }
.au-scan-meta { text-align: right; font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.4; white-space: nowrap; }
.au-scan-sub { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10.5px; }
.au-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary);
  border-radius: 8px; padding: 5px 11px; font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease; }
.au-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.au-btn:disabled { opacity: .6; cursor: default; }
.au-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.au-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); filter: brightness(1.06); }
.au-spinner { display: inline-block; border: 1.6px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: au-spin .8s linear infinite; flex: none; }
@keyframes au-spin { to { transform: rotate(360deg); } }
.au-kpis { flex: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.au-kpi { min-width: 0; padding: 7px 12px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.au-kpi-label { display: flex; align-items: center; gap: 5px; font-size: 10.5px; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.au-kpi-dot { width: 6px; height: 6px; border-radius: 2px; flex: none; }
.au-kpi-value { font-size: 19px; font-weight: 650; line-height: 1.2; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin-top: 1px; }
.au-kpi-hint { font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.au-toolbar { flex: none; display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); min-height: 31px; }
.au-tabs { display: flex; gap: 2px; min-width: 0; }
.au-tab { border: 0; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12.5px; font-family: inherit; padding: 5px 11px 7px; cursor: pointer; white-space: nowrap; transition: color .12s ease, background .12s ease; }
.au-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.au-tab.is-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); font-weight: 600; }
.au-filters { display: flex; align-items: center; gap: 6px; padding-bottom: 4px; flex-wrap: nowrap; }
.au-seg { display: inline-flex; padding: 2px; gap: 1px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.au-seg-item { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 11.5px; padding: 3px 8px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
.au-seg-item:hover { color: var(--dsw-alias-label-primary); }
.au-seg-item.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.au-select select { appearance: none; max-width: 168px; min-width: 92px; height: 28px; padding: 0 24px 0 9px; border-radius: 7px; font-family: inherit; font-size: 11.5px;
  color: var(--dsw-alias-label-primary); background-color: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2)); border: 1px solid var(--dsw-alias-border-l2); cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--dsw-alias-label-secondary) 50%), linear-gradient(135deg, var(--dsw-alias-label-secondary) 50%, transparent 50%);
  background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%; background-size: 4px 4px, 4px 4px; background-repeat: no-repeat; }
.au-select select:hover { background-color: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.au-select select:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.au-progress { flex: none; height: 2px; margin-top: -6px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); position: relative; }
.au-progress::after { content: ""; position: absolute; inset: 0; width: 34%; border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)), transparent);
  animation: au-slide 1.1s ease-in-out infinite; }
@keyframes au-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(320%); } }
.au-content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
.au-inline-error { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 10px; border-radius: 8px; font-size: 11.5px;
  color: var(--dsw-alias-state-error-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.au-linkbtn { border: 0; background: transparent; color: inherit; font-family: inherit; font-size: inherit; text-decoration: underline; cursor: pointer; padding: 0 2px; flex: none; }
.au-tabbody { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.au-trend-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.72fr) minmax(0, 1fr); gap: 8px; overflow: hidden; }
.au-rank-col { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.au-card { min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 9px 12px 10px; overflow: hidden; }
.au-card-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 22px; margin-bottom: 5px; }
.au-card-title { display: flex; align-items: baseline; gap: 7px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.au-card-meta { font-size: 10.5px; font-weight: 500; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.au-trend-card { padding-bottom: 5px; }
.au-chart { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.au-chart-head { flex: none; display: flex; align-items: center; gap: 8px; white-space: nowrap; min-height: 21px; }
.au-chart-title { font-size: 12px; font-weight: 600; white-space: nowrap; }
.au-chart-total { font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.au-chart-mode { margin-left: auto; display: inline-flex; padding: 1px; gap: 1px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); flex: none; }
.au-chart-mode-btn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 10px; padding: 2px 7px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
.au-chart-mode-btn:hover { color: var(--dsw-alias-label-primary); }
.au-chart-mode-btn.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.au-chart-legend { flex: none; display: flex; align-items: center; gap: 12px; padding: 2px 0 3px; }
.au-legend-item { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.au-legend-dot { width: 7px; height: 7px; border-radius: 2px; display: inline-block; flex: none; }
.au-chart-plot { flex: 1 1 auto; min-height: 0; position: relative; padding-top: 6px; }
.au-chart-scale { position: absolute; top: 0; left: 1px; font-size: 9px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); opacity: .75; font-variant-numeric: tabular-nums; pointer-events: none; }
.au-chart-avg { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); opacity: .45; pointer-events: none; }
.au-grid-line { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--dsw-alias-border-l1); opacity: .65; }
.au-grid-line-1 { top: 25%; }
.au-grid-line-2 { top: 50%; }
.au-grid-line-3 { top: 75%; }
.au-chart-bars { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 2px; }
.au-chart-col { flex: 1 1 0; min-width: 2px; height: 100%; display: flex; align-items: flex-end; justify-content: center; border-radius: 4px 4px 0 0; }
.au-chart-col:hover, .au-chart-col.is-hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.au-chart-tip { position: absolute; top: 0; transform: translateX(-50%); z-index: 3; pointer-events: none; min-width: 112px;
  padding: 6px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  box-shadow: 0 4px 14px rgba(0,0,0,.16); }
.au-chart-tip-day { font-size: 10px; font-weight: 600; margin-bottom: 3px; white-space: nowrap; }
.au-chart-tip-row { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; line-height: 1.55; }
.au-chart-tip-name { flex: 1 1 auto; }
.au-chart-tip-value { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.au-chart-tip-total { margin-top: 3px; padding-top: 3px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); font-weight: 600; }
.au-chart-bar { width: 100%; max-width: 26px; min-height: 2px; display: flex; flex-direction: column-reverse; border-radius: 3px 3px 1px 1px; overflow: hidden; }
.au-chart-seg { display: block; width: 100%; min-height: 1px; }
.au-chart-axis { flex: none; display: flex; gap: 2px; margin-top: 3px; }
.au-chart-axis { position: relative; height: 13px; }
.au-chart-tick { flex: 1 1 0; min-width: 2px; position: relative; font-size: 9px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.au-chart-tick > span { position: absolute; left: 50%; top: 0; transform: translateX(-50%); white-space: nowrap; font-variant-numeric: tabular-nums; }
.au-chart-tick:first-child > span { left: 0; transform: none; }
.au-chart-empty { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.au-rank-card { flex: 1 1 0; min-height: 0; }
.au-rank-body { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.au-rank { display: flex; flex-direction: column; gap: 7px; }
.au-rank-row { display: flex; flex-direction: column; gap: 3px; }
.au-rank-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
.au-rank-name { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 11.5px; }
.au-rank-dot { width: 6px; height: 6px; border-radius: 2px; flex: none; }
.au-rank-value { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.au-rank-track { height: 4px; border-radius: 99px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.au-rank-fill { height: 100%; border-radius: 99px; }
.au-rank-sub { font-size: 9.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.au-table-card { flex: 1 1 auto; min-height: 0; padding-bottom: 6px; }
.au-tablefill { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.au-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11.5px; }
.au-th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); font-size: 10.5px; letter-spacing: .02em; padding: 4px 8px 5px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.au-th:first-child, .au-td:first-child { padding-left: 2px; }
.au-th.au-num, .au-td.au-num { text-align: right; font-variant-numeric: tabular-nums; }
.au-th.au-sharehead { text-align: right; width: 112px; }
.au-tr:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.au-td { padding: 0 8px; height: 31px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.au-td.au-strong { font-weight: 600; }
.au-td.au-namecell { max-width: 220px; }
.au-td.au-empty-cell { text-align: center; color: var(--dsw-alias-label-secondary); border-bottom: 0; }
.au-name { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; vertical-align: middle; }
.au-name .au-ellipsis { min-width: 0; }
.au-dot { width: 7px; height: 7px; border-radius: 2px; flex: none; display: inline-block; }
.au-mono { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
.au-weekday { font-size: 9.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); margin-left: 5px; }
.au-share { display: flex; align-items: center; justify-content: flex-end; gap: 7px; }
.au-share-track { width: 50px; height: 4px; flex: none; border-radius: 99px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.au-share-fill { display: block; height: 100%; border-radius: 99px; background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); opacity: .8; }
.au-share-text { font-size: 10px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; min-width: 26px; text-align: right; }
.au-pager { display: flex; align-items: center; gap: 6px; flex: none; }
.au-pager-label { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; white-space: nowrap; }
.au-pager-btn { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0; }
.au-pager-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.au-pager-btn:disabled { opacity: .35; cursor: default; }
.au-sources-card { flex: 1 1 auto; min-height: 0; }
.au-sources-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: 64px; gap: 8px; overflow: hidden; align-content: start; }
.au-source { min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); }
.au-source.is-muted { opacity: .72; }
.au-source-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.au-source-name { font-size: 11.5px; font-weight: 600; min-width: 0; }
.au-source-top .au-badge { margin-left: auto; }
.au-source-sub { min-width: 0; }
.au-source-path { display: block; min-width: 0; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 9.5px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.au-source-foot { display: flex; align-items: baseline; gap: 8px; font-size: 10px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.au-source-files { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.au-source-warn { margin-left: auto; color: var(--dsw-alias-state-warn-primary); cursor: help; }
.au-badge { flex: none; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 0 7px; font-size: 9.5px; line-height: 1.7; white-space: nowrap; }
.au-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.au-badge-empty { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
.au-badge-error, .au-badge-broken { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.au-state { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; padding: 16px; text-align: center; }
.au-state-title { font-size: 14px; font-weight: 600; }
.au-state-body { font-size: 11.5px; color: var(--dsw-alias-label-secondary); max-width: 520px; line-height: 1.55; }
.au-state-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); max-width: 620px; line-height: 1.5; }
.au-state-empty .au-brand-icon { width: 34px; height: 34px; border-radius: 10px; }
.au-state-error { color: var(--dsw-alias-state-error-primary); }
.au-state-error .au-btn { color: var(--dsw-alias-label-primary); }
.au-footline { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 9.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); opacity: .82; min-height: 11px; }
.au-foot-left { min-width: 0; }
.au-foot-right { flex: none; white-space: nowrap; }
.au-foot-right.is-warn { color: var(--dsw-alias-state-warn-primary, #9a6700); }
.au-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.au-root.is-short .au-subtitle, .au-root.is-short .au-kpi-hint, .au-root.is-short .au-state-hint { display: none; }
.au-root.is-short .au-panel { padding: 8px 12px 7px; gap: 6px; }
.au-root.is-short .au-kpi { padding: 5px 10px; }
.au-root.is-short .au-kpi-value { font-size: 16px; }
.au-root.is-narrow .au-subtitle, .au-root.is-narrow .au-scan-sub { display: none; }
.au-root.is-narrow .au-filters .au-select select { max-width: 118px; min-width: 76px; }
.au-root.is-narrow .au-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 980px) {
  .au-detail { display: none; }
  .au-trend-grid { grid-template-columns: minmax(0, 1fr); }
  .au-rank-col { display: none; }
  .au-sources-grid { grid-template-columns: minmax(0, 1fr); }
}
`;

    // ---------------------------------------------------------------------------------------
    // Mount
    // ---------------------------------------------------------------------------------------

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      try {
        ctx.locale.register(NS, { zh, en });
      } catch {
        // Locale service optional at mount time; our own dictionaries still work.
      }
      const t = makeTranslate(ctx);
      const subscribeLocale = (listener) => {
        try {
          return ctx.locale.subscribe(listener);
        } catch {
          return () => {};
        }
      };

      const disposers = [];
      try {
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: PANEL_ORDER,
                label: () => t('entry.label'),
              },
              AgentUsageIcon,
            ),
          ),
        );
        disposers.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                inject: () => ({ t, subscribeLocale }),
              },
              AgentUsagePage,
            ),
          ),
        );
      } catch (error) {
        console.error('[agent-usage] panel registration failed:', error);
      }

      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              // ignore
            }
          }
        },
        'agent-usage: ui mounts',
      );
    }

    return { inject, apply };
  },
});
