/**
 * Agent History — Client half.
 *
 * Registers a left-sidebar panel entry and a one-screen conversation browser rendered in the
 * center column. Navigation is project-first: open a project folder, then read that folder's
 * multi-agent conversation history — one chronological session timeline, plus a merged message
 * timeline that interleaves every agent working in the same folder. A secondary "by agent" view
 * browses the same sessions from the agent side.
 *
 * Data comes from the plugin's loopback JSON API; a scan only runs on Refresh.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-agent-history',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'agent-history';
    const PANEL_ID = 'agent-history';
    const PANEL_ORDER = 25;
    const API = {
      snapshot: '/api/dsh-agent-history/snapshot',
      scan: '/api/dsh-agent-history/scan',
      session: '/api/dsh-agent-history/session',
      timeline: '/api/dsh-agent-history/timeline',
      launch: '/api/dsh-agent-history/launch',
      projects: '/api/dsh-agent-history/projects',
      projectsOpen: '/api/dsh-agent-history/projects/open',
      projectsRemove: '/api/dsh-agent-history/projects/remove',
    };

    // ---------------------------------------------------------------------------------------
    // Copy (zh is the source language, en mirrors every key)
    // ---------------------------------------------------------------------------------------

    const zh = {
      'entry.label': 'Agent 历史',
      'page.title': 'Agent 历史对话',
      'page.subtitle': '打开项目文件夹，查看本机所有 AI Agent 在这个项目里的对话 · 每次打开自动刷新',
      'view.project': '我的项目',
      'view.agent': '按 Agent',
      'action.refresh': '刷新',
      'action.refreshing': '扫描中',
      'action.scanNow': '扫描本机对话',
      'action.openFolder': '打开文件夹',
      'action.openFolderHint': '打开一个项目（文件夹），查看它的 Agent 历史',
      'action.retry': '重试',
      'action.continue': '继续对话',
      'action.continueDsh': '在 DSH 中继续',
      'action.expand': '展开对话',
      'action.collapse': '收起',
      'action.copyCommand': '复制命令',
      'action.copied': '已复制',
      'action.showTools': '显示工具调用',
      'action.hideTools': '折叠工具调用',
      'action.loadMore': '加载更多',
      'action.backToProjects': '返回项目',
      'action.clear': '清除',
      'state.loading': '正在读取上次扫描结果…',
      'state.empty.title': '还没有对话记录',
      'state.empty.body': '扫描本机 Agent 保存的会话文件，把 Claude Code、Codex、DeepSeek Harness、OpenCode、Pi、Grok Build、Devin、Antigravity 等工具的对话汇总到这里。每次打开面板都会增量刷新。',
      'state.empty.supported': 'Claude Code · Codex · DeepSeek Harness · OpenCode · Pi · Grok Build · Devin · Antigravity · Zed · Cursor · Copilot CLI · Gemini CLI …',
      'state.error.title': '读取失败',
      'state.noProject.title': '还没有打开项目',
      'state.noProject.body': '选择一个文件夹，或从下面扫描到的项目中挑一个。打开过的项目会以标签显示在顶部，右侧「全部」悬停即可展开完整列表（⌘O / Ctrl+O）。',
      'state.noSessions.title': '这个项目还没有对话记录',
      'state.noSessions.body': '没有找到该文件夹下任何 Agent 的会话。可以试试打开包含子文件夹的上级目录，或换一个项目。',
      'state.noMatch': '当前筛选下没有对话',
      'home.recent': '最近活跃的项目',
      'scan.never': '尚未扫描',
      'scan.at': '刷新于 {time}',
      'scan.summary': '{sessions} 个会话 · {agents} 个 Agent · {projects} 个项目',
      'scan.running': '正在扫描本机会话文件… {seconds}s',
      'search.placeholder': '搜索标题、项目、内容…',
      'project.subfolders': '含子文件夹',
      'project.onlyThis': '只看本层',
      'project.agents': '{count} 个 Agent',
      'project.sessions': '{count} 个会话',
      'project.messages': '{count} 条消息',
      'project.span': '跨 {days} 天',
      'project.unknown': '未记录项目',
      'project.pathUnknown': '该 Agent 没有记录项目文件夹',
      'tab.sessions': '会话时间轴',
      'tab.messages': '消息时间轴',
      'tab.tip.sessions': '同一项目里各 Agent 的会话按开始时间排列，同时段并行开发的会标记为「并行」',
      'tab.tip.messages': '把同一项目里所有 Agent 的消息合并成一条完整时间线，按真实发生顺序排列',
      'filter.allAgents': '全部 Agent',
      'day.today': '今天',
      'day.yesterday': '昨天',
      'session.messages': '{count} 条消息',
      'session.prompts': '{count} 次提问',
      'session.parallel': '并行',
      'session.unknownAgent': '未知 Agent',
      'session.toolsHidden': '{count} 条工具调用已折叠',
      'session.emptyTranscript': '无法读取这个会话的对话内容',
      'session.source': '来源文件',
      'session.truncated': '内容较长，仅显示最近 {count} 条',
      'timeline.loaded': '已显示 {shown} / {total} 条',
      'session.loadedCount': '已显示 {shown} / {total} 个会话',
      'timeline.scope': '合并了最近 {included} / {total} 个会话的消息',
      'timeline.failed': '{count} 个会话读取失败，未计入：{detail}',
      'timeline.truncated': '{count} 个会话过长，只合并和搜索了最近的消息：{detail}',
      'timeline.empty': '这个项目还没有可合并的消息',
      'agent.sessions': '{count} 个会话',
      'agent.last': '最近 {time}',
      'agent.notInstalled': '未安装',
      'agent.empty': '没有对话记录',
      'agent.unreadable': '检测到但无法读取',
      'agent.dshSession': 'DSH 会话',
      'launch.dshMissing': '无法在当前 DSH 中打开该会话',
      'launch.opened': '已打开会话',
      'launch.launched': '已在 {terminal} 中继续对话',
      'launch.failed': '启动失败：{error}',
      'launch.unsupported': '这个 Agent 暂不支持一键继续，可以展示路径手动打开',
      'launch.copiedCmd': '已复制启动命令',
      'footnote': '数据目录 {dir}',
      'scan.failed': '扫描失败：{error}',
      'source.local': '本机会话文件',
      'action.openProject': '打开项目',
      'action.browseFolder': '选择文件夹…',
      'action.cancel': '取消',
      'action.copyPath': '复制路径',
      'picker.search': '搜索扫描到的项目…',
      'picker.detected': '扫描到 {count} 个有对话记录的项目',
      'picker.none': '还没有扫描到带项目路径的会话',
      'picker.opened': '已打开过',
      'opened.title': '打开过的项目 · {count}',
      'opened.empty': '还没有打开过项目',
      'opened.missing': '文件夹已不存在',
      'opened.noSessions': '暂无会话',
      'opened.remove': '移除',
      'opened.removeTitle': '从历史中移除这个项目？',
      'opened.removeBody': '将从「打开过的项目」中移除 {name}（{path}）。只删除这条打开记录，不会删除任何文件或 Agent 对话。',
      'opened.clear': '清空历史',
      'opened.clearTitle': '清空全部项目历史？',
      'opened.clearBody': '将移除全部 {count} 个打开过的项目记录。不会删除任何文件或 Agent 对话。',
      'opened.saveFailed': '项目已打开，但没能保存到历史',
      'search.opened': '筛选打开过的项目…',
      'sort.label': '排序',
      'sort.desc': '最新在前',
      'sort.asc': '最早在前',
      'role.label': '消息角色',
      'role.all': '全部',
      'role.user': '用户',
      'role.assistant': 'AI',
      'timeline.search': '搜索消息内容…',
      'timeline.noMatch': '没有符合筛选条件的消息',
      'stat.sessions': '会话',
      'stat.messages': '消息',
      'stat.agents': 'Agent',
      'stat.days': '天',
      'stat.projects': '项目',
      'stat.updated': '最近活跃 {time}',
      'project.subfoldersHint': '同时包含子文件夹里的会话',
      'session.parallelCount': '{count} 个会话同时进行',
      'agent.byProject': '按项目分组',
      'agent.openProject': '打开这个项目',
      'range.label': '时间范围',
      'range.7': '近 7 天',
      'range.30': '近 30 天',
      'range.90': '近 90 天',
      'range.all': '全部时间',
      'switcher.title': '切换项目',
      'switcher.none': '选择项目',
      'switcher.hint': '打开过的项目都在这里',
      'switcher.shortcut': '⌘O / Ctrl+O 打开切换器',
      'switcher.kbd': '⌘O',
      'switcher.all': '查看全部',
      'strip.all': '全部',
      'strip.more': '还有 {count} 个',
      'strip.empty': '打开的项目会以标签形式显示在这里',
      'switcher.agentsHint': '{count} 个 Agent 有对话',
      'view.agentBrowse': '按 Agent 浏览',
    };

    const en = {
      'entry.label': 'Agent History',
      'page.title': 'Agent History',
      'page.subtitle': 'Open a project folder to read every local AI agent’s conversations in it · refreshes on open',
      'view.project': 'My projects',
      'view.agent': 'By agent',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Scanning',
      'action.scanNow': 'Scan this machine',
      'action.openFolder': 'Open folder',
      'action.openFolderHint': 'Open a project folder and read its agent history',
      'action.retry': 'Retry',
      'action.continue': 'Continue',
      'action.continueDsh': 'Open in DSH',
      'action.expand': 'Show conversation',
      'action.collapse': 'Collapse',
      'action.copyCommand': 'Copy command',
      'action.copied': 'Copied',
      'action.showTools': 'Show tool calls',
      'action.hideTools': 'Hide tool calls',
      'action.loadMore': 'Load more',
      'action.backToProjects': 'Back to projects',
      'action.clear': 'Clear',
      'state.loading': 'Loading the last scan…',
      'state.empty.title': 'No conversations yet',
      'state.empty.body': 'Scan the session files saved by local coding agents to collect conversations from Claude Code, Codex, DeepSeek Harness, OpenCode, Pi, Grok Build, Devin, Antigravity and more. The panel refreshes incrementally each time it opens.',
      'state.empty.supported': 'Claude Code · Codex · DeepSeek Harness · OpenCode · Pi · Grok Build · Devin · Antigravity · Zed · Cursor · Copilot CLI · Gemini CLI …',
      'state.error.title': 'Request failed',
      'state.noProject.title': 'No project open',
      'state.noProject.body': 'Pick a folder, or choose one of the projects found below. Opened projects show up as tabs at the top; hover “All” on the right for the full list (⌘O / Ctrl+O).',
      'state.noSessions.title': 'No conversations in this folder',
      'state.noSessions.body': 'No agent session was recorded for this folder. Try opening a parent folder that contains subfolders, or pick another project.',
      'state.noMatch': 'No conversation matches the current filter',
      'home.recent': 'Recently active projects',
      'scan.never': 'Never scanned',
      'scan.at': 'Scanned {time}',
      'scan.summary': '{sessions} sessions · {agents} agents · {projects} projects',
      'scan.running': 'Scanning local session files… {seconds}s',
      'search.placeholder': 'Search title, project, content…',
      'project.subfolders': 'Include subfolders',
      'project.onlyThis': 'This folder only',
      'project.agents': '{count} agents',
      'project.sessions': '{count} sessions',
      'project.messages': '{count} messages',
      'project.span': 'span {days} days',
      'project.unknown': 'Unknown project',
      'project.pathUnknown': 'This agent recorded no project folder',
      'tab.sessions': 'Session timeline',
      'tab.messages': 'Message timeline',
      'tab.tip.sessions': 'Sessions of every agent in this folder ordered by start time; overlapping parallel work is marked “parallel”',
      'tab.tip.messages': 'Every agent’s messages merged into one complete timeline in real chronological order',
      'filter.allAgents': 'All agents',
      'day.today': 'Today',
      'day.yesterday': 'Yesterday',
      'session.messages': '{count} messages',
      'session.prompts': '{count} prompts',
      'session.parallel': 'parallel',
      'session.unknownAgent': 'Unknown agent',
      'session.toolsHidden': '{count} tool calls folded',
      'session.emptyTranscript': 'The transcript of this session could not be read',
      'session.source': 'Source file',
      'session.truncated': 'Long session: showing the latest {count} messages',
      'timeline.loaded': '{shown} / {total} messages shown',
      'session.loadedCount': '{shown} / {total} sessions shown',
      'timeline.scope': 'Merged the latest {included} / {total} sessions',
      'timeline.failed': '{count} sessions could not be read and are left out: {detail}',
      'timeline.truncated': '{count} long sessions: only their latest messages are merged and searched: {detail}',
      'timeline.empty': 'No messages to merge in this project',
      'agent.sessions': '{count} sessions',
      'agent.last': 'last {time}',
      'agent.notInstalled': 'Not installed',
      'agent.empty': 'No conversations',
      'agent.unreadable': 'Detected but unreadable',
      'agent.dshSession': 'DSH session',
      'launch.dshMissing': 'Cannot open this session in the current DSH',
      'launch.opened': 'Session opened',
      'launch.launched': 'Continuing in {terminal}',
      'launch.failed': 'Launch failed: {error}',
      'launch.unsupported': 'This agent has no one-click resume; open its folder manually',
      'launch.copiedCmd': 'Launch command copied',
      'footnote': 'Data folder {dir}',
      'scan.failed': 'Scan failed: {error}',
      'source.local': 'Local session files',
      'action.openProject': 'Open project',
      'action.browseFolder': 'Browse…',
      'action.cancel': 'Cancel',
      'action.copyPath': 'Copy path',
      'picker.search': 'Search scanned projects…',
      'picker.detected': '{count} projects with conversations found',
      'picker.none': 'No session with a project folder was found yet',
      'picker.opened': 'opened',
      'opened.title': 'Opened projects · {count}',
      'opened.empty': 'No project opened yet',
      'opened.missing': 'Folder no longer exists',
      'opened.noSessions': 'No sessions',
      'opened.remove': 'Remove',
      'opened.removeTitle': 'Remove this project from history?',
      'opened.removeBody': '{name} ({path}) will be removed from Opened projects. Only this record is removed; no file or agent conversation is deleted.',
      'opened.clear': 'Clear history',
      'opened.clearTitle': 'Clear the whole project history?',
      'opened.clearBody': 'All {count} opened-project records will be removed. No file or agent conversation is deleted.',
      'opened.saveFailed': 'Project opened, but it could not be saved to history',
      'search.opened': 'Filter opened projects…',
      'sort.label': 'Sort',
      'sort.desc': 'Newest first',
      'sort.asc': 'Oldest first',
      'role.label': 'Message role',
      'role.all': 'All',
      'role.user': 'User',
      'role.assistant': 'AI',
      'timeline.search': 'Search messages…',
      'timeline.noMatch': 'No message matches the filter',
      'stat.sessions': 'sessions',
      'stat.messages': 'messages',
      'stat.agents': 'agents',
      'stat.days': 'days',
      'stat.projects': 'projects',
      'stat.updated': 'active {time}',
      'project.subfoldersHint': 'Also include sessions in subfolders',
      'session.parallelCount': '{count} sessions at the same time',
      'agent.byProject': 'Grouped by project',
      'agent.openProject': 'Open this project',
      'range.label': 'Time range',
      'range.7': 'Last 7 days',
      'range.30': 'Last 30 days',
      'range.90': 'Last 90 days',
      'range.all': 'All time',
      'switcher.title': 'Switch project',
      'switcher.none': 'Choose a project',
      'switcher.hint': 'All opened projects live here',
      'switcher.shortcut': '⌘O / Ctrl+O opens the switcher',
      'switcher.kbd': '⌘O',
      'switcher.all': 'Show all',
      'strip.all': 'All',
      'strip.more': '{count} more',
      'strip.empty': 'Opened projects appear here as tabs',
      'switcher.agentsHint': '{count} agents with conversations',
      'view.agentBrowse': 'Browse by agent',
    };

    const DICTS = { zh, en };

    function makeTranslate(ctx) {
      function currentLocale() {
        try {
          const snapshot = ctx.locale.getSnapshot();
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
    // Formatting helpers
    // ---------------------------------------------------------------------------------------

    const pad2 = (value) => String(value).padStart(2, '0');

    function formatInt(value) {
      return Math.round(Number(value) || 0).toLocaleString('en-US');
    }

    function localDayKey(epochMs) {
      const date = new Date(Number(epochMs) || 0);
      if (Number.isNaN(date.getTime())) return '';
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    function clockOf(epochMs) {
      const date = new Date(Number(epochMs) || 0);
      if (Number.isNaN(date.getTime())) return '';
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function fullTime(epochMs) {
      const date = new Date(Number(epochMs) || 0);
      if (Number.isNaN(date.getTime())) return '';
      const now = new Date();
      const sameYear = now.getFullYear() === date.getFullYear();
      const day = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
      return `${sameYear ? '' : `${date.getFullYear()}-`}${day} ${clockOf(epochMs)}`;
    }

    function relTime(epochMs, locale) {
      const ts = Number(epochMs) || 0;
      if (!ts) return '';
      const diff = Date.now() - ts;
      if (diff < 60_000) return locale === 'zh' ? '刚刚' : 'just now';
      if (diff < 3_600_000) {
        const minutes = Math.round(diff / 60_000);
        return locale === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`;
      }
      if (diff < 86_400_000) {
        const hours = Math.round(diff / 3_600_000);
        return locale === 'zh' ? `${hours} 小时前` : `${hours}h ago`;
      }
      if (diff < 7 * 86_400_000) {
        const days = Math.round(diff / 86_400_000);
        return locale === 'zh' ? `${days} 天前` : `${days}d ago`;
      }
      return fullTime(ts).slice(0, 5);
    }

    function durationBetween(start, end) {
      const span = Math.max(0, (Number(end) || 0) - (Number(start) || 0));
      if (span <= 0) return '';
      if (span < 60_000) return `${Math.max(1, Math.round(span / 1000))}s`;
      if (span < 3_600_000) return `${Math.round(span / 60_000)}m`;
      if (span < 86_400_000) {
        const hours = span / 3_600_000;
        return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
      }
      return `${Math.round(span / 86_400_000)}d`;
    }

    function sessionTimeRange(startAt, endAt) {
      if (!startAt && !endAt) return '';
      const span = durationBetween(startAt, endAt);
      const sameDay = localDayKey(startAt) === localDayKey(endAt);
      const head = sameDay ? clockOf(startAt) : fullTime(startAt);
      const tail = sameDay ? clockOf(endAt) : clockOf(endAt);
      return `${head}–${tail}${span ? ` · ${span}` : ''}`;
    }

    function normalizePath(path) {
      const text = String(path || '').trim();
      if (text === '') return '';
      return text.length > 1 ? text.replace(/[\\/]+$/, '') : text;
    }

    function nameOfPath(path) {
      const normalized = normalizePath(path);
      if (normalized === '') return '';
      const parts = normalized.split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] || normalized;
    }

    /**
     * Comparable form of a folder path: forward slashes, no trailing slash, and lower-cased for
     * Windows paths (drive letters / backslashes), because agents disagree on case and separators.
     */
    function pathKey(path) {
      const raw = String(path || '').trim();
      if (raw === '') return '';
      const windows = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.includes('\\');
      let out = raw.replace(/\\/g, '/');
      if (out.length > 1) out = out.replace(/\/+$/, '');
      if (/^[A-Za-z]:$/.test(out)) out = `${out}/`;
      return windows ? out.toLowerCase() : out;
    }

    function samePath(a, b) {
      const left = pathKey(a);
      return left !== '' && left === pathKey(b);
    }

    function isUnder(parent, child) {
      const a = pathKey(parent);
      const b = pathKey(child);
      if (a === '' || b === '') return false;
      if (a === b) return true;
      return b.startsWith(a.endsWith('/') ? a : `${a}/`);
    }

    function dayLabel(dayKey, t, locale) {
      const today = localDayKey(Date.now());
      const yesterday = localDayKey(Date.now() - 86_400_000);
      if (dayKey === today) return t('day.today');
      if (dayKey === yesterday) return t('day.yesterday');
      const parts = dayKey.split('-').map(Number);
      if (parts.length !== 3) return dayKey;
      const date = new Date(parts[0], parts[1] - 1, parts[2]);
      const weekdayZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const weekdayEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const weekday = locale === 'zh' ? weekdayZh[date.getDay()] : weekdayEn[date.getDay()];
      return `${parts[1]}/${parts[2]} ${weekday}`;
    }

    // ---------------------------------------------------------------------------------------
    // Data access
    // ---------------------------------------------------------------------------------------

    async function requestJson(path, options) {
      const response = await fetch(path, {
        method: options?.method || 'GET',
        headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
        credentials: 'same-origin',
        body: options?.body ? JSON.stringify(options.body) : undefined,
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

    function useSnapshot() {
      const [snapshot, setSnapshot] = useState(null);
      const [phase, setPhase] = useState('loading');
      const [error, setError] = useState('');
      const [scanning, setScanning] = useState(false);
      const [scanStartedAt, setScanStartedAt] = useState(0);
      const [generation, setGeneration] = useState(0);
      /** Time of the latest scan, also when it found nothing new (the snapshot object is kept then). */
      const [scannedAt, setScannedAt] = useState(0);
      const mounted = useRef(true);
      const inFlight = useRef(null);
      const signature = useRef('');
      /** Apply a snapshot payload; an `unchanged` one keeps the data (and every derived view) as is. */
      const accept = (payload) => {
        if (payload.unchanged) {
          setScannedAt(payload.scannedAt || 0);
          return false;
        }
        const next = payload.snapshot || null;
        signature.current = typeof next?.signature === 'string' ? next.signature : '';
        setSnapshot(next);
        setScannedAt(next?.scannedAt || 0);
        return true;
      };
      const since = () => (signature.current ? `?since=${encodeURIComponent(signature.current)}` : '');

      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const load = useCallback(async () => {
        try {
          const payload = await requestJson(`${API.snapshot}${since()}`);
          if (!mounted.current) return;
          accept(payload);
          setPhase('ready');
          setError('');
        } catch (loadError) {
          if (!mounted.current) return;
          setPhase('error');
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }, []);

      /** Run (or join) one scan; resolves `true` on success or the error message. */
      const scan = useCallback(() => {
        if (inFlight.current) return inFlight.current;
        setScanning(true);
        setScanStartedAt(Date.now());
        const run = (async () => {
          try {
            const payload = await requestJson(`${API.scan}${since()}`, { method: 'POST' });
            if (!mounted.current) return true;
            const changed = accept(payload);
            setPhase('ready');
            setError('');
            if (changed) setGeneration((value) => value + 1);
            return true;
          } catch (scanError) {
            const message = scanError instanceof Error ? scanError.message : String(scanError);
            if (mounted.current) setError(message);
            return message;
          } finally {
            inFlight.current = null;
            if (mounted.current) {
              setScanning(false);
              setScanStartedAt(0);
            }
          }
        })();
        inFlight.current = run;
        return run;
      }, []);

      useEffect(() => {
        // Show the last saved scan immediately, then refresh it: every time the panel is opened the
        // data is current (incremental scans only re-read changed files).
        load().then(() => scan());
      }, [load, scan]);

      return { snapshot, scannedAt, phase, error, scanning, scanStartedAt, generation, load, scan, setError };
    }

    /** Folders the user opened in this panel (Host-persisted, newest first). */
    function useOpenedProjects() {
      const [projects, setProjects] = useState([]);
      const [loaded, setLoaded] = useState(false);
      const [error, setError] = useState('');
      const apply = (payload) => {
        setProjects(Array.isArray(payload?.projects) ? payload.projects : []);
        setLoaded(true);
        setError('');
      };
      const reload = useCallback(async () => {
        try {
          apply(await requestJson(API.projects));
        } catch (loadError) {
          setLoaded(true);
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }, []);
      useEffect(() => {
        reload();
      }, [reload]);
      const open = useCallback(async (path) => {
        try {
          apply(await requestJson(API.projectsOpen, { method: 'POST', body: { path } }));
          return true;
        } catch (openError) {
          setError(openError instanceof Error ? openError.message : String(openError));
          return false;
        }
      }, []);
      const remove = useCallback(async (body) => {
        apply(await requestJson(API.projectsRemove, { method: 'POST', body }));
      }, []);
      return { projects, loaded, error, open, remove, reload };
    }

    /** Re-run `onShow` whenever the panel becomes visible again (a hidden panel may stay mounted). */
    function useOnReveal(ref, onShow) {
      const callback = useRef(onShow);
      callback.current = onShow;
      useEffect(() => {
        const node = ref.current;
        if (!node || typeof IntersectionObserver !== 'function') return undefined;
        let visible = true;
        const observer = new IntersectionObserver((entries) => {
          const now = entries.some((entry) => entry.isIntersecting);
          if (now && !visible) callback.current();
          visible = now;
        });
        observer.observe(node);
        const onVisibility = () => {
          if (document.visibilityState === 'visible' && visible) callback.current();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          observer.disconnect();
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [ref]);
    }

    function useLocaleTick(subscribeLocale) {
      const [, setTick] = useState(0);
      useEffect(() => {
        if (typeof subscribeLocale !== 'function') return undefined;
        let disposed = false;
        const unsubscribe = subscribeLocale(() => {
          if (!disposed) setTick((value) => value + 1);
        });
        return () => {
          disposed = true;
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [subscribeLocale]);
    }

    // ---------------------------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------------------------

    function svg(paths, size = 14, extra) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          ...(extra || {}),
        },
        paths.map((path, index) => h('path', { key: index, d: path })),
      );
    }

    const IconRefresh = () => svg(['M20 11a8 8 0 1 0-2.3 6.3', 'M20 5v6h-6']);
    const IconFolder = (props) => svg(['M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h8.5A1.5 1.5 0 0 1 20.5 10v7A1.5 1.5 0 0 1 19 18.5H4.5A1.5 1.5 0 0 1 3 17z'], props?.size || 15);
    const IconSearch = () => svg(['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm20 20-3.5-3.5']);
    const IconChevron = (props) => svg(['m9 6 6 6-6 6'], 13, { style: { transform: props?.open ? 'rotate(90deg)' : undefined, transition: 'transform .12s ease' } });
    const IconPlay = () => svg(['M8 5.5v13l11-6.5z'], 13);
    const IconCopy = () => svg(['M9 9h9v11H9z', 'M6 15H4V4h11v2']);
    const IconMessage = () => svg(['M4 5h16v11H9l-5 4z']);
    const IconTerminal = () => svg(['m6 8 4 4-4 4', 'M13 16h5']);
    const IconBot = () => svg(['M12 3v3', 'M6 9h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z', 'M9 13h.01', 'M15 13h.01']);
    const IconPlus = () => svg(['M12 5v14', 'M5 12h14']);
    const IconChevronDown = () => svg(['m6 9 6 6 6-6'], 14);
    const IconChevronLeft = () => svg(['m15 6-6 6 6 6'], 14);
    const IconTrash = () => svg(['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l.8 12.5h9.4L17.5 7', 'M10 11v5', 'M14 11v5'], 13);

    // ---------------------------------------------------------------------------------------
    // Small shared controls
    // ---------------------------------------------------------------------------------------

    function Button(props) {
      const { variant = 'ghost', icon, label, onClick, disabled, title, active } = props;
      return h(
        'button',
        {
          type: 'button',
          className: `ah-btn ah-btn-${variant}${active ? ' is-active' : ''}`,
          onClick,
          disabled,
          title: title || label,
        },
        icon || null,
        label ? h('span', null, label) : null,
      );
    }

    function Segmented(props) {
      const { value, options, onChange, ariaLabel } = props;
      return h(
        'div',
        { className: 'ah-seg', role: 'tablist', 'aria-label': ariaLabel },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'tab',
              'aria-selected': value === option.value,
              className: `ah-seg-item${value === option.value ? ' is-active' : ''}`,
              onClick: () => onChange(option.value),
              title: option.title,
            },
            option.label,
          ),
        ),
      );
    }

    function AgentBadge(props) {
      const { agent, compact } = props;
      const color = agent?.color || 'var(--dsw-alias-label-tertiary)';
      const name = agent?.name || props.fallback || 'Agent';
      return h(
        'span',
        {
          className: `ah-agent-badge${compact ? ' is-compact' : ''}`,
          style: {
            color,
            background: `color-mix(in srgb, ${color} 13%, transparent)`,
            borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
          },
          title: name,
        },
        h('i', { className: 'ah-dot', style: { background: color } }),
        compact ? null : h('span', null, name),
      );
    }

    function AgentDots(props) {
      const { agents, max = 5 } = props;
      const shown = agents.slice(0, max);
      const rest = agents.length - shown.length;
      return h(
        'span',
        { className: 'ah-dots' },
        shown.map((agent) =>
          h('i', {
            key: agent.id,
            className: 'ah-dot',
            style: { background: agent.color || 'var(--dsw-alias-label-tertiary)' },
            title: agent.name,
          }),
        ),
        rest > 0 ? h('span', { className: 'ah-dots-more' }, `+${rest}`) : null,
      );
    }

    function Spinner() {
      return h('span', { className: 'ah-spinner', 'aria-hidden': 'true' });
    }

    // ---------------------------------------------------------------------------------------
    // Message rendering
    // ---------------------------------------------------------------------------------------

    function MessageRow(props) {
      const { message, agents, showTools, compact } = props;
      const agent = agents.get(message.agentId);
      if (message.kind === 'tool-call' || message.kind === 'tool-result') {
        if (!showTools) return null;
      }
      const roleLabel = message.role === 'user' ? 'USER' : message.role === 'assistant' ? 'AI' : message.kind === 'tool-call' ? 'TOOL' : message.kind === 'tool-result' ? 'RESULT' : 'SYS';
      return h(
        'div',
        {
          className: `ah-msg ah-msg-${message.role}${message.kind ? ` ah-msg-${message.kind}` : ''}${compact ? ' is-compact' : ''}`,
        },
        h(
          'div',
          { className: 'ah-msg-head' },
          h('span', { className: 'ah-msg-role' }, message.name && message.kind === 'tool-call' ? String(message.name).toUpperCase() : roleLabel),
          message.ts ? h('span', { className: 'ah-msg-time' }, fullTime(message.ts)) : null,
          agent && compact ? h(AgentBadge, { agent, compact: true }) : null,
        ),
        h('div', { className: 'ah-msg-text' }, message.text),
      );
    }

    function Transcript(props) {
      const { data, agents, t } = props;
      const [showTools, setShowTools] = useState(false);
      const messages = data?.messages || [];
      const toolCount = messages.filter((message) => message.kind === 'tool-call' || message.kind === 'tool-result').length;
      const visible = messages.filter((message) => showTools || (message.kind !== 'tool-call' && message.kind !== 'tool-result'));
      const capped = visible.length > 500 ? visible.slice(-500) : visible;
      if (!data) return h('div', { className: 'ah-transcript-loading' }, h(Spinner), h('span', null, t('state.loading')));
      if (messages.length === 0) return h('div', { className: 'ah-transcript-empty' }, t('session.emptyTranscript'));
      return h(
        'div',
        { className: 'ah-transcript' },
        capped.length < visible.length
          ? h('div', { className: 'ah-transcript-note' }, t('session.truncated', { count: capped.length }))
          : null,
        toolCount > 0
          ? h(
              'button',
              { type: 'button', className: 'ah-tool-toggle', onClick: () => setShowTools((value) => !value) },
              showTools ? t('action.hideTools') : `${t('action.showTools')} · ${t('session.toolsHidden', { count: toolCount })}`,
            )
          : null,
        capped.map((message, index) => h(MessageRow, { key: index, message, agents, showTools, compact: false })),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Session card + project timeline
    // ---------------------------------------------------------------------------------------

    function sessionStatus(session) {
      return session.updatedAt || session.startedAt || 0;
    }

    /**
     * Split sessions into readable timeline clusters: day boundary first, then overlapping
     * sessions of that day are marked as parallel work instead of being interleaved at random.
     */
    function clusterSessions(sessions) {
      const sorted = [...sessions].sort((a, b) => (a.startedAt || a.updatedAt) - (b.startedAt || b.updatedAt));
      const clusters = [];
      for (const session of sorted) {
        const startAt = session.startedAt || session.updatedAt;
        const endAt = session.updatedAt || startAt;
        const last = clusters[clusters.length - 1];
        const sameDay = last && localDayKey(startAt) === localDayKey(last.endAt);
        if (last && sameDay && startAt <= last.endAt) {
          last.sessions.push(session);
          last.endAt = Math.max(last.endAt, endAt);
        } else {
          clusters.push({ sessions: [session], startAt, endAt });
        }
      }
      return clusters;
    }

    function SessionCard(props) {
      const { session, agent, t, locale, expanded, onToggle, onContinue, onCopyCommand, continueLabel, agents, transcript, loadingTranscript, autoFocus } = props;
      const ref = useRef(null);
      const startAt = session.startedAt || session.updatedAt;
      const endAt = session.updatedAt || startAt;
      const parallel = props.parallel === true;
      useEffect(() => {
        if (autoFocus && ref.current && typeof ref.current.scrollIntoView === 'function') {
          ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, [autoFocus]);
      const command = agent?.resume?.kind === 'cli' && agent.resume.command
        ? [agent.resume.command, ...(agent.resume.args || [])].join(' ').replaceAll('{id}', session.nativeId).replaceAll('{cwd}', session.projectPath || '')
        : '';
      return h(
        'div',
        { ref, className: `ah-session${expanded ? ' is-open' : ''}${parallel ? ' is-parallel' : ''}` },
        h('span', { className: 'ah-rail', style: { background: agent?.color || 'var(--dsw-alias-label-tertiary)' } }),
        h(
          'div',
          { className: 'ah-session-body' },
          h(
            'div',
            { className: 'ah-session-top' },
            h(AgentBadge, { agent, fallback: t('session.unknownAgent'), compact: false }),
            h('button', { type: 'button', className: 'ah-session-title', onClick: onToggle, title: session.title }, session.title),
            parallel ? h('span', { className: 'ah-parallel' }, t('session.parallel')) : null,
            h('span', { className: 'ah-session-time' }, sessionTimeRange(startAt, endAt)),
          ),
          h('div', { className: 'ah-session-preview' }, session.preview || session.lastPreview || t('session.emptyTranscript')),
          h(
            'div',
            { className: 'ah-session-meta' },
            h('span', null, t('session.messages', { count: formatInt(session.messages) })),
            h('span', { className: 'ah-sep' }, '·'),
            h('span', null, t('session.prompts', { count: formatInt(session.userMessages) })),
            session.extra ? h('span', { className: 'ah-chip is-quiet' }, session.extra) : null,
            h('span', { className: 'ah-spacer' }),
            command
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ah-link',
                    title: `${t('action.copyCommand')}\n${command}`,
                    onClick: (event) => {
                      event.stopPropagation();
                      onCopyCommand(session);
                    },
                  },
                  h(IconCopy),
                  h('span', null, t('action.copyCommand')),
                )
              : null,
            continueLabel
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ah-btn ah-btn-primary ah-btn-small',
                    onClick: (event) => {
                      event.stopPropagation();
                      onContinue();
                    },
                  },
                  h(IconPlay),
                  h('span', null, continueLabel),
                )
              : null,
            h(
              'button',
              { type: 'button', className: 'ah-link', onClick: onToggle },
              h(IconChevron, { open: expanded }),
              h('span', null, expanded ? t('action.collapse') : t('action.expand')),
            ),
          ),
          expanded
            ? h(
                'div',
                { className: 'ah-transcript-wrap' },
                h(
                  'div',
                  { className: 'ah-transcript-source' },
                  h('span', null, t('session.source')),
                  h('code', { title: session.sourcePath }, session.sourcePath),
                ),
                loadingTranscript
                  ? h('div', { className: 'ah-transcript-loading' }, h(Spinner), h('span', null, t('state.loading')))
                  : h(Transcript, { data: transcript, agents, t }),
              )
            : null,
        ),
      );
    }

    function DaySeparator(props) {
      return h(
        'div',
        { className: 'ah-day' },
        h('span', { className: 'ah-day-label' }, props.label),
        h('span', { className: 'ah-day-line' }),
        props.count ? h('span', { className: 'ah-day-count' }, props.count) : null,
      );
    }

    function ProjectTimeline(props) {
      const { sessions, agents, t, locale, expandedId, onToggle, onContinue, onCopyCommand, transcripts, loadingIds, continueLabelFor, focusId } = props;
      const desc = props.order !== 'asc';
      const clusters = useMemo(() => clusterSessions(sessions), [sessions]);
      /** @type {Map<string, any[]>} */
      const byDay = new Map();
      for (const cluster of clusters) {
        const day = localDayKey(cluster.startAt);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(cluster);
      }
      const days = [...byDay.keys()].sort();
      if (desc) days.reverse();
      return h(
        'div',
        { className: 'ah-timeline' },
        days.map((day) => {
          const dayClusters = [...(byDay.get(day) || [])];
          if (desc) dayClusters.reverse();
          const dayCount = dayClusters.reduce((sum, cluster) => sum + cluster.sessions.length, 0);
          return h(
            'div',
            { key: day, className: 'ah-day-block' },
            h(DaySeparator, { label: dayLabel(day, t, locale), count: t('project.sessions', { count: dayCount }) }),
            dayClusters.map((cluster) => {
              const parallelCluster = cluster.sessions.length > 1;
              const ordered = desc ? [...cluster.sessions].reverse() : cluster.sessions;
              return h(
                'div',
                { key: cluster.sessions.map((session) => session.id).join('|'), className: `ah-cluster${parallelCluster ? ' is-parallel' : ''}` },
                parallelCluster
                  ? h(
                      'div',
                      { className: 'ah-cluster-head' },
                      h('span', { className: 'ah-cluster-badge' }, t('session.parallel')),
                      h('span', null, t('session.parallelCount', { count: cluster.sessions.length })),
                    )
                  : null,
                ordered.map((session) =>
                  h(SessionCard, {
                    key: session.id,
                    session,
                    agent: agents.get(session.agentId),
                    t,
                    locale,
                    expanded: expandedId === session.id,
                    autoFocus: focusId === session.id,
                    parallel: parallelCluster,
                    onToggle: () => onToggle(session.id),
                    onContinue: () => onContinue(session),
                    onCopyCommand,
                    continueLabel: continueLabelFor(session),
                    agents,
                    transcript: transcripts.get(session.id) || null,
                    loadingTranscript: loadingIds.has(session.id),
                  }),
                ),
              );
            }),
          );
        }),
      );
    }

    function MessageTimeline(props) {
      const { events, agents, t, locale, onFocusSession, loading, total, shown, onLoadMore, sessionsTotal, sessionsIncluded, error, filtered, failedSessions, truncatedSessions } = props;
      const failed = Array.isArray(failedSessions) ? failedSessions : [];
      const truncated = Array.isArray(truncatedSessions) ? truncatedSessions : [];
      if (loading && events.length === 0) {
        return h('div', { className: 'ah-loading' }, h(Spinner), h('span', null, t('state.loading')));
      }
      if (error) return h('div', { className: 'ah-empty-inline is-error' }, error);
      // Shown with an empty list too: "no messages" alone would hide that every session failed to read.
      const notices = [
        sessionsTotal > sessionsIncluded
          ? h('div', { className: 'ah-timeline-scope' }, t('timeline.scope', { included: sessionsIncluded, total: sessionsTotal }))
          : null,
        failed.length > 0
          ? h(
              'div',
              { className: 'ah-timeline-scope', title: failed.map((item) => `${item.title || item.id}: ${item.error}`).join('\n') },
              t('timeline.failed', {
                count: failed.length,
                detail: failed.slice(0, 2).map((item) => `${item.title || item.id}（${item.error}）`).join('；'),
              }),
            )
          : null,
        truncated.length > 0
          ? h(
              'div',
              { className: 'ah-timeline-scope', title: truncated.map((item) => item.title || item.id).join('\n') },
              t('timeline.truncated', {
                count: truncated.length,
                detail: truncated.slice(0, 2).map((item) => item.title || item.id).join('；'),
              }),
            )
          : null,
      ];
      if (events.length === 0) {
        return h(
          'div',
          { className: 'ah-timeline ah-timeline-messages' },
          ...notices,
          h('div', { className: 'ah-empty-inline' }, filtered ? t('timeline.noMatch') : t('timeline.empty')),
        );
      }
      let lastDay = '';
      const rows = [];
      for (const event of events) {
        const day = localDayKey(event.ts);
        if (day !== lastDay) {
          rows.push(h(DaySeparator, { key: `d:${day}:${event.key}`, label: dayLabel(day, t, locale) }));
          lastDay = day;
        }
        const agent = agents.get(event.agentId);
        rows.push(
          h(
            'div',
            { key: event.key, className: `ah-tl ah-tl-${event.role}` },
            h('div', { className: 'ah-tl-time' }, clockOf(event.ts)),
            h('span', { className: 'ah-tl-rail', style: { background: agent?.color || 'var(--dsw-alias-label-tertiary)' } }),
            h(
              'div',
              { className: 'ah-tl-body' },
              h(
                'div',
                { className: 'ah-tl-head' },
                h('button', { type: 'button', className: 'ah-tl-agent', onClick: () => onFocusSession(event.sessionId), title: event.sessionTitle, style: { color: agent?.color } }, agent?.name || event.agentId),
                h('span', { className: 'ah-tl-session', title: event.sessionTitle }, event.sessionTitle),
                h('span', { className: `ah-tl-role is-${event.role}` }, event.role === 'user' ? t('role.user') : t('role.assistant')),
              ),
              h('div', { className: 'ah-tl-text' }, event.text),
            ),
          ),
        );
      }
      return h(
        'div',
        { className: 'ah-timeline ah-timeline-messages' },
        ...notices,
        rows,
        h(
          'div',
          { className: 'ah-timeline-foot' },
          h('span', null, t('timeline.loaded', { shown, total })),
          shown < total ? h(Button, { variant: 'default', label: loading ? t('state.loading') : t('action.loadMore'), onClick: onLoadMore, disabled: loading }) : null,
        ),
      );
    }

    function ConfirmDialog(props) {
      const { title, body, confirmLabel, t, busy, onConfirm, onCancel } = props;
      const cancelRef = useRef(null);
      useEffect(() => {
        if (cancelRef.current) cancelRef.current.focus();
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [onCancel]);
      return h(
        'div',
        { className: 'ah-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onCancel(); } },
        h(
          'div',
          { className: 'ah-dialog is-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'ah-dialog-title' }, title),
          h('div', { className: 'ah-dialog-body' }, body),
          h(
            'div',
            { className: 'ah-dialog-foot' },
            h('button', { type: 'button', className: 'ah-btn ah-btn-default', ref: cancelRef, onClick: onCancel, disabled: busy }, t('action.cancel')),
            h('button', { type: 'button', className: 'ah-btn ah-btn-danger', onClick: onConfirm, disabled: busy }, confirmLabel),
          ),
        ),
      );
    }

    /**
     * Folder chooser: the native picker first, plus every project folder that the scan found
     * conversations in, so a project can be opened without browsing the disk.
     */
    function ProjectPicker(props) {
      const { t, locale, detected, agents, onPick, onBrowse, openedKeys, autoFocus } = props;
      const [query, setQuery] = useState('');
      const needle = query.trim().toLowerCase();
      const list = useMemo(
        () => detected.filter((project) => needle === '' || `${project.name} ${project.path}`.toLowerCase().includes(needle)),
        [detected, needle],
      );
      return h(
        'div',
        { className: 'ah-picker' },
        h(
          'div',
          { className: 'ah-picker-top' },
          h(Button, { variant: 'primary', icon: h(IconFolder), label: t('action.browseFolder'), onClick: onBrowse }),
          h(
            'div',
            { className: 'ah-search ah-picker-search' },
            h(IconSearch),
            h('input', {
              type: 'search', value: query, autoFocus: Boolean(autoFocus),
              placeholder: t('picker.search'), 'aria-label': t('picker.search'),
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && list[0]) onPick(list[0].path); },
            }),
          ),
        ),
        h('div', { className: 'ah-picker-label' }, t('picker.detected', { count: formatInt(detected.length) })),
        h(
          'div',
          { className: 'ah-picker-list' },
          list.length === 0
            ? h('div', { className: 'ah-side-empty' }, detected.length === 0 ? t('picker.none') : t('state.noMatch'))
            : list.map((project) =>
                h(
                  'button',
                  { key: project.key, type: 'button', className: 'ah-picker-item', onClick: () => onPick(project.path), title: project.path },
                  h('span', { className: 'ah-row-icon' }, h(IconFolder, { size: 16 })),
                  h(
                    'span',
                    { className: 'ah-row-main' },
                    h(
                      'span',
                      { className: 'ah-row-title' },
                      project.name,
                      openedKeys.has(pathKey(project.path)) ? h('span', { className: 'ah-chip is-quiet is-tiny' }, t('picker.opened')) : null,
                    ),
                    h('span', { className: 'ah-row-sub' }, project.path),
                  ),
                  h(
                    'span',
                    { className: 'ah-row-side' },
                    h(AgentDots, { agents: project.agents.map((id) => agents.get(id)).filter(Boolean), max: 5 }),
                    h('span', { className: 'ah-row-meta' }, `${t('project.sessions', { count: formatInt(project.sessions) })} · ${relTime(project.updatedAt, locale)}`),
                  ),
                ),
              ),
        ),
      );
    }

    function RangeSelect(props) {
      const { t, value, onChange } = props;
      return h(
        'select',
        { className: 'ah-select', value, onChange: (event) => onChange(event.target.value), 'aria-label': t('range.label'), title: t('range.label') },
        h('option', { value: '7' }, t('range.7')),
        h('option', { value: '30' }, t('range.30')),
        h('option', { value: '90' }, t('range.90')),
        h('option', { value: 'all' }, t('range.all')),
      );
    }

    /**
     * Header project switcher: shows the open project (or agent) and drops down the history of
     * opened folders with search, remove (confirmed by the caller), open-new and the agent view.
     */
    function ProjectSwitcher(props) {
      const { t, locale, open, onOpenChange, label, sub, projects, stats, agents, currentKey, onPick, onRemove, onOpenNew, onAgents, onClear } = props;
      const menu = props.variant === 'menu';
      const wrapRef = useRef(null);
      const inputRef = useRef(null);
      // Hover-to-expand: opened by hovering it closes again when the pointer leaves (unless the user
      // started typing a search); a click pins it open like a normal menu.
      const hoverTimer = useRef(null);
      const hovered = useRef(false);
      useEffect(() => () => clearTimeout(hoverTimer.current), []);
      const [query, setQuery] = useState('');
      const [cursor, setCursor] = useState(0);
      const needle = query.trim().toLowerCase();
      const list = useMemo(
        () => projects.filter((project) => needle === '' || `${project.name} ${project.path}`.toLowerCase().includes(needle)),
        [projects, needle],
      );
      useEffect(() => {
        if (!open) {
          hovered.current = false;
          return undefined;
        }
        setQuery('');
        setCursor(0);
        const timer = setTimeout(() => { if (!hovered.current) inputRef.current?.focus(); }, 0);
        const onDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) onOpenChange(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => {
          clearTimeout(timer);
          document.removeEventListener('mousedown', onDown);
        };
      }, [open]);
      useEffect(() => setCursor(0), [needle]);
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onOpenChange(false);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setCursor((value) => Math.min(list.length - 1, value + 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setCursor((value) => Math.max(0, value - 1));
        } else if (event.key === 'Enter' && list[cursor]) {
          event.preventDefault();
          onPick(list[cursor].path);
        }
      };
      const hoverProps = props.hoverOpen
        ? {
            onMouseEnter: () => {
              clearTimeout(hoverTimer.current);
              if (!open) {
                hoverTimer.current = setTimeout(() => {
                  hovered.current = true;
                  onOpenChange(true);
                }, 140);
              }
            },
            onMouseLeave: () => {
              clearTimeout(hoverTimer.current);
              if (open && hovered.current && query === '') hoverTimer.current = setTimeout(() => onOpenChange(false), 280);
            },
          }
        : {};
      const onTrigger = () => {
        clearTimeout(hoverTimer.current);
        if (open && hovered.current) {
          hovered.current = false;
          inputRef.current?.focus();
          return;
        }
        onOpenChange(!open);
      };
      return h(
        'div',
        { className: `ah-switcher${menu ? ' is-menu' : ''}`, ref: wrapRef, ...hoverProps },
        menu
          ? h(
              'button',
              {
                type: 'button',
                className: `ah-strip-more${open ? ' is-open' : ''}`,
                onClick: onTrigger,
                'aria-haspopup': 'listbox',
                'aria-expanded': open,
                title: t('switcher.shortcut'),
              },
              h('span', null, label),
              projects.length > 0 ? h('span', { className: 'ah-strip-count' }, formatInt(projects.length)) : null,
              IconChevronDown(),
            )
          : h(
              'button',
              {
                type: 'button',
                className: `ah-switcher-btn${open ? ' is-open' : ''}`,
                onClick: onTrigger,
                'aria-haspopup': 'listbox',
                'aria-expanded': open,
                title: `${sub || label}\n${t('switcher.shortcut')}`,
              },
              h('span', { className: 'ah-switcher-icon' }, h(IconFolder, { size: 15 })),
              h(
                'span',
                { className: 'ah-switcher-text' },
                h('span', { className: 'ah-switcher-label' }, label),
                sub ? h('span', { className: 'ah-switcher-sub' }, sub) : null,
              ),
              h('span', { className: 'ah-switcher-chev' }, IconChevronDown()),
            ),
        open
          ? h(
              'div',
              { className: `ah-switcher-pop${menu ? ' is-right' : ''}`, role: 'dialog', 'aria-label': t('switcher.title'), onKeyDown },
              h(
                'div',
                { className: 'ah-search ah-switcher-search' },
                h(IconSearch),
                h('input', {
                  ref: inputRef, type: 'search', value: query, placeholder: t('search.opened'), 'aria-label': t('search.opened'),
                  onChange: (event) => setQuery(event.target.value),
                }),
              ),
              h('div', { className: 'ah-switcher-label-row' }, t('opened.title', { count: projects.length })),
              h(
                'div',
                { className: 'ah-switcher-list', role: 'listbox' },
                list.length === 0
                  ? h('div', { className: 'ah-side-empty' }, projects.length === 0 ? t('opened.empty') : t('state.noMatch'))
                  : list.map((project, index) => {
                      const stat = stats.get(pathKey(project.path));
                      const projectAgents = (stat?.agents || []).map((id) => agents.get(id)).filter(Boolean);
                      const active = currentKey !== '' && pathKey(project.path) === currentKey;
                      return h(
                        'div',
                        {
                          key: project.path,
                          role: 'option',
                          'aria-selected': active,
                          className: `ah-switcher-item${active ? ' is-active' : ''}${index === cursor ? ' is-cursor' : ''}${project.exists === false ? ' is-missing' : ''}`,
                          onMouseEnter: () => setCursor(index),
                          onClick: () => onPick(project.path),
                          title: project.path,
                        },
                        h('span', { className: 'ah-row-icon' }, h(IconFolder, { size: 15 })),
                        h(
                          'span',
                          { className: 'ah-row-main' },
                          h('span', { className: 'ah-row-title' }, project.name || nameOfPath(project.path)),
                          h('span', { className: 'ah-row-sub' }, project.exists === false ? t('opened.missing') : project.path),
                        ),
                        h(
                          'span',
                          { className: 'ah-row-side' },
                          projectAgents.length > 0 ? h(AgentDots, { agents: projectAgents, max: 4 }) : null,
                          h('span', { className: 'ah-row-meta' }, stat && stat.sessions > 0 ? `${formatInt(stat.sessions)} · ${relTime(stat.updatedAt, locale)}` : t('opened.noSessions')),
                        ),
                        h(
                          'button',
                          {
                            type: 'button', className: 'ah-row-remove', title: t('opened.remove'), 'aria-label': t('opened.remove'),
                            onClick: (event) => { event.stopPropagation(); onRemove(project); },
                          },
                          IconTrash(),
                        ),
                      );
                    }),
              ),
              h(
                'div',
                { className: 'ah-switcher-foot' },
                h('button', { type: 'button', className: 'ah-switcher-action', onClick: onOpenNew }, h(IconPlus), h('span', null, t('action.openProject')), h('kbd', null, t('switcher.kbd'))),
                h('button', { type: 'button', className: 'ah-switcher-action', onClick: onAgents }, IconBot(), h('span', null, t('view.agentBrowse'))),
                projects.length > 0
                  ? h('button', { type: 'button', className: 'ah-switcher-action is-danger', onClick: onClear }, IconTrash(), h('span', null, t('opened.clear')))
                  : null,
              ),
            )
          : null,
      );
    }

    /**
     * One compact row of recently opened projects as tabs. Tabs keep a stable order while the page
     * is open (clicking a tab must not make the row jump); tabs that do not fit are reachable from
     * the hover menu on the right, which also holds search, remove, open and the agent view.
     */
    function ProjectStrip(props) {
      const { t, projects, stats, currentKey, agentActive, onPick, onRemove, onAgents, onOpenNew, menu } = props;
      const rowRef = useRef(null);
      const [hidden, setHidden] = useState(0);
      useEffect(() => {
        const row = rowRef.current;
        if (!row) return undefined;
        const measure = () => {
          const tabs = [...row.querySelectorAll('.ah-ptab')];
          const top = tabs[0]?.offsetTop ?? 0;
          setHidden(tabs.filter((tab) => tab.offsetTop > top).length);
        };
        measure();
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(row);
        return () => observer.disconnect();
      }, [projects]);
      return h(
        'div',
        { className: 'ah-strip' },
        h(
          'button',
          { type: 'button', className: `ah-ptab ah-ptab-agents${agentActive ? ' is-active' : ''}`, onClick: onAgents, title: t('view.agentBrowse') },
          IconBot(),
          h('span', { className: 'ah-ptab-name' }, t('view.agent')),
        ),
        h('span', { className: 'ah-strip-sep' }),
        h(
          'div',
          { className: 'ah-strip-tabs', ref: rowRef },
          projects.length === 0
            ? h('span', { className: 'ah-strip-empty' }, t('strip.empty'))
            : projects.map((project) => {
                const key = pathKey(project.path);
                const stat = stats.get(key);
                const active = key === currentKey;
                return h(
                  'div',
                  {
                    key: project.path,
                    role: 'tab',
                    tabIndex: 0,
                    'aria-selected': active,
                    className: `ah-ptab${active ? ' is-active' : ''}${project.exists === false ? ' is-missing' : ''}`,
                    title: `${project.path}${stat ? `\n${t('project.sessions', { count: formatInt(stat.sessions) })}` : ''}`,
                    onClick: () => onPick(project.path),
                    onKeyDown: (event) => { if (event.key === 'Enter') onPick(project.path); },
                  },
                  h('span', { className: 'ah-ptab-icon' }, h(IconFolder, { size: 13 })),
                  h('span', { className: 'ah-ptab-name' }, project.name || nameOfPath(project.path)),
                  stat && stat.sessions > 0 ? h('span', { className: 'ah-ptab-count' }, formatInt(stat.sessions)) : null,
                  h(
                    'button',
                    {
                      type: 'button', className: 'ah-ptab-close', title: t('opened.remove'), 'aria-label': t('opened.remove'),
                      onClick: (event) => { event.stopPropagation(); onRemove(project); },
                    },
                    '×',
                  ),
                );
              }),
        ),
        h('button', { type: 'button', className: 'ah-strip-add', onClick: onOpenNew, title: t('action.openProject'), 'aria-label': t('action.openProject') }, h(IconPlus)),
        h(ProjectSwitcher, { ...menu, variant: 'menu', hoverOpen: true, label: hidden > 0 ? t('strip.more', { count: hidden }) : t('strip.all') }),
      );
    }

    /** Home: the most recently opened folders as cards (the full list lives in the switcher). */
    function RecentProjects(props) {
      const { t, locale, projects, stats, agents, onPick, onRemove, onShowAll } = props;
      const shown = projects.slice(0, 6);
      return h(
        'div',
        { className: 'ah-recent' },
        h(
          'div',
          { className: 'ah-picker-label ah-recent-head' },
          h('span', null, t('opened.title', { count: projects.length })),
          projects.length > shown.length ? h('button', { type: 'button', className: 'ah-link', onClick: onShowAll }, t('switcher.all')) : null,
        ),
        h(
          'div',
          { className: 'ah-recent-grid' },
          shown.map((project) => {
            const stat = stats.get(pathKey(project.path));
            const projectAgents = (stat?.agents || []).map((id) => agents.get(id)).filter(Boolean);
            return h(
              'div',
              {
                key: project.path, role: 'button', tabIndex: 0, title: project.path,
                className: `ah-recent-card ah-proj-row${project.exists === false ? ' is-missing' : ''}`,
                onClick: () => onPick(project.path),
                onKeyDown: (event) => { if (event.key === 'Enter') onPick(project.path); },
              },
              h(
                'div',
                { className: 'ah-recent-top' },
                h('span', { className: 'ah-recent-icon' }, h(IconFolder, { size: 15 })),
                h('span', { className: 'ah-recent-name' }, project.name || nameOfPath(project.path)),
                projectAgents.length > 0 ? h(AgentDots, { agents: projectAgents, max: 4 }) : null,
              ),
              h('div', { className: 'ah-recent-path' }, project.exists === false ? t('opened.missing') : project.path),
              h(
                'div',
                { className: 'ah-recent-meta' },
                stat && stat.sessions > 0 ? t('project.sessions', { count: formatInt(stat.sessions) }) : t('opened.noSessions'),
                stat && stat.updatedAt ? h('span', { className: 'ah-sep' }, '·') : null,
                stat && stat.updatedAt ? relTime(stat.updatedAt, locale) : null,
              ),
              h(
                'button',
                {
                  type: 'button', className: 'ah-row-remove', title: t('opened.remove'), 'aria-label': t('opened.remove'),
                  onClick: (event) => { event.stopPropagation(); onRemove(project); },
                },
                IconTrash(),
              ),
            );
          }),
        ),
      );
    }

    /** "By agent" overview: one card per agent with sessions in the current time range. */
    function AgentGrid(props) {
      const { t, locale, entries, onPick, onBack, rangeControl } = props;
      return h(
        'div',
        { className: 'ah-view' },
        h(
          'div',
          { className: 'ah-toolbar' },
          h('button', { type: 'button', className: 'ah-link ah-back', onClick: onBack }, IconChevronLeft(), h('span', null, t('action.backToProjects'))),
          h('span', { className: 'ah-toolbar-title' }, t('view.agentBrowse')),
          h('span', { className: 'ah-spacer' }),
          rangeControl,
        ),
        h(
          'div',
          { className: 'ah-view-body' },
          entries.length === 0
            ? h('div', { className: 'ah-empty-inline' }, t('state.noMatch'))
            : h(
                'div',
                { className: 'ah-agent-grid' },
                entries.map((entry) =>
                  h(
                    'button',
                    { key: entry.agent.id, type: 'button', className: 'ah-agent-card', onClick: () => onPick(entry.agent.id) },
                    h('i', { className: 'ah-agent-avatar is-large', style: { background: entry.agent.color || 'var(--dsw-alias-label-tertiary)' } }),
                    h(
                      'span',
                      { className: 'ah-row-main' },
                      h('span', { className: 'ah-row-title' }, entry.agent.name),
                      h('span', { className: 'ah-row-sub' }, `${t('agent.sessions', { count: formatInt(entry.count) })}${entry.lastAt ? ` · ${relTime(entry.lastAt, locale)}` : ''}`),
                    ),
                    h('span', { className: 'ah-row-icon' }, h(IconChevron)),
                  ),
                ),
              ),
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Project view (the primary screen)
    // ---------------------------------------------------------------------------------------

    function SortToggle(props) {
      const { value, onChange, t } = props;
      return h(Segmented, {
        value,
        onChange,
        ariaLabel: t('sort.label'),
        options: [
          { value: 'desc', label: t('sort.desc') },
          { value: 'asc', label: t('sort.asc') },
        ],
      });
    }

    /** Session cards rendered per step; a project with hundreds of sessions grows as the user scrolls. */
    const SESSION_PAGE = 80;

    /** First `count` sessions in display order (newest or oldest start first). */
    function firstSessions(sessions, order, count) {
      if (sessions.length <= count) return sessions;
      const sorted = [...sessions].sort((a, b) => (a.startedAt || a.updatedAt) - (b.startedAt || b.updatedAt));
      return order === 'asc' ? sorted.slice(0, count) : sorted.slice(-count);
    }

    /** How many sessions to render; reset when the list changes, raised to include a focused session. */
    function useSessionWindow(sessions, order, resetKey, focusId) {
      const [count, setCount] = useState(SESSION_PAGE);
      useEffect(() => setCount(SESSION_PAGE), [resetKey]);
      useEffect(() => {
        if (!focusId || sessions.length <= count) return;
        const sorted = [...sessions].sort((a, b) => (a.startedAt || a.updatedAt) - (b.startedAt || b.updatedAt));
        const index = sorted.findIndex((session) => session.id === focusId);
        if (index < 0) return;
        const position = order === 'asc' ? index : sorted.length - 1 - index;
        if (position >= count) setCount(position + 1 + SESSION_PAGE / 4);
      }, [focusId, sessions, order]);
      return [Math.min(count, sessions.length), () => setCount((value) => value + SESSION_PAGE)];
    }

    /** Renders more sessions when it scrolls into view; also a button for keyboards and old shells. */
    function MoreSessions(props) {
      const { t, shown, total, onMore } = props;
      const ref = useRef(null);
      const more = useRef(onMore);
      more.current = onMore;
      useEffect(() => {
        const node = ref.current;
        if (!node || typeof IntersectionObserver !== 'function') return undefined;
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) more.current();
        }, { rootMargin: '400px 0px' });
        observer.observe(node);
        return () => observer.disconnect();
      }, [shown]);
      if (shown >= total) return null;
      return h(
        'div',
        { className: 'ah-timeline-foot', ref },
        h('span', null, t('session.loadedCount', { shown, total })),
        h(Button, { variant: 'default', label: t('action.loadMore'), onClick: onMore }),
      );
    }

    function ProjectView(props) {
      const {
        project, sessions, agents, t, locale, selectedAgentId, onSelectAgent, tab, onTabChange,
        expandedId, onToggle, onContinue, onCopyCommand, transcripts, loadingIds,
        timeline, onLoadMoreTimeline, onFocusSession, deep, onToggleDeep, onCopyPath,
        sessionOrder, onSessionOrder, timelineQuery, onTimelineQuery,
      } = props;
      const bodyRef = useRef(null);
      const projectAgents = useMemo(() => {
        const ids = new Set(sessions.map((session) => session.agentId));
        return [...ids].map((id) => agents.get(id)).filter(Boolean);
      }, [sessions, agents]);
      const filtered = useMemo(
        () => (selectedAgentId === '' ? sessions : sessions.filter((session) => session.agentId === selectedAgentId)),
        [sessions, selectedAgentId],
      );
      const [searchDraft, setSearchDraft] = useState(timelineQuery.q);
      useEffect(() => setSearchDraft(timelineQuery.q), [timelineQuery.q]);
      useEffect(() => {
        if (searchDraft === timelineQuery.q) return undefined;
        const timer = setTimeout(() => onTimelineQuery({ ...timelineQuery, q: searchDraft }), 320);
        return () => clearTimeout(timer);
      }, [searchDraft]);
      useEffect(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = 0;
      }, [tab, sessionOrder, timelineQuery.order, timelineQuery.role, timelineQuery.q, selectedAgentId, project.path]);

      const messages = filtered.reduce((sum, session) => sum + session.messages, 0);
      const startedAt = filtered.reduce((min, session) => (min === 0 ? session.startedAt : Math.min(min, session.startedAt || min)), 0);
      const updatedAt = filtered.reduce((max, session) => Math.max(max, session.updatedAt), 0);
      const days = startedAt && updatedAt ? Math.max(1, Math.round((updatedAt - startedAt) / 86_400_000) + 1) : 0;
      const continueLabelFor = useCallback(
        (session) => {
          const agent = agents.get(session.agentId);
          if (!agent || !agent.resume || agent.resume.kind === 'none') return '';
          return agent.resume.kind === 'dsh' ? t('action.continueDsh') : t('action.continue');
        },
        [agents, t],
      );
      const messageFilterActive = timelineQuery.role !== 'all' || timelineQuery.q.trim() !== '';
      const [shownCount, showMore] = useSessionWindow(
        filtered, sessionOrder, `${project.path}|${selectedAgentId}|${sessionOrder}`, props.focusId,
      );
      const shownSessions = useMemo(() => firstSessions(filtered, sessionOrder, shownCount), [filtered, sessionOrder, shownCount]);
      return h(
        'div',
        { className: 'ah-view' },
        h(
          'div',
          { className: 'ah-proj-head' },
          h(
            'div',
            { className: 'ah-proj-title-row' },
            h('span', { className: 'ah-proj-icon' }, h(IconFolder, { size: 18 })),
            h('h2', { className: 'ah-proj-name', title: project.path }, project.name || t('project.unknown')),
            h(
              'button',
              { type: 'button', className: 'ah-path', onClick: () => onCopyPath(project.path), title: `${t('action.copyPath')}\n${project.path || ''}` },
              h('span', { className: 'ah-path-text' }, project.path || t('project.pathUnknown')),
              h(IconCopy),
            ),
            h('span', { className: 'ah-spacer' }),
            h(
              'label',
              { className: 'ah-check', title: t('project.subfoldersHint') },
              h('input', { type: 'checkbox', checked: deep, onChange: onToggleDeep }),
              h('span', null, t('project.subfolders')),
            ),
          ),
          h(
            'div',
            { className: 'ah-proj-stats' },
            h('span', { className: 'ah-stat' }, h('b', null, formatInt(filtered.length)), t('stat.sessions')),
            h('span', { className: 'ah-stat' }, h('b', null, formatInt(messages)), t('stat.messages')),
            h('span', { className: 'ah-stat' }, h('b', null, formatInt(projectAgents.length)), t('stat.agents')),
            days ? h('span', { className: 'ah-stat' }, h('b', null, formatInt(days)), t('stat.days')) : null,
            updatedAt ? h('span', { className: 'ah-stat is-quiet' }, t('stat.updated', { time: relTime(updatedAt, locale) })) : null,
          ),
          projectAgents.length > 1
            ? h(
                'div',
                { className: 'ah-chips' },
                h('button', { type: 'button', className: `ah-chip${selectedAgentId === '' ? ' is-active' : ''}`, onClick: () => onSelectAgent('') }, t('filter.allAgents')),
                projectAgents.map((agent) =>
                  h(
                    'button',
                    {
                      key: agent.id,
                      type: 'button',
                      className: `ah-chip${selectedAgentId === agent.id ? ' is-active' : ''}`,
                      onClick: () => onSelectAgent(selectedAgentId === agent.id ? '' : agent.id),
                      style: selectedAgentId === agent.id ? { color: agent.color, borderColor: `color-mix(in srgb, ${agent.color} 45%, transparent)` } : undefined,
                    },
                    h('i', { className: 'ah-dot', style: { background: agent.color } }),
                    agent.name,
                    h('span', { className: 'ah-chip-count' }, formatInt(sessions.filter((session) => session.agentId === agent.id).length)),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'ah-toolbar' },
          h(
            'div',
            { className: 'ah-tabs', role: 'tablist' },
            h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'sessions', className: `ah-tab${tab === 'sessions' ? ' is-active' : ''}`, onClick: () => onTabChange('sessions'), title: t('tab.tip.sessions') }, h(IconMessage), h('span', null, t('tab.sessions'))),
            h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'messages', className: `ah-tab${tab === 'messages' ? ' is-active' : ''}`, onClick: () => onTabChange('messages'), title: t('tab.tip.messages') }, h(IconTerminal), h('span', null, t('tab.messages'))),
          ),
          h('span', { className: 'ah-spacer' }),
          tab === 'messages'
            ? h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'ah-search ah-toolbar-search' },
                  h(IconSearch),
                  h('input', {
                    type: 'search', value: searchDraft, placeholder: t('timeline.search'), 'aria-label': t('timeline.search'),
                    onChange: (event) => setSearchDraft(event.target.value),
                  }),
                ),
                h(Segmented, {
                  value: timelineQuery.role,
                  onChange: (role) => onTimelineQuery({ ...timelineQuery, role }),
                  ariaLabel: t('role.label'),
                  options: [
                    { value: 'all', label: t('role.all') },
                    { value: 'user', label: t('role.user') },
                    { value: 'assistant', label: t('role.assistant') },
                  ],
                }),
                h(SortToggle, { t, value: timelineQuery.order, onChange: (order) => onTimelineQuery({ ...timelineQuery, order }) }),
              )
            : h(SortToggle, { t, value: sessionOrder, onChange: onSessionOrder }),
          props.rangeControl || null,
        ),
        h(
          'div',
          { className: 'ah-view-body', ref: bodyRef },
          filtered.length === 0
            ? h('div', { className: 'ah-empty-inline' }, t('state.noMatch'))
            : tab === 'sessions'
              ? h(
                  React.Fragment,
                  null,
                  h(ProjectTimeline, {
                    sessions: shownSessions, agents, t, locale, expandedId, onToggle, onContinue, onCopyCommand,
                    transcripts, loadingIds, continueLabelFor, focusId: props.focusId, order: sessionOrder,
                  }),
                  h(MoreSessions, { t, shown: shownSessions.length, total: filtered.length, onMore: showMore }),
                )
              : h(MessageTimeline, {
                  events: timeline?.events || [],
                  agents, t, locale,
                  onFocusSession,
                  loading: Boolean(timeline?.loading),
                  error: timeline?.error || '',
                  total: timeline?.total || 0,
                  shown: (timeline?.events || []).length,
                  onLoadMore: onLoadMoreTimeline,
                  sessionsTotal: timeline?.sessionsTotal || 0,
                  sessionsIncluded: timeline?.sessionsIncluded || 0,
                  failedSessions: timeline?.failedSessions || [],
                  truncatedSessions: timeline?.truncatedSessions || [],
                  filtered: messageFilterActive,
                }),
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Agent view (secondary screen)
    // ---------------------------------------------------------------------------------------

    function AgentView(props) {
      const { agent, sessions, agents, t, locale, expandedId, onToggle, onContinue, onCopyCommand, transcripts, loadingIds, continueLabelFor, onOpenProject, focusId, sessionOrder, onSessionOrder } = props;
      const byProject = useMemo(() => {
        const map = new Map();
        for (const session of sessions) {
          const key = pathKey(session.projectPath);
          if (!map.has(key)) map.set(key, { path: session.projectPath || '', list: [] });
          map.get(key).list.push(session);
        }
        return [...map.values()]
          .map((group) => ({ path: group.path, name: nameOfPath(group.path) || t('project.unknown'), sessions: group.list }))
          .sort((a, b) => Math.max(...b.sessions.map(sessionStatus)) - Math.max(...a.sessions.map(sessionStatus)));
      }, [sessions, t]);
      // Groups are rendered in order until the session budget is used up.
      const [budget, showMore] = useSessionWindow(sessions, sessionOrder, `${agent.id}|${sessionOrder}`, focusId);
      const visibleGroups = useMemo(() => {
        const out = [];
        let left = budget;
        for (const group of byProject) {
          if (left <= 0) break;
          const list = firstSessions(group.sessions, sessionOrder, left);
          out.push({ ...group, shown: list });
          left -= list.length;
        }
        return out;
      }, [byProject, budget, sessionOrder]);
      const shownTotal = visibleGroups.reduce((sum, group) => sum + group.shown.length, 0);
      return h(
        'div',
        { className: 'ah-view' },
        h(
          'div',
          { className: 'ah-proj-head' },
          h(
            'div',
            { className: 'ah-proj-title-row' },
            h('i', { className: 'ah-agent-avatar is-large', style: { background: agent.color || 'var(--dsw-alias-label-tertiary)' } }),
            h('h2', { className: 'ah-proj-name' }, agent.name),
            agent.resume && agent.resume.kind !== 'none'
              ? h('span', { className: 'ah-chip is-quiet' }, h(IconTerminal), agent.resume.kind === 'dsh' ? t('agent.dshSession') : `${agent.resume.command} resume`)
              : null,
          ),
          h(
            'div',
            { className: 'ah-proj-stats' },
            h('span', { className: 'ah-stat' }, h('b', null, formatInt(sessions.length)), t('stat.sessions')),
            h('span', { className: 'ah-stat' }, h('b', null, formatInt(sessions.reduce((sum, session) => sum + session.messages, 0))), t('stat.messages')),
            h('span', { className: 'ah-stat' }, h('b', null, formatInt(byProject.length)), t('stat.projects')),
          ),
        ),
        h(
          'div',
          { className: 'ah-toolbar' },
          props.onBack ? h('button', { type: 'button', className: 'ah-link ah-back', onClick: props.onBack }, IconChevronLeft(), h('span', null, t('view.agentBrowse'))) : null,
          h('span', { className: 'ah-toolbar-title' }, t('agent.byProject')),
          h('span', { className: 'ah-spacer' }),
          h(SortToggle, { t, value: sessionOrder, onChange: onSessionOrder }),
          props.rangeControl || null,
        ),
        h(
          'div',
          { className: 'ah-view-body' },
          byProject.length === 0
            ? h('div', { className: 'ah-empty-inline' }, t('agent.empty'))
            : visibleGroups.map((group) =>
                h(
                  'div',
                  { key: group.path || 'unknown', className: 'ah-agent-project' },
                  h(
                    'div',
                    { className: 'ah-agent-project-head' },
                    h('button', { type: 'button', className: 'ah-agent-project-title', onClick: () => onOpenProject(group.path), title: t('agent.openProject') }, h(IconFolder, { size: 14 }), h('span', null, group.name)),
                    h('span', { className: 'ah-agent-project-path' }, group.path || t('project.pathUnknown')),
                    h('span', { className: 'ah-row-meta' }, t('project.sessions', { count: group.sessions.length })),
                  ),
                  h(ProjectTimeline, { sessions: group.shown, agents, t, locale, expandedId, onToggle, onContinue, onCopyCommand, transcripts, loadingIds, continueLabelFor, focusId, order: sessionOrder }),
                ),
              ),
          byProject.length === 0 ? null : h(MoreSessions, { t, shown: shownTotal, total: sessions.length, onMore: showMore }),
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------------------------

    const AUTO_REFRESH_GAP_MS = 15_000;

    function AgentHistoryPage(props) {
      const { t, subscribeLocale, actions } = props;
      useLocaleTick(subscribeLocale);
      const locale = t.currentLocale ? t.currentLocale() : 'zh';
      const { snapshot, scannedAt, phase, error, scanning, scanStartedAt, generation, scan, load } = useSnapshot();
      const opened = useOpenedProjects();
      const rootRef = useRef(null);
      const lastAutoScan = useRef(Date.now());

      const [view, setView] = useState('project');
      const [range, setRange] = useState('all');
      const [selection, setSelection] = useState(null); // {kind:'project', path, name, deep} | {kind:'agent', id}
      const [selectedAgentId, setSelectedAgentId] = useState('');
      const [tab, setTab] = useState('sessions');
      const [sessionOrder, setSessionOrder] = useState('desc');
      const [timelineQuery, setTimelineQuery] = useState({ order: 'desc', role: 'all', q: '' });
      const [expandedId, setExpandedId] = useState('');
      const [focusId, setFocusId] = useState('');
      const [transcripts, setTranscripts] = useState(() => new Map());
      const [loadingIds, setLoadingIds] = useState(() => new Set());
      const [timeline, setTimeline] = useState(null);
      const [toast, setToast] = useState(null);
      const [elapsed, setElapsed] = useState(0);
      const [pickerOpen, setPickerOpen] = useState(false);
      const [switcherOpen, setSwitcherOpen] = useState(false);
      const [confirm, setConfirm] = useState(null);
      const [confirmBusy, setConfirmBusy] = useState(false);
      const toastTimer = useRef(null);
      const timelineSeq = useRef(0);

      const showToast = useCallback((text, kind = 'info') => {
        setToast({ text, kind });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 4200);
      }, []);
      useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

      // Opening the panel again (or returning to the window) refreshes, at most every 15s.
      useOnReveal(rootRef, () => {
        if (Date.now() - lastAutoScan.current < AUTO_REFRESH_GAP_MS) return;
        lastAutoScan.current = Date.now();
        scan();
        opened.reload();
      });

      useEffect(() => {
        if (!scanning || !scanStartedAt) {
          setElapsed(0);
          return undefined;
        }
        const timer = setInterval(() => setElapsed(Math.round((Date.now() - scanStartedAt) / 1000)), 1000);
        return () => clearInterval(timer);
      }, [scanning, scanStartedAt]);

      const agentMap = useMemo(() => {
        const map = new Map();
        for (const agent of snapshot?.agents || []) map.set(agent.id, agent);
        return map;
      }, [snapshot]);

      const cutoff = useMemo(() => {
        if (range === 'all') return 0;
        const days = Number(range) || 30;
        return Date.now() - days * 86_400_000;
      }, [range]);

      const rangedSessions = useMemo(() => {
        const list = (snapshot?.sessions || []).filter((session) => !cutoff || (session.updatedAt || 0) >= cutoff);
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        return list;
      }, [snapshot, cutoff]);

      /** Every project folder the scan found, used by the picker (never shown as "opened"). */
      const detectedProjects = useMemo(() => {
        const map = new Map();
        for (const session of snapshot?.sessions || []) {
          if (!session.projectPath) continue;
          const key = pathKey(session.projectPath);
          let entry = map.get(key);
          if (!entry) {
            entry = { key, path: normalizePath(session.projectPath), name: nameOfPath(session.projectPath), agents: [], sessions: 0, updatedAt: 0 };
            map.set(key, entry);
          }
          entry.sessions += 1;
          if (!entry.agents.includes(session.agentId)) entry.agents.push(session.agentId);
          entry.updatedAt = Math.max(entry.updatedAt, session.updatedAt || 0);
        }
        return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      }, [snapshot]);

      /** Session stats per opened folder (exact folder; subfolders when the row is opened deep). */
      const openedStats = useMemo(() => {
        const stats = new Map();
        for (const project of opened.projects) {
          const entry = { sessions: 0, agents: [], updatedAt: 0 };
          for (const session of rangedSessions) {
            if (!isUnder(project.path, session.projectPath)) continue;
            entry.sessions += 1;
            if (!entry.agents.includes(session.agentId)) entry.agents.push(session.agentId);
            entry.updatedAt = Math.max(entry.updatedAt, session.updatedAt || 0);
          }
          stats.set(pathKey(project.path), entry);
        }
        return stats;
      }, [opened.projects, rangedSessions]);

      // Tab order stays put while the page is open: newly opened folders are added at the front,
      // re-opening an existing one does not move it (the Host list itself is most-recent-first).
      const [tabOrder, setTabOrder] = useState([]);
      useEffect(() => {
        setTabOrder((current) => {
          const keys = opened.projects.map((project) => pathKey(project.path));
          const known = new Set(current);
          const fresh = keys.filter((key) => !known.has(key));
          const kept = current.filter((key) => keys.includes(key));
          const next = [...fresh, ...kept];
          return next.length === current.length && next.every((key, index) => key === current[index]) ? current : next;
        });
      }, [opened.projects]);
      const tabProjects = useMemo(() => {
        const byKey = new Map(opened.projects.map((project) => [pathKey(project.path), project]));
        return tabOrder.map((key) => byKey.get(key)).filter(Boolean);
      }, [tabOrder, opened.projects]);

      const openedKeys = useMemo(() => new Set(opened.projects.map((project) => pathKey(project.path))), [opened.projects]);


      const agentsWithSessions = useMemo(() => {
        const counts = new Map();
        const last = new Map();
        for (const session of rangedSessions) {
          counts.set(session.agentId, (counts.get(session.agentId) || 0) + 1);
          last.set(session.agentId, Math.max(last.get(session.agentId) || 0, session.updatedAt));
        }
        return [...counts.entries()]
          .map(([id, count]) => ({ agent: agentMap.get(id) || { id, name: id, color: '#8a8f98', status: 'ok', resume: { kind: 'none' } }, count, lastAt: last.get(id) || 0 }))
          .sort((a, b) => b.lastAt - a.lastAt);
      }, [rangedSessions, agentMap]);

      const sessionsById = useMemo(() => {
        const map = new Map();
        for (const session of snapshot?.sessions || []) map.set(session.id, session);
        return map;
      }, [snapshot]);

      /** Sessions of the currently open project (or agent). */
      const currentSessions = useMemo(() => {
        if (!selection) return [];
        if (selection.kind === 'agent') return rangedSessions.filter((session) => session.agentId === selection.id);
        return rangedSessions.filter((session) => (selection.deep
          ? isUnder(selection.path, session.projectPath)
          : samePath(session.projectPath, selection.path)));
      }, [selection, rangedSessions]);

      const continueLabelFor = useCallback(
        (session) => {
          const agent = agentMap.get(session.agentId);
          if (!agent || !agent.resume || agent.resume.kind === 'none') return '';
          return agent.resume.kind === 'dsh' ? t('action.continueDsh') : t('action.continue');
        },
        [agentMap, t],
      );

      /** Transcript requests in flight; a ref so two effects in one tick cannot both start one. */
      const transcriptRequests = useRef(new Set());
      const fetchTranscript = useCallback(
        async (session) => {
          if (transcriptRequests.current.has(session.id)) return;
          transcriptRequests.current.add(session.id);
          setLoadingIds((current) => new Set(current).add(session.id));
          try {
            const payload = await requestJson(`${API.session}?id=${encodeURIComponent(session.id)}`);
            const entry = { messages: payload.messages || [], supported: payload.supported, updatedAt: session.updatedAt };
            setTranscripts((current) => new Map(current).set(session.id, entry));
          } catch (transcriptError) {
            showToast(transcriptError instanceof Error ? transcriptError.message : String(transcriptError), 'error');
          } finally {
            transcriptRequests.current.delete(session.id);
            setLoadingIds((current) => {
              const next = new Set(current);
              next.delete(session.id);
              return next;
            });
          }
        },
        [showToast],
      );

      // A new scan only invalidates the transcripts of sessions that changed (or disappeared); an
      // unchanged session keeps what is on screen.
      useEffect(() => {
        if (generation === 0) return;
        setTranscripts((current) => {
          let changed = false;
          const next = new Map();
          for (const [id, entry] of current) {
            const session = sessionsById.get(id);
            if (session && session.updatedAt === entry.updatedAt) next.set(id, entry);
            else changed = true;
          }
          return changed ? next : current;
        });
      }, [generation]);

      // The expanded session always has its transcript: on first expand, and again after a scan
      // dropped a stale copy.
      const expandedSession = expandedId === '' ? null : sessionsById.get(expandedId) || null;
      useEffect(() => {
        if (expandedSession && !transcripts.has(expandedSession.id)) fetchTranscript(expandedSession);
      }, [expandedSession, transcripts, fetchTranscript]);

      const toggleSession = useCallback((sessionId) => {
        setExpandedId((current) => (current === sessionId ? '' : sessionId));
        setFocusId('');
      }, []);

      const focusSession = useCallback((sessionId) => {
        setTab('sessions');
        setExpandedId(sessionId);
        setFocusId(sessionId);
      }, []);

      // The merged timeline depends on which sessions are in scope and how far each has grown, so a
      // scan that changed nothing here keeps the loaded pages (and the scroll position).
      const sessionsSignature = useMemo(() => {
        let hash = 5381;
        for (const session of currentSessions) {
          const part = `${session.id}:${session.updatedAt}:${session.messages};`;
          for (let index = 0; index < part.length; index += 1) hash = ((hash * 33) ^ part.charCodeAt(index)) >>> 0;
        }
        return `${currentSessions.length}.${hash.toString(36)}`;
      }, [currentSessions]);

      const timelineKey = selection
        ? `${selection.kind === 'agent' ? `agent:${selection.id}` : `project:${pathKey(selection.path)}:${selection.deep ? 'deep' : 'exact'}`}|${selectedAgentId}|${timelineQuery.order}|${timelineQuery.role}|${timelineQuery.q.trim()}|${cutoff}|${sessionsSignature}`
        : '';

      const loadTimeline = useCallback(
        async (cursor) => {
          if (!selection) return;
          const key = timelineKey;
          const seq = ++timelineSeq.current;
          if (!cursor) setTimeline({ events: [], total: 0, loading: true, key });
          else setTimeline((current) => ({ ...(current || { events: [], total: 0 }), loading: true, key }));
          try {
            const candidates = currentSessions.filter((session) => session.messages > 0 && (selectedAgentId === '' || session.agentId === selectedAgentId));
            const included = candidates.slice(0, 120);
            const ids = included.map((session) => session.id).join(',');
            if (ids === '') {
              setTimeline({ events: [], total: 0, nextCursor: null, loading: false, key, sessionsTotal: 0, sessionsIncluded: 0 });
              return;
            }
            const params = new URLSearchParams({ ids, limit: '200', order: timelineQuery.order, role: timelineQuery.role });
            if (timelineQuery.q.trim() !== '') params.set('q', timelineQuery.q.trim());
            if (cursor) params.set('cursor', cursor);
            const payload = await requestJson(`${API.timeline}?${params.toString()}`);
            if (seq !== timelineSeq.current) return;
            if (cursor && payload.cursorLost) {
              loadTimeline();
              return;
            }
            setTimeline((current) => ({
              events: cursor ? [...((current?.events) || []), ...(payload.events || [])] : payload.events || [],
              total: payload.total || 0,
              nextCursor: payload.nextCursor || null,
              loading: false,
              key,
              sessionsTotal: candidates.length,
              sessionsIncluded: included.length,
              // Every page re-reads the chosen sessions, so the latest page's failures are current.
              failedSessions: payload.failedSessions || [],
              truncatedSessions: payload.truncatedSessions || [],
            }));
          } catch (timelineError) {
            if (seq !== timelineSeq.current) return;
            setTimeline({ events: [], total: 0, loading: false, key, error: timelineError instanceof Error ? timelineError.message : String(timelineError) });
          }
        },
        [selection, timelineKey, currentSessions, selectedAgentId, timelineQuery],
      );

      // Reset project-level state whenever the selection changes.
      useEffect(() => {
        setExpandedId('');
        setFocusId('');
        setSelectedAgentId('');
        setTimeline(null);
      }, [selection?.kind, selection?.id, selection?.path, selection?.deep]);

      useEffect(() => {
        if (selection && tab === 'messages' && (!timeline || timeline.key !== timelineKey)) loadTimeline();
      }, [selection, tab, timeline, timelineKey, loadTimeline]);

      const copyText = useCallback(
        async (value, message) => {
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(value);
            } else {
              const area = document.createElement('textarea');
              area.value = value;
              document.body.appendChild(area);
              area.select();
              document.execCommand('copy');
              document.body.removeChild(area);
            }
            showToast(message || t('action.copied'), 'ok');
          } catch {
            showToast(value, 'info');
          }
        },
        [showToast, t],
      );

      /**
       * The copied command comes from the Host, which quotes every argument for the platform's shell
       * and prefixes `cd <project>`; the card's own preview is display text only.
       */
      const copyResumeCommand = useCallback(
        async (session) => {
          try {
            const payload = await requestJson(API.launch, { method: 'POST', body: { sessionId: session.id, dryRun: true } });
            const command = typeof payload.copy === 'string' ? payload.copy : '';
            if (command === '') throw new Error(t('launch.unsupported'));
            await copyText(command, t('launch.copiedCmd'));
          } catch (copyError) {
            showToast(t('launch.failed', { error: copyError instanceof Error ? copyError.message : String(copyError) }), 'error');
          }
        },
        [copyText, showToast, t],
      );

      const continueSession = useCallback(
        async (session) => {
          const agent = agentMap.get(session.agentId);
          if (!agent || !agent.resume || agent.resume.kind === 'none') {
            showToast(t('launch.unsupported'), 'error');
            return;
          }
          if (agent.resume.kind === 'dsh') {
            const ok = actions?.openDshSession ? actions.openDshSession(session.nativeId) : false;
            showToast(ok ? t('launch.opened') : t('launch.dshMissing'), ok ? 'ok' : 'error');
            return;
          }
          try {
            const payload = await requestJson(API.launch, { method: 'POST', body: { sessionId: session.id } });
            if (payload.ok) showToast(t('launch.launched', { terminal: payload.terminal || 'Terminal' }), 'ok');
            else showToast(t('launch.failed', { error: payload.error || '' }), 'error');
          } catch (launchError) {
            showToast(t('launch.failed', { error: launchError instanceof Error ? launchError.message : String(launchError) }), 'error');
          }
        },
        [agentMap, actions, showToast, t],
      );

      /** Open one folder: record it in the history, then show it. Opened folders include subfolders. */
      const openProject = useCallback(
        async (path, options) => {
          const normalized = normalizePath(path);
          if (normalized === '') return;
          setPickerOpen(false);
          setSwitcherOpen(false);
          setView('project');
          setTab('sessions');
          setSelection({ kind: 'project', path: normalized, name: nameOfPath(normalized), deep: options?.deep !== false });
          const ok = await opened.open(normalized);
          if (!ok) showToast(t('opened.saveFailed'), 'error');
        },
        [opened, showToast, t],
      );

      const browseFolder = useCallback(async () => {
        if (!actions?.pickDirectory) {
          showToast(t('action.openFolderHint'), 'error');
          return;
        }
        const path = await actions.pickDirectory();
        if (path) openProject(path);
      }, [actions, openProject, showToast, t]);

      const confirmRemove = useCallback(async () => {
        if (!confirm) return;
        setConfirmBusy(true);
        try {
          await opened.remove(confirm.all ? { all: true } : { path: confirm.path });
          if (selection?.kind === 'project' && (confirm.all || samePath(selection.path, confirm.path))) setSelection(null);
          setConfirm(null);
        } catch (removeError) {
          showToast(removeError instanceof Error ? removeError.message : String(removeError), 'error');
        } finally {
          setConfirmBusy(false);
        }
      }, [confirm, opened, selection, showToast]);

      const scanNow = useCallback(async () => {
        lastAutoScan.current = Date.now();
        const result = await scan();
        if (typeof result === 'string' && result !== '') showToast(t('scan.failed', { error: result }), 'error');
      }, [scan, showToast, t]);

      // Cmd/Ctrl+O opens the project switcher while this panel is the visible one.
      useEffect(() => {
        const onKey = (event) => {
          if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || String(event.key).toLowerCase() !== 'o') return;
          const node = rootRef.current;
          if (!node || node.offsetParent === null || pickerOpen || confirm) return;
          event.preventDefault();
          setSwitcherOpen((value) => !value);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [pickerOpen, confirm]);

      useEffect(() => {
        if (!pickerOpen) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') setPickerOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [pickerOpen]);

      const headerStats = snapshot
        ? t('scan.summary', {
            sessions: formatInt(snapshot.totals?.sessions || 0),
            agents: formatInt(snapshot.totals?.agents || 0),
            projects: formatInt(snapshot.totals?.projects || 0),
          })
        : '';

      const rangeControl = h(RangeSelect, { t, value: range, onChange: setRange });
      const askRemove = (project) => setConfirm({ path: project.path, name: project.name || nameOfPath(project.path) });
      const currentAgent = selection?.kind === 'agent' ? agentMap.get(selection.id) : null;
      const mainBody = (() => {
        if (phase === 'loading') return h('div', { className: 'ah-loading' }, h(Spinner), h('span', null, t('state.loading')));
        if (phase === 'error' && !snapshot) {
          return h(EmptyState, {
            title: t('state.error.title'),
            body: error,
            icon: h(IconFolder, { size: 26 }),
            action: h(Button, { variant: 'primary', label: t('action.retry'), onClick: () => load().then(() => scan()) }),
          });
        }
        if (view === 'agent' && selection?.kind !== 'agent') {
          return h(AgentGrid, {
            t, locale, entries: agentsWithSessions, rangeControl,
            onPick: (id) => setSelection({ kind: 'agent', id }),
            onBack: () => { setView('project'); setSelection(null); },
          });
        }
        if (!selection) {
          return h(
            'div',
            { className: 'ah-home' },
            h(
              'div',
              { className: 'ah-home-head' },
              h('div', { className: 'ah-home-icon' }, h(IconFolder, { size: 24 })),
              h('div', { className: 'ah-home-text' },
                h('h3', { className: 'ah-home-title' }, t('state.noProject.title')),
                h('p', { className: 'ah-home-body' }, t('state.noProject.body'))),
            ),
            opened.projects.length > 0
              ? h(RecentProjects, {
                  t, locale, projects: opened.projects, stats: openedStats, agents: agentMap,
                  onPick: (path) => openProject(path), onRemove: askRemove, onShowAll: () => setSwitcherOpen(true),
                })
              : null,
            h(ProjectPicker, {
              t, locale, agents: agentMap, detected: detectedProjects, openedKeys,
              onPick: (path) => openProject(path), onBrowse: browseFolder,
            }),
          );
        }
        if (selection.kind === 'project') {
          const project = { path: selection.path, name: selection.name || nameOfPath(selection.path) || t('project.unknown') };
          if (currentSessions.length === 0) {
            return h(EmptyState, {
              title: t('state.noSessions.title'),
              body: scanning ? t('scan.running', { seconds: elapsed }) : t('state.noSessions.body'),
              icon: h(IconFolder, { size: 28 }),
              action: h(
                'div',
                { className: 'ah-empty-actions' },
                selection.deep ? null : h(Button, { variant: 'default', label: t('project.subfolders'), onClick: () => setSelection({ ...selection, deep: true }) }),
                h(Button, { variant: 'default', icon: h(IconPlus), label: t('action.openProject'), onClick: () => setPickerOpen(true) }),
              ),
            });
          }
          return h(ProjectView, {
            project,
            sessions: currentSessions,
            agents: agentMap,
            t,
            locale,
            selectedAgentId,
            onSelectAgent: setSelectedAgentId,
            tab,
            onTabChange: setTab,
            expandedId,
            onToggle: toggleSession,
            onContinue: continueSession,
            onCopyCommand: copyResumeCommand,
            transcripts,
            loadingIds,
            timeline,
            onLoadMoreTimeline: () => {
              if (timeline?.nextCursor && !timeline.loading) loadTimeline(timeline.nextCursor);
            },
            onFocusSession: focusSession,
            deep: Boolean(selection.deep),
            onToggleDeep: () => setSelection({ ...selection, deep: !selection.deep }),
            onCopyPath: (path) => copyText(path || '', t('action.copied')),
            focusId,
            sessionOrder,
            onSessionOrder: setSessionOrder,
            timelineQuery,
            onTimelineQuery: setTimelineQuery,
            rangeControl,
          });
        }
        const selectedAgent = agentMap.get(selection.id);
        if (selection.kind === 'agent' && selectedAgent) {
          return h(AgentView, {
            agent: selectedAgent,
            sessions: currentSessions,
            agents: agentMap,
            t,
            locale,
            expandedId,
            onToggle: toggleSession,
            onContinue: continueSession,
            onCopyCommand: copyResumeCommand,
            transcripts,
            loadingIds,
            continueLabelFor,
            focusId,
            sessionOrder,
            onSessionOrder: setSessionOrder,
            onOpenProject: (path) => { if (path) openProject(path, { deep: false }); },
            rangeControl,
            onBack: () => setSelection(null),
          });
        }
        return null;
      })();

      return h(
        'div',
        { className: 'ah-root', ref: rootRef },
        h('style', null, STYLES),
        h(
          'div',
          { className: 'ah-header', 'data-window-drag': true },
          h('span', { className: 'ah-brand-icon' }, h(AgentHistoryIcon, { size: 17 })),
          h(
            'div',
            { className: 'ah-header-title' },
            h('h1', { className: 'ah-title' }, t('page.title')),
            h('div', { className: 'ah-subtitle' }, t('page.subtitle')),
          ),
          h('span', { className: 'ah-spacer' }),
          h(
            'div',
            { className: 'ah-header-meta' },
            h('div', { className: 'ah-header-stats' }, headerStats),
            h(
              'div',
              { className: 'ah-header-scan' },
              scanning ? t('scan.running', { seconds: elapsed }) : scannedAt ? t('scan.at', { time: fullTime(scannedAt) }) : t('scan.never'),
            ),
          ),
          h(
            'div',
            { className: 'ah-header-actions' },
            h(Button, { variant: 'primary', icon: h(IconPlus), label: t('action.openProject'), onClick: () => setPickerOpen(true), title: t('action.openFolderHint') }),
            h(Button, { variant: 'default', icon: scanning ? h(Spinner) : h(IconRefresh), label: scanning ? t('action.refreshing') : t('action.refresh'), onClick: scanNow, disabled: scanning }),
          ),
        ),
        h(ProjectStrip, {
          t,
          projects: tabProjects,
          stats: openedStats,
          currentKey: selection?.kind === 'project' ? pathKey(selection.path) : '',
          agentActive: view === 'agent',
          onPick: (path) => openProject(path),
          onRemove: askRemove,
          onAgents: () => { setSwitcherOpen(false); setView('agent'); setSelection(null); },
          onOpenNew: () => { setSwitcherOpen(false); setPickerOpen(true); },
          menu: {
            t, locale,
            open: switcherOpen,
            onOpenChange: setSwitcherOpen,
            projects: opened.projects,
            stats: openedStats,
            agents: agentMap,
            currentKey: selection?.kind === 'project' ? pathKey(selection.path) : '',
            onPick: (path) => openProject(path),
            onRemove: askRemove,
            onOpenNew: () => { setSwitcherOpen(false); setPickerOpen(true); },
            onAgents: () => { setSwitcherOpen(false); setView('agent'); setSelection(null); },
            onClear: () => { setSwitcherOpen(false); setConfirm({ all: true, count: opened.projects.length }); },
          },
        }),
        scanning ? h('div', { className: 'ah-progress' }) : h('div', { className: 'ah-progress is-idle' }),
        h('div', { className: 'ah-body' }, h('div', { className: 'ah-main' }, mainBody)),
        pickerOpen
          ? h(
              'div',
              { className: 'ah-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) setPickerOpen(false); } },
              h(
                'div',
                { className: 'ah-dialog is-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('action.openProject') },
                h(
                  'div',
                  { className: 'ah-dialog-head' },
                  h('div', { className: 'ah-dialog-title' }, t('action.openProject')),
                  h('button', { type: 'button', className: 'ah-icon-btn', onClick: () => setPickerOpen(false), 'aria-label': t('action.cancel') }, '×'),
                ),
                h(ProjectPicker, {
                  t, locale, agents: agentMap, detected: detectedProjects, openedKeys, autoFocus: true,
                  onPick: (path) => openProject(path), onBrowse: browseFolder,
                }),
              ),
            )
          : null,
        confirm
          ? h(ConfirmDialog, {
              t,
              title: confirm.all ? t('opened.clearTitle') : t('opened.removeTitle'),
              body: confirm.all ? t('opened.clearBody', { count: confirm.count }) : t('opened.removeBody', { name: confirm.name, path: confirm.path }),
              confirmLabel: confirm.all ? t('opened.clear') : t('opened.remove'),
              busy: confirmBusy,
              onConfirm: confirmRemove,
              onCancel: () => { if (!confirmBusy) setConfirm(null); },
            })
          : null,
        toast ? h('div', { className: `ah-toast is-${toast.kind}` }, toast.text) : null,
      );
    }

    // ---------------------------------------------------------------------------------------
    // Sidebar icon
    // ---------------------------------------------------------------------------------------

    function AgentHistoryIcon(props) {
      const size = props?.size || 22;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M5 4.5v15', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', opacity: 0.9 }),
        h('path', { d: 'M8.5 7h7M8.5 12h10M8.5 17h6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', opacity: 0.55 }),
        h('circle', { cx: 5, cy: 7, r: 1.7, fill: 'currentColor' }),
        h('circle', { cx: 5, cy: 12, r: 1.7, fill: 'currentColor' }),
        h('circle', { cx: 5, cy: 17, r: 1.7, fill: 'currentColor' }),
      );
    }

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
      const optionalService = (name) => {
        try {
          return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
        } catch {
          return undefined;
        }
      };
      const actions = {
        openDshSession: (sessionId) => {
          const workspace = optionalService('uiWorkspace');
          if (!workspace || typeof workspace.openSession !== 'function') return false;
          try {
            workspace.openSession(sessionId);
            return true;
          } catch {
            return false;
          }
        },
        pickDirectory: () => {
          const workspace = optionalService('uiWorkspace');
          if (!workspace || typeof workspace.pickDirectory !== 'function') return Promise.resolve(null);
          return Promise.resolve(workspace.pickDirectory()).catch(() => null);
        },
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
              AgentHistoryIcon,
            ),
          ),
        );
        disposers.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                inject: () => ({ t, subscribeLocale, actions }),
              },
              AgentHistoryPage,
            ),
          ),
        );
      } catch (error) {
        console.error('[agent-history] panel registration failed:', error);
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
        'agent-history: ui mounts',
      );
    }

    // ---------------------------------------------------------------------------------------
    // Styles (host theme tokens only; plugin-prefixed classes)
    // ---------------------------------------------------------------------------------------

    const STYLES = `
.ah-root { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
.ah-header { flex: none; display: flex; align-items: center; gap: 14px; padding: 10px 16px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ah-header-title { min-width: 0; flex: 1; }
.ah-title { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; }
.ah-subtitle { margin-top: 1px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-header-meta { text-align: right; font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.4; white-space: nowrap; flex: none; }
.ah-header-stats { font-variant-numeric: tabular-nums; }
.ah-header-scan { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10.5px; }
.ah-header-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.ah-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary);
  border-radius: 8px; padding: 5px 11px; font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease; }
.ah-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.ah-btn:disabled { opacity: .55; cursor: default; }
.ah-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.ah-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.ah-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); filter: brightness(1.06); }
.ah-btn-small { padding: 3px 9px; font-size: 11.5px; border-radius: 7px; }
.ah-progress { flex: none; height: 2px; margin-top: -1px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); position: relative; }
.ah-progress::after { content: ""; position: absolute; inset: 0; width: 40%; border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)), transparent);
  animation: ah-slide 1.1s ease-in-out infinite; }
@keyframes ah-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
.ah-body { flex: 1; min-height: 0; display: flex; }
.ah-side { width: 292px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.ah-side-head { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 10px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ah-seg { display: inline-flex; padding: 2px; gap: 1px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.ah-seg-item { flex: 1; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 11.5px; padding: 3px 8px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
.ah-seg-item:hover { color: var(--dsw-alias-label-primary); }
.ah-seg-item.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.ah-search { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 28px; border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.ah-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; }
.ah-search input::placeholder { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.ah-search-clear { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 2px; }
.ah-side-list { flex: 1; min-height: 0; overflow: auto; padding: 6px; }
.ah-side-empty { padding: 18px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); text-align: center; }
.ah-side-foot { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ah-side-count { font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ah-select { appearance: none; -webkit-appearance: none; font-family: inherit; font-size: 11.5px; padding: 3px 20px 3px 8px; border-radius: 6px;
  color: var(--dsw-alias-label-primary); background-color: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2)); border: 1px solid var(--dsw-alias-border-l2); cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--dsw-alias-label-secondary) 50%), linear-gradient(135deg, var(--dsw-alias-label-secondary) 50%, transparent 50%);
  background-position: calc(100% - 11px) 52%, calc(100% - 7px) 52%; background-size: 4px 4px, 4px 4px; background-repeat: no-repeat; }
.ah-select:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.ah-row { display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; border: 1px solid transparent; background: transparent;
  border-radius: 8px; padding: 7px 8px; cursor: pointer; font-family: inherit; color: var(--dsw-alias-label-primary); }
.ah-row:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.ah-row.is-active { background: var(--dsw-alias-interactive-bg-selected, var(--dsw-alias-bg-layer-2)); border-color: var(--dsw-alias-border-l2); }
.ah-row:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.ah-row-icon { flex: none; margin-top: 1px; color: var(--dsw-alias-label-secondary); display: inline-flex; }
.ah-row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.ah-row-title { font-size: 12.5px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-row-sub { font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-row-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.ah-row-meta { font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ah-dots { display: inline-flex; align-items: center; gap: 2px; }
.ah-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
.ah-dots-more { font-size: 9.5px; color: var(--dsw-alias-label-secondary); }
.ah-agent-avatar { width: 10px; height: 10px; border-radius: 50%; flex: none; margin-top: 4px; display: inline-block; }
.ah-agent-avatar.is-large { width: 22px; height: 22px; margin-top: 0; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 8%, transparent); }
.ah-main { flex: 1; min-width: 0; min-height: 0; overflow: auto; background: var(--dsw-alias-bg-base); }
.ah-main-inner { padding: 14px 18px 22px; max-width: 1120px; }
.ah-proj-head { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ah-proj-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ah-proj-icon { color: var(--dsw-alias-label-secondary); display: inline-flex; flex: none; }
.ah-proj-name { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-path { display: inline-flex; align-items: center; gap: 5px; min-width: 0; border: 1px dashed transparent; border-radius: 6px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; padding: 2px 6px; max-width: 52%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-path:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.ah-proj-stats { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ah-sep { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); opacity: .6; }
.ah-deep-toggle { border: 0; background: transparent; color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); font-size: 11px; font-family: inherit; cursor: pointer; padding: 1px 4px; border-radius: 5px; }
.ah-deep-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.ah-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
.ah-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-family: inherit; cursor: pointer; white-space: nowrap; }
.ah-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.ah-chip.is-active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.ah-chip.is-quiet { cursor: default; background: transparent; }
.ah-chip.is-quiet:hover { color: var(--dsw-alias-label-secondary); border-color: var(--dsw-alias-border-l1); }
.ah-tabs { display: flex; align-items: center; gap: 4px; padding: 8px 0 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ah-tab { display: inline-flex; align-items: center; gap: 6px; border: 0; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0; background: transparent;
  color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; padding: 5px 10px; cursor: pointer; }
.ah-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.ah-tab.is-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); font-weight: 600; }
.ah-tab-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46%; }
.ah-spacer { flex: 1; }
.ah-day { display: flex; align-items: center; gap: 8px; padding: 14px 0 8px; }
.ah-day-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: .02em; white-space: nowrap; }
.ah-day-line { flex: 1; height: 1px; background: var(--dsw-alias-border-l1); }
.ah-day-count { font-size: 10px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); white-space: nowrap; }
.ah-cluster { display: flex; flex-direction: column; gap: 8px; }
.ah-cluster.is-parallel { margin: 2px 0 2px; padding: 6px 6px 6px 8px; border-radius: 10px;
  border-left: 2px dashed color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 50%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 4%, transparent); }
.ah-cluster-head { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--dsw-alias-label-secondary); padding-left: 2px; }
.ah-cluster-badge { font-size: 9.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px; border-radius: 999px;
  color: var(--dsw-alias-state-warn-primary, #d97706); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 14%, transparent); }
.ah-session { content-visibility: auto; contain-intrinsic-size: auto 118px; position: relative; display: flex; gap: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
  overflow: hidden; transition: border-color .12s ease, box-shadow .12s ease; }
.ah-session:hover { border-color: var(--dsw-alias-border-l2); }
.ah-session.is-open { border-color: var(--dsw-alias-border-l2); box-shadow: 0 2px 10px rgba(0,0,0,.06); }
.ah-rail { width: 3px; flex: none; }
.ah-session-body { flex: 1; min-width: 0; padding: 9px 12px 10px; display: flex; flex-direction: column; gap: 5px; }
.ah-session-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ah-agent-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 600; padding: 1px 8px 1px 6px;
  border-radius: 999px; border: 1px solid transparent; white-space: nowrap; flex: none; }
.ah-agent-badge.is-compact { padding: 1px 5px; }
.ah-session-title { min-width: 0; flex: 0 1 auto; border: 0; background: transparent; padding: 0; font-family: inherit; text-align: left; cursor: pointer;
  color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-session-title:hover { text-decoration: underline; text-underline-offset: 2px; }
.ah-parallel { font-size: 9.5px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; padding: 1px 6px; border-radius: 999px;
  color: var(--dsw-alias-state-warn-primary, #d97706); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 13%, transparent); flex: none; }
.ah-session-time { margin-left: auto; flex: none; font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ah-session-preview { font-size: 12px; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ah-session-meta { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); flex-wrap: wrap; }
.ah-link { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 10.5px; padding: 2px 5px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
.ah-link:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.ah-transcript-wrap { margin-top: 4px; border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.ah-transcript-source { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); min-width: 0; }
.ah-transcript-source code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-transcript { max-height: 460px; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
.ah-transcript-note { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.ah-transcript-loading { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); padding: 10px 2px; }
.ah-transcript-empty { font-size: 11.5px; color: var(--dsw-alias-label-secondary); padding: 10px 2px; }
.ah-tool-toggle { align-self: flex-start; border: 1px dashed var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 10.5px; padding: 2px 8px; border-radius: 6px; cursor: pointer; }
.ah-tool-toggle:hover { color: var(--dsw-alias-label-primary); }
.ah-msg { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 9px; background: var(--dsw-alias-bg-base); }
.ah-msg-user { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 6%, transparent); border-color: transparent; }
.ah-msg-tool-call, .ah-msg-tool-result { opacity: .82; }
.ah-msg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.ah-msg-role { font-size: 9px; font-weight: 700; letter-spacing: .06em; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.ah-msg-time { font-size: 9.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.ah-msg-text { font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); max-height: 320px; overflow: auto; }
.ah-msg-tool-call .ah-msg-text, .ah-msg-tool-result .ah-msg-text { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; color: var(--dsw-alias-label-secondary); max-height: 140px; }
.ah-timeline-messages { display: flex; flex-direction: column; gap: 2px; padding-top: 10px; }
.ah-tl { display: grid; grid-template-columns: 42px 3px minmax(0, 1fr); gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ah-tl:last-of-type { border-bottom: 0; }
.ah-tl-time { font-size: 10px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; padding-top: 2px; }
.ah-tl-rail { border-radius: 2px; }
.ah-tl-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ah-tl-head { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.ah-tl-agent { border: 0; background: transparent; padding: 0; font-family: inherit; font-size: 11px; font-weight: 650; cursor: pointer; white-space: nowrap; }
.ah-tl-agent:hover { text-decoration: underline; text-underline-offset: 2px; }
.ah-tl-session { font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46%; }
.ah-tl-role { margin-left: auto; font-size: 9px; font-weight: 700; letter-spacing: .06em; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); flex: none; }
.ah-tl-text { font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.ah-tl-user .ah-tl-text { color: var(--dsw-alias-label-primary); }
.ah-timeline-scope { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); padding: 2px 0 8px; }
.ah-timeline-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 2px 4px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.ah-agent-project { margin-top: 14px; }
.ah-agent-project-head { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; }
.ah-agent-project-title { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; padding: 0; font-family: inherit;
  font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
.ah-agent-project-title:hover { text-decoration: underline; text-underline-offset: 2px; }
.ah-agent-project-path { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.ah-empty { height: 100%; min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 32px 24px; text-align: center; }
.ah-empty-icon { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.ah-empty h3 { margin: 0; font-size: 15px; font-weight: 650; }
.ah-empty p { margin: 0; max-width: 520px; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.ah-empty-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; margin-top: 4px; }
.ah-empty-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); max-width: 560px; }
.ah-empty-inline { padding: 26px 10px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ah-loading { height: 100%; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.ah-spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor;
  display: inline-block; animation: ah-spin .8s linear infinite; flex: none; }
@keyframes ah-spin { to { transform: rotate(360deg); } }
.ah-toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 40; max-width: 70vw;
  padding: 8px 14px; border-radius: 9px; font-size: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary);
  animation: ah-toast-in .16s ease; }
.ah-toast.is-ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.ah-toast.is-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 45%, transparent); }
@keyframes ah-toast-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }
.ah-side-list::-webkit-scrollbar, .ah-main::-webkit-scrollbar, .ah-transcript::-webkit-scrollbar, .ah-msg-text::-webkit-scrollbar { width: 8px; height: 8px; }
.ah-side-list::-webkit-scrollbar-thumb, .ah-main::-webkit-scrollbar-thumb, .ah-transcript::-webkit-scrollbar-thumb, .ah-msg-text::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 28%, transparent); border-radius: 4px; }
.ah-home { padding: 26px 22px 20px; max-width: 900px; }
.ah-home-head { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.ah-home-icon { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.ah-home-title { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.ah-home-body { margin: 0; max-width: 620px; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.ah-home-recent { margin-top: 22px; }
.ah-home-recent-title { font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); margin-bottom: 8px; }
.ah-home-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(212px, 1fr)); gap: 8px; }
.ah-home-card { display: flex; flex-direction: column; gap: 4px; text-align: left; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  border-radius: 10px; padding: 9px 11px 10px; cursor: pointer; font-family: inherit; color: var(--dsw-alias-label-primary); min-width: 0; }
.ah-home-card:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.ah-home-card:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.ah-home-card-top { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--dsw-alias-label-secondary); }
.ah-home-card-name { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-home-card-path { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 9.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-home-card-meta { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ah-home-foot { margin-top: 22px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); max-width: 640px; line-height: 1.6; }
/* ---- Layout + density overrides (one screen: only inner regions scroll) ---- */
.ah-root { font-size: 13.5px; line-height: 1.55; --ah-accent: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.ah-root *, .ah-root *::before, .ah-root *::after { box-sizing: border-box; }
.ah-header { min-height: 60px; gap: 14px; padding: 10px 22px; }
html[data-platform=darwin] .ah-header { min-height: max(60px, var(--dsh-frame-top-clearance, 0px)); padding-left: max(22px, calc(var(--dsh-frame-leading-clearance, 0px) + 8px)); }
.ah-brand-icon { width: 34px; height: 34px; border-radius: 10px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  color: var(--ah-accent); background: color-mix(in srgb, var(--ah-accent) 12%, transparent); }
.ah-title { font-size: 16.5px; }
.ah-subtitle { font-size: 12px; margin-top: 2px; }
.ah-header-meta { font-size: 12px; }
.ah-header-scan { font-size: 11px; }
.ah-header-actions { gap: 10px; }
.ah-btn { padding: 6px 13px; font-size: 12.5px; border-radius: 9px; }
.ah-btn-small { padding: 4px 10px; font-size: 12px; border-radius: 8px; }
.ah-btn-default { background: transparent; }
.ah-btn-danger { background: var(--dsw-alias-state-error-primary, #dc2626); border-color: transparent; color: #fff; }
.ah-btn-danger:hover:not(:disabled) { filter: brightness(1.06); background: var(--dsw-alias-state-error-primary, #dc2626); }
.ah-progress.is-idle { background: transparent; }
.ah-progress.is-idle::after { display: none; }
.ah-side { width: 300px; }
.ah-side-head { gap: 10px; padding: 12px 12px 10px; border-bottom: 0; }
.ah-seg { width: 100%; }
.ah-seg-item { font-size: 12px; padding: 4px 10px; }
.ah-search { height: 32px; border-radius: 8px; padding: 0 10px; }
.ah-search input { font-size: 12.5px; }
.ah-side-label { flex: none; padding: 4px 16px 6px; font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.ah-side-list { padding: 0 8px 8px; display: flex; flex-direction: column; gap: 2px; }
.ah-side-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 28px 12px; font-size: 12.5px; }
.ah-side-foot { padding: 10px 12px; }
.ah-select { font-size: 12px; padding: 4px 22px 4px 9px; border-radius: 7px; }
.ah-row { position: relative; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 10px; }
.ah-row-title { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.ah-row-sub { font-size: 11px; }
.ah-row-meta { font-size: 11px; }
.ah-row.is-active { background: color-mix(in srgb, var(--ah-accent) 10%, transparent); border-color: color-mix(in srgb, var(--ah-accent) 35%, transparent); }
.ah-row.is-active .ah-row-icon { color: var(--ah-accent); }
.ah-row.is-missing .ah-row-sub { color: var(--dsw-alias-state-warn-primary); }
.ah-row-remove { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 26px; height: 26px; border: 0; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1); transition: opacity .1s ease; }
.ah-proj-row:hover .ah-row-remove, .ah-proj-row:focus-within .ah-row-remove { opacity: 1; }
.ah-proj-row:hover .ah-row-side, .ah-proj-row:focus-within .ah-row-side { visibility: hidden; }
.ah-row-remove:hover { color: var(--dsw-alias-state-error-primary, #dc2626); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 12%, var(--dsw-alias-bg-layer-1)); }
.ah-link.is-danger { color: var(--dsw-alias-state-error-primary, #dc2626); font-size: 12px; }
.ah-main { overflow: hidden; display: flex; flex-direction: column; }
.ah-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ah-proj-head { flex: none; gap: 10px; padding: 16px 22px 12px; border-bottom: 0; }
.ah-proj-title-row { gap: 10px; }
.ah-proj-icon { color: var(--ah-accent); }
.ah-proj-name { font-size: 18px; }
.ah-path { max-width: 50%; font-size: 11.5px; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.ah-path-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ah-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; flex: none; }
.ah-proj-stats { gap: 18px; font-size: 12px; }
.ah-stat { display: inline-flex; align-items: baseline; gap: 4px; }
.ah-stat b { font-size: 16px; font-weight: 650; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.ah-stat.is-quiet { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.ah-chips { gap: 8px; padding-top: 0; }
.ah-chip { font-size: 12px; padding: 3px 10px; }
.ah-chip.is-active { background: color-mix(in srgb, var(--ah-accent) 10%, transparent); border-color: color-mix(in srgb, var(--ah-accent) 40%, transparent); }
.ah-chip.is-tiny { font-size: 10.5px; padding: 0 6px; font-weight: 500; }
.ah-chip-count { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.ah-toolbar { flex: none; display: flex; align-items: center; gap: 10px; padding: 0 22px; border-bottom: 1px solid var(--dsw-alias-border-l1); min-height: 46px; flex-wrap: wrap; }
.ah-toolbar .ah-seg { width: auto; }
.ah-toolbar-title { font-size: 13px; font-weight: 600; }
.ah-toolbar-search { width: 220px; height: 30px; }
.ah-tabs { padding: 0; border-bottom: 0; align-self: stretch; gap: 6px; }
.ah-tab { font-size: 13px; padding: 10px 12px 11px; border-radius: 0; height: 100%; }
.ah-view-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 22px 22px; }
.ah-day { padding: 16px 0 10px; }
.ah-day-label { font-size: 12px; }
.ah-day-count { font-size: 11px; }
.ah-cluster { gap: 10px; }
.ah-cluster-head { font-size: 11px; }
.ah-session { border-radius: 12px; }
.ah-session-body { padding: 12px 14px 12px; gap: 7px; }
.ah-session-title { font-size: 13.5px; }
.ah-session-time { font-size: 11.5px; }
.ah-session-preview { font-size: 12.5px; line-height: 1.55; }
.ah-session-meta { font-size: 11.5px; }
.ah-link { font-size: 11.5px; padding: 3px 6px; }
.ah-agent-badge { font-size: 11px; padding: 2px 9px 2px 7px; }
.ah-msg { padding: 8px 11px; border-radius: 10px; }
.ah-msg-text { font-size: 12.5px; line-height: 1.6; }
.ah-msg-role { font-size: 10px; }
.ah-msg-time { font-size: 10.5px; }
.ah-timeline-messages { gap: 0; padding-top: 0; }
.ah-tl { grid-template-columns: 46px 3px minmax(0, 1fr); gap: 12px; padding: 10px 0; }
.ah-tl-time { font-size: 11.5px; padding-top: 1px; }
.ah-tl-agent { font-size: 12px; }
.ah-tl-session { font-size: 11.5px; }
.ah-tl-role { font-size: 10.5px; font-weight: 600; letter-spacing: 0; padding: 0 7px; border-radius: 999px; line-height: 18px; }
.ah-tl-role.is-user { color: var(--ah-accent); background: color-mix(in srgb, var(--ah-accent) 12%, transparent); }
.ah-tl-role.is-assistant { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.ah-tl-text { font-size: 12.5px; line-height: 1.6; }
.ah-timeline-scope { font-size: 11.5px; padding: 10px 0 0; }
.ah-timeline-foot { font-size: 11.5px; padding: 14px 0 4px; }
.ah-empty-inline { font-size: 13px; padding: 40px 10px; }
.ah-empty-inline.is-error { color: var(--dsw-alias-state-error-primary, #dc2626); }
.ah-empty { min-height: 0; flex: 1; }
.ah-empty h3 { font-size: 16px; }
.ah-empty p { font-size: 13px; }
.ah-agent-project { margin-top: 18px; }
.ah-agent-project-title { font-size: 13.5px; }
.ah-agent-project-path { font-size: 11px; }
.ah-home { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 18px; padding: 26px 26px 20px; max-width: 1040px; width: 100%; }
.ah-home-head { flex: none; flex-direction: row; align-items: center; gap: 14px; }
.ah-home-icon { width: 48px; height: 48px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  color: var(--ah-accent); background: color-mix(in srgb, var(--ah-accent) 11%, transparent); }
.ah-home-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ah-home-title { font-size: 18px; }
.ah-home-body { font-size: 13px; }
.ah-picker { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.ah-picker-top { flex: none; display: flex; align-items: center; gap: 10px; }
.ah-picker-search { flex: 1; min-width: 0; }
.ah-picker-label { flex: none; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); padding: 4px 2px 0; }
.ah-picker-list { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; align-content: start; padding: 1px 2px 2px; }
.ah-picker-item { display: flex; align-items: center; gap: 10px; text-align: left; min-width: 0; padding: 11px 12px; border-radius: 12px; cursor: pointer;
  font-family: inherit; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.ah-picker-item:hover { border-color: color-mix(in srgb, var(--ah-accent) 40%, transparent); background: color-mix(in srgb, var(--ah-accent) 5%, var(--dsw-alias-bg-layer-1)); }
.ah-picker-item:focus-visible { outline: 2px solid var(--ah-accent); outline-offset: 1px; }
.ah-overlay { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 28px;
  background: color-mix(in srgb, #000 34%, transparent); }
.ah-dialog { width: min(440px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 18px 20px 16px; border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2)); box-shadow: 0 24px 60px rgba(0,0,0,.28); }
.ah-dialog.is-picker { width: min(920px, 100%); height: min(680px, 100%); }
.ah-dialog-head { flex: none; display: flex; align-items: center; justify-content: space-between; }
.ah-dialog-title { font-size: 16px; font-weight: 650; }
.ah-dialog-body { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.ah-dialog-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.ah-icon-btn { width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; font-size: 18px; color: var(--dsw-alias-label-secondary); }
.ah-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.ah-view-body::-webkit-scrollbar, .ah-picker-list::-webkit-scrollbar { width: 8px; }
.ah-view-body::-webkit-scrollbar-thumb, .ah-picker-list::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dsw-alias-label-secondary) 28%, transparent); border-radius: 4px; }
@media (max-width: 1180px) { .ah-toolbar-search { width: 160px; } .ah-subtitle { display: none; } }
@media (max-width: 980px) { .ah-side { width: 248px; } .ah-picker-list { grid-template-columns: minmax(0, 1fr); } }
/* ---- No left column: header project switcher ---- */
.ah-header { gap: 12px; }
.ah-title { flex: none; font-size: 15.5px; }
.ah-header-divider { width: 1px; height: 22px; flex: none; background: var(--dsw-alias-border-l2); }
.ah-switcher { position: relative; min-width: 0; flex: 0 1 auto; }
.ah-switcher-btn { display: flex; align-items: center; gap: 9px; min-width: 220px; max-width: 440px; height: 40px; padding: 0 10px 0 8px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-family: inherit; cursor: pointer; text-align: left; transition: border-color .12s ease, background .12s ease; }
.ah-switcher-btn:hover, .ah-switcher-btn.is-open { border-color: color-mix(in srgb, var(--ah-accent) 45%, transparent); }
.ah-switcher-btn:focus-visible { outline: 2px solid var(--ah-accent); outline-offset: 1px; }
.ah-switcher-icon { width: 26px; height: 26px; flex: none; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center;
  color: var(--ah-accent); background: color-mix(in srgb, var(--ah-accent) 11%, transparent); }
.ah-switcher-text { min-width: 0; flex: 1; display: flex; flex-direction: column; line-height: 1.25; }
.ah-switcher-label { font-size: 13px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-switcher-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.ah-switcher-chev { flex: none; color: var(--dsw-alias-label-secondary); display: inline-flex; }
.ah-switcher-pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; width: 460px; max-height: min(560px, calc(100vh - 120px));
  display: flex; flex-direction: column; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2)); box-shadow: 0 18px 48px rgba(0,0,0,.22); animation: ah-pop-in .12s ease-out; }
@keyframes ah-pop-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.ah-switcher-search { margin: 10px 10px 4px; }
.ah-switcher-label-row { padding: 6px 16px 4px; font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.ah-switcher-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 6px 6px; display: flex; flex-direction: column; gap: 1px; }
.ah-switcher-item { position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; cursor: pointer; border: 1px solid transparent; }
.ah-switcher-item.is-cursor { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); }
.ah-switcher-item.is-active { border-color: color-mix(in srgb, var(--ah-accent) 35%, transparent); }
.ah-switcher-item.is-active .ah-row-icon { color: var(--ah-accent); }
.ah-switcher-item.is-missing .ah-row-sub { color: var(--dsw-alias-state-warn-primary); }
.ah-switcher-item:hover .ah-row-remove, .ah-switcher-item.is-cursor .ah-row-remove { opacity: 1; }
.ah-switcher-item:hover .ah-row-side, .ah-switcher-item.is-cursor .ah-row-side { visibility: hidden; }
.ah-switcher-foot { flex: none; display: flex; flex-direction: column; padding: 6px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ah-switcher-action { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; cursor: pointer;
  font-family: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary); text-align: left; }
.ah-switcher-action:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); }
.ah-switcher-action.is-danger { color: var(--dsw-alias-state-error-primary, #dc2626); }
.ah-switcher-action kbd { margin-left: auto; font-family: inherit; font-size: 11px; padding: 1px 6px; border-radius: 5px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); border: 1px solid var(--dsw-alias-border-l2); }
.ah-main { flex: 1; }
.ah-home { max-width: none; padding: 24px 28px 20px; gap: 16px; }
.ah-recent { flex: none; display: flex; flex-direction: column; gap: 8px; }
.ah-recent-head { display: flex; align-items: center; justify-content: space-between; }
.ah-recent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; max-height: 196px; overflow: hidden; }
.ah-recent-card { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 12px; cursor: pointer; min-width: 0;
  border: 1px solid color-mix(in srgb, var(--ah-accent) 22%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--ah-accent) 4%, var(--dsw-alias-bg-layer-1)); }
.ah-recent-card:hover { border-color: color-mix(in srgb, var(--ah-accent) 50%, transparent); }
.ah-recent-card:focus-visible { outline: 2px solid var(--ah-accent); outline-offset: 1px; }
.ah-recent-card .ah-row-remove { top: 10px; transform: none; }
.ah-recent-card:hover .ah-dots, .ah-recent-card:focus-within .ah-dots { visibility: hidden; }
.ah-recent-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ah-recent-icon { color: var(--ah-accent); display: inline-flex; flex: none; }
.ah-recent-name { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-recent-path { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-recent-card.is-missing .ah-recent-path { color: var(--dsw-alias-state-warn-primary); }
.ah-recent-meta { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ah-back { font-size: 12.5px; padding: 4px 8px 4px 4px; color: var(--dsw-alias-label-secondary); }
.ah-agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; padding-top: 16px; }
.ah-agent-card { display: flex; align-items: center; gap: 12px; padding: 14px 14px; border-radius: 12px; cursor: pointer; text-align: left; font-family: inherit;
  color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.ah-agent-card:hover { border-color: color-mix(in srgb, var(--ah-accent) 40%, transparent); }
.ah-agent-card .ah-agent-avatar.is-large { margin: 0; }
@media (max-width: 1180px) { .ah-header-meta { display: none; } }
@media (max-width: 900px) { .ah-title, .ah-header-divider { display: none; } .ah-switcher-btn { min-width: 0; } .ah-switcher-pop { width: min(460px, 86vw); } }
/* ---- Recent-projects tab strip (one compact row under the header) ---- */
.ah-header { min-height: 56px; }
html[data-platform=darwin] .ah-header { min-height: max(56px, var(--dsh-frame-top-clearance, 0px)); }
.ah-strip { flex: none; display: flex; align-items: center; gap: 6px; height: 38px; padding: 0 16px 0 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.ah-strip-tabs { flex: 1; min-width: 0; height: 28px; display: flex; flex-wrap: wrap; gap: 4px; overflow: hidden; align-items: center; }
.ah-strip-sep { width: 1px; height: 16px; flex: none; background: var(--dsw-alias-border-l2); margin: 0 4px; }
.ah-strip-empty { font-size: 12px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); line-height: 28px; padding-left: 4px; }
.ah-ptab { position: relative; flex: none; display: inline-flex; align-items: center; gap: 6px; height: 28px; max-width: 220px; padding: 0 9px 0 9px;
  border: 1px solid transparent; border-radius: 8px; background: transparent; cursor: pointer; font-family: inherit; font-size: 12.5px;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; transition: background .1s ease, color .1s ease; }
.ah-ptab:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.ah-ptab:focus-visible { outline: 2px solid var(--ah-accent); outline-offset: -1px; }
.ah-ptab.is-active { color: var(--dsw-alias-label-primary); font-weight: 600; background: var(--dsw-alias-bg-base);
  border-color: color-mix(in srgb, var(--ah-accent) 38%, transparent); box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.ah-ptab.is-active .ah-ptab-icon { color: var(--ah-accent); }
.ah-ptab.is-missing .ah-ptab-name { text-decoration: line-through; opacity: .7; }
.ah-ptab-icon { display: inline-flex; flex: none; }
.ah-ptab-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ah-ptab-count { flex: none; font-size: 10.5px; font-weight: 500; font-variant-numeric: tabular-nums; padding: 0 5px; border-radius: 999px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); background: var(--dsw-alias-bg-layer-2); }
.ah-ptab-close { flex: none; width: 16px; height: 16px; margin-right: -3px; border: 0; border-radius: 4px; padding: 0; background: transparent; cursor: pointer;
  font-size: 13px; line-height: 16px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); display: none; }
.ah-ptab:hover .ah-ptab-close, .ah-ptab:focus-within .ah-ptab-close { display: inline-block; }
.ah-ptab:hover .ah-ptab-count, .ah-ptab:focus-within .ah-ptab-count { display: none; }
.ah-ptab-close:hover { color: var(--dsw-alias-state-error-primary, #dc2626); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 12%, transparent); }
.ah-ptab-agents { color: var(--dsw-alias-label-secondary); }
.ah-strip-add { flex: none; width: 28px; height: 28px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); display: inline-flex; align-items: center; justify-content: center; }
.ah-strip-add:hover { color: var(--ah-accent); border-color: color-mix(in srgb, var(--ah-accent) 50%, transparent); }
.ah-switcher.is-menu { flex: none; }
.ah-strip-more { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-base); cursor: pointer; font-family: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.ah-strip-more:hover, .ah-strip-more.is-open { border-color: color-mix(in srgb, var(--ah-accent) 45%, transparent); color: var(--ah-accent); }
.ah-strip-count { font-size: 10.5px; font-variant-numeric: tabular-nums; padding: 0 5px; border-radius: 999px; line-height: 16px;
  color: var(--ah-accent); background: color-mix(in srgb, var(--ah-accent) 12%, transparent); }
.ah-switcher-pop.is-right { left: auto; right: 0; top: calc(100% + 4px); }
.ah-switcher.is-menu .ah-switcher-pop::before { content: ""; position: absolute; left: 0; right: 0; top: -8px; height: 8px; }
@media (max-width: 980px) {
  .ah-side { width: 232px; }
  .ah-tab-hint { display: none; }
  .ah-header-meta { display: none; }
}
@media (max-width: 720px) {
  .ah-side { width: 196px; }
  .ah-header { gap: 8px; padding: 8px 10px; }
  .ah-subtitle { display: none; }
}
`;

    return { inject, apply };
  },
});
