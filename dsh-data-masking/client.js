/**
 * Data Masking — Client half.
 *
 * Left-sidebar entry + one page with four tabs:
 *   概览      status, protection scope, how it works, per-category counts
 *   词库与规则 dictionaries per category, ID-segment / regex rules, built-ins, allowlist, network tools
 *   试一试    live preview of the (unsaved) draft rules on pasted text
 *   拦截记录  interception history (category, length, short preview — never the values)
 * Data comes from the plugin's loopback JSON API (/api/dsh-data-masking/*).
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-data-masking',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // <shared-client:ui-kit>
    // GENERATED from shared/client/ui-kit.js. Edit that file, then run: node scripts/sync-shared.mjs
    /*
     * Client pieces every panel shares. Each plugin's client.js is one self-contained module, so
     * scripts/sync-shared.mjs inlines this file between the `<shared-client:ui-kit>` markers; edit it
     * here, then run `node scripts/sync-shared.mjs`. Expects `React` in scope.
     */

    /**
     * Tokens and motion rules shared by every panel (`root` is the panel's root selector):
     * - one header height, motion durations and easing for all four panels;
     * - exit animations for overlays (`dshp-exit-*` classes, paired with usePresence);
     * - prefers-reduced-motion: animations and transitions collapse to an instant change.
     */
    function sharedPanelCss(root) {
      return `
    ${root} { --dshp-header-h: 52px; --dshp-dur-fast: .12s; --dshp-dur: .16s; --dshp-ease-out: cubic-bezier(.2, .8, .2, 1); }
    ${root} .dshp-exit-fade { animation: dshp-fade-out var(--dshp-dur) var(--dshp-ease-out) forwards; pointer-events: none; }
    ${root} .dshp-exit-pop { animation: dshp-pop-out var(--dshp-dur) var(--dshp-ease-out) forwards; pointer-events: none; }
    ${root} .dshp-exit-drawer { animation: dshp-drawer-out var(--dshp-dur) var(--dshp-ease-out) forwards; pointer-events: none; }
    @keyframes dshp-fade-out { from { opacity: 1; } to { opacity: 0; } }
    @keyframes dshp-pop-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(4px) scale(.985); } }
    @keyframes dshp-drawer-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(16px); } }
    @media (prefers-reduced-motion: reduce) {
      ${root} *, ${root} *::before, ${root} *::after {
        animation-duration: .01ms !important; animation-iteration-count: 1 !important;
        transition-duration: .01ms !important; scroll-behavior: auto !important;
      }
    }
    `;
    }

    function prefersReducedMotion() {
      try {
        return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch {
        return false;
      }
    }

    /**
     * Keeps an overlay mounted for `ms` after `value` turns falsy, flagged `exiting`, so it can play an
     * exit animation instead of vanishing. `value` may be a boolean or the object the overlay renders
     * from (the last one is kept while exiting).
     * @returns {{ value: any, exiting: boolean }}
     */
    function usePresence(value, ms = 160) {
      const [kept, setKept] = React.useState(value || null);
      const live = Boolean(value);
      React.useEffect(() => {
        if (live) {
          setKept(value);
          return undefined;
        }
        if (!kept) return undefined;
        const timer = setTimeout(() => setKept(null), prefersReducedMotion() ? 0 : ms);
        return () => clearTimeout(timer);
      }, [live, value]);
      return { value: live ? value : kept, exiting: !live && Boolean(kept) };
    }
    // </shared-client:ui-kit>
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'data-masking';
    const API = '/api/dsh-data-masking';

    // ---------------------------------------------------------------------------------------
    // Copy (zh is the source language, en mirrors every key)
    // ---------------------------------------------------------------------------------------

    const zh = {
      'page.title': '数据脱敏',
      'page.subtitle': '发给模型前把敏感信息换成占位符，回复时自动还原',
      'switch.on': '脱敏已开启',
      'switch.off': '脱敏已关闭',
      'switch.unknown': '状态未知',
      'session.protected': '当前会话受保护：发给模型的内容已脱敏，Session Log 不上传',
      'session.protectedOff': '当前会话曾受保护：Session Log 仍不上传，但脱敏已关闭',
      'session.pending': '当前会话的下一次模型请求起开始脱敏',
      'session.off': '脱敏已关闭，当前会话的请求以原文发送',
      'history.thisSession': '仅本会话',
      'guide.description': '配置词库与规则，查看本会话的拦截记录',
      'off.title': '关闭脱敏？',
      'off.body': '关闭后，所有会话的后续请求都会以原文发给模型，包括已受保护会话里的历史消息；受保护会话仍不会上传 Session Log。',
      'off.confirm': '关闭脱敏',
      'tab.overview': '概览',
      'tab.rules': '词库与规则',
      'tab.try': '试一试',
      'tab.history': '拦截记录',
      'state.loading': '正在读取…',
      'state.error': '读取失败：{error}',
      'action.retry': '重试',
      'action.save': '保存',
      'action.saving': '保存中',
      'action.discard': '放弃修改',
      'action.add': '添加',
      'action.remove': '删除',
      'action.clear': '清空记录',
      'action.clearConfirm': '确认清空',
      'action.cancel': '取消',
      'action.refresh': '刷新',
      'alert.rulesError': '规则文件有误，所有模型请求已被阻止',
      'alert.rulesErrorHint': '在「词库与规则」中重新填写并保存即可覆盖错误的文件，保存后脱敏保持开启。',
      'alert.protectedError': '受保护会话列表无法读取，所有模型请求已被阻止',
      'alert.seam': '当前 DSH 版本缺少脱敏所需的内部接口',
      'alert.seamHint': '开启脱敏时所有模型请求都会被阻止，请升级插件或关闭脱敏。',
      'alert.guard': 'Session Log 上传保护未就绪',
      'alert.guardHint': '开启脱敏时会阻止模型请求，直到保护就绪。重启 DSH 通常可以恢复。',
      'alert.empty': '脱敏已开启，但还没有任何词条或规则',
      'alert.emptyHint': '到「词库与规则」添加需要保护的区域、部门、术语、人员、地址或 ID 段。',
      'kpi.sessions': '受保护会话',
      'kpi.sessionsHint': '这些会话的 Session Log 永不上传',
      'kpi.masked': '脱敏请求',
      'kpi.maskedHint': '近 24 小时 {n} 次',
      'kpi.terms': '词条与规则',
      'kpi.termsHint': '{terms} 个词条 · {rules} 条规则',
      'kpi.blocked': '已拦截',
      'kpi.blockedHint': '请求 {req} · 工具调用 {tool}',
      'scope.title': '保护范围',
      'scope.native': 'DSH 原生会话、子 Agent、会话标题与自动压缩',
      'scope.nativeHint': '所有经由 DSH 模型通道的请求',
      'scope.sessionLog': 'Session Log 上传',
      'scope.sessionLogHint': '受保护的会话不再随请求上传原始日志；关闭脱敏后这一点仍保持，但消息本身会以原文发送',
      'scope.tools': '出网工具',
      'scope.toolsHint': '{tools} 的参数含受保护数据时拦截',
      'scope.restore': '本地工具与界面',
      'scope.restoreHint': '回复中的占位符还原为原文，改代码、写文件、会话记录都是真实值',
      'scope.acp': 'ACP Agent',
      'scope.acpHint': '由 Agent 自己调用模型，不经过 DSH，无法脱敏',
      'scope.feedback': '反馈上报',
      'scope.feedbackHint': '提交反馈时会导出原始会话，敏感会话请勿提交反馈',
      'scope.uninstall': '停用或卸载本插件后，脱敏与上传保护随之失效',
      'how.title': '工作原理',
      'how.original': '你的原文',
      'how.sent': '模型收到',
      'how.reply': '模型回复',
      'how.back': '你看到的',
      'how.note': '同一个值总是得到同一个占位符，模型能理解指代关系，缓存命中不受影响。',
      'stats.title': '按类别统计',
      'stats.hint': '首次出现的不同值',
      'stats.empty': '还没有拦截记录',
      'rules.categories': '词库分类',
      'rules.patterns': 'ID 段与正则',
      'rules.builtins': '内置识别',
      'rules.allowlist': '白名单',
      'rules.tools': '出网工具',
      'rules.newCategory': '新增分类',
      'rules.label': '名称',
      'rules.code': '占位符代号',
      'rules.codeHint': '大写字母开头，占位符形如 {{{code}_3fa9c1}}',
      'rules.enabled': '启用',
      'rules.terms': '词条',
      'rules.termsHint': '每行一个，按最长匹配；可从表格直接粘贴一列',
      'rules.termCount': '{n} 个词条',
      'rules.dupes': '已忽略 {n} 个重复',
      'rules.patternsHint': '用于特定格式或号段的 ID，例如员工号 EMP-88 开头的 6 位数字：EMP-88\\d{4}',
      'rules.regex': '正则表达式',
      'rules.ignoreCase': '忽略大小写',
      'rules.addPattern': '添加规则',
      'rules.noPatterns': '还没有正则规则',
      'rules.builtinsHint': '通用个人信息识别，默认关闭',
      'rules.builtin.phone': '手机号',
      'rules.builtin.phoneHint': '中国大陆 11 位手机号',
      'rules.builtin.idcard': '身份证号',
      'rules.builtin.idcardHint': '18 位，校验位必须正确',
      'rules.builtin.email': '邮箱',
      'rules.builtin.emailHint': '自动跳过 example.com 等示例域名',
      'rules.allowlistHint': '这些值永远不脱敏（每行一个），用于词库误伤或模型必须看到原文的值',
      'rules.toolsHint': '这些工具会把参数发送到外部；参数含受保护数据时拦截。支持 * 结尾的前缀，例如 mcp__remote__*',
      'rules.dirty': '有未保存的修改',
      'rules.saved': '已保存',
      'rules.invalid': '保存失败',
      'rules.deleteCategory': '删除分类',
      'rules.storage': '词库保存在本机 {dir}，不会写入插件目录或配置文件',
      'try.input': '原文',
      'try.inputPlaceholder': '粘贴一段包含敏感信息的文本，例如：华东大区风控二部的张三丰负责天穹计划……',
      'try.output': '模型将收到',
      'try.draft': '使用编辑中的规则（含未保存的修改）',
      'try.hits': '命中',
      'try.none': '没有命中任何词条或规则',
      'history.all': '全部',
      'history.mask': '脱敏',
      'history.block': '阻止请求',
      'history.toolBlock': '拦截工具',
      'history.empty': '暂无记录',
      'history.emptyHint': '开启脱敏后，每个会话中首次出现的敏感值会记在这里。记录只保存类别、长度和打码预览，不保存原文。',
      'history.session': '会话',
      'history.occurrences': '本次请求共 {n} 处',
      'history.reason.network': '参数含受保护数据，已阻止发往外部',
      'history.reason.unresolved': '模型使用了无法还原的占位符',
      'history.total': '共 {n} 条',
      'history.privacy': '只记录类别、长度和打码预览',
      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
    };

    const en = {
      'page.title': 'Data Masking',
      'page.subtitle': 'Sensitive values become placeholders before any model request and are restored in the reply',
      'switch.on': 'Masking on',
      'switch.off': 'Masking off',
      'switch.unknown': 'Unknown',
      'session.protected': 'This session is protected: requests are masked and its session log is never uploaded',
      'session.protectedOff': 'This session was protected: its session log stays private, but masking is off',
      'session.pending': 'Masking applies from this session\'s next model request',
      'session.off': 'Masking is off; this session sends plain text',
      'history.thisSession': 'This session only',
      'guide.description': 'Configure dictionaries and rules, see this session\'s interceptions',
      'off.title': 'Turn masking off?',
      'off.body': 'Every later request goes to the model in plain text, including the history of protected sessions. Protected sessions still never upload their session log.',
      'off.confirm': 'Turn off',
      'tab.overview': 'Overview',
      'tab.rules': 'Dictionaries & rules',
      'tab.try': 'Try it',
      'tab.history': 'History',
      'state.loading': 'Loading…',
      'state.error': 'Failed to load: {error}',
      'action.retry': 'Retry',
      'action.save': 'Save',
      'action.saving': 'Saving',
      'action.discard': 'Discard',
      'action.add': 'Add',
      'action.remove': 'Remove',
      'action.clear': 'Clear history',
      'action.clearConfirm': 'Confirm',
      'action.cancel': 'Cancel',
      'action.refresh': 'Refresh',
      'alert.rulesError': 'The rules file is invalid; all model requests are blocked',
      'alert.rulesErrorHint': 'Fill in the rules and save to overwrite the broken file; masking stays on after saving.',
      'alert.protectedError': 'The protected-session list cannot be read; all model requests are blocked',
      'alert.seam': 'This DSH version lacks the internal entry point masking needs',
      'alert.seamHint': 'While masking is on, every model request is blocked. Update the plugin or turn masking off.',
      'alert.guard': 'Session-log upload protection is not ready',
      'alert.guardHint': 'Model requests are blocked until it is. Restarting DSH usually fixes it.',
      'alert.empty': 'Masking is on but there are no terms or rules yet',
      'alert.emptyHint': 'Add the regions, departments, terms, people, addresses or ID segments to protect.',
      'kpi.sessions': 'Protected sessions',
      'kpi.sessionsHint': 'Their session log is never uploaded',
      'kpi.masked': 'Masked requests',
      'kpi.maskedHint': '{n} in the last 24 h',
      'kpi.terms': 'Terms & rules',
      'kpi.termsHint': '{terms} terms · {rules} rules',
      'kpi.blocked': 'Blocked',
      'kpi.blockedHint': 'requests {req} · tool calls {tool}',
      'scope.title': 'Coverage',
      'scope.native': 'DSH sessions, sub-agents, titles and compaction',
      'scope.nativeHint': 'Every request through the DSH model channel',
      'scope.sessionLog': 'Session-log upload',
      'scope.sessionLogHint': 'Protected sessions never upload their raw log; this holds after masking is off, but messages are then sent in plain text',
      'scope.tools': 'Network tools',
      'scope.toolsHint': 'Calls to {tools} carrying protected data are blocked',
      'scope.restore': 'Local tools and UI',
      'scope.restoreHint': 'Placeholders are restored, so edits, files and the transcript keep real values',
      'scope.acp': 'ACP agents',
      'scope.acpHint': 'They call their own models outside DSH and cannot be masked',
      'scope.feedback': 'Feedback upload',
      'scope.feedbackHint': 'Submitting feedback exports the raw session; avoid it on sensitive sessions',
      'scope.uninstall': 'Disabling or removing this plugin turns masking and the upload protection off',
      'how.title': 'How it works',
      'how.original': 'You write',
      'how.sent': 'Model receives',
      'how.reply': 'Model replies',
      'how.back': 'You see',
      'how.note': 'A value always maps to the same placeholder, so references stay consistent and prompt caching keeps working.',
      'stats.title': 'By category',
      'stats.hint': 'distinct values seen',
      'stats.empty': 'Nothing intercepted yet',
      'rules.categories': 'Dictionaries',
      'rules.patterns': 'ID segments & regex',
      'rules.builtins': 'Built-in detectors',
      'rules.allowlist': 'Allowlist',
      'rules.tools': 'Network tools',
      'rules.newCategory': 'New category',
      'rules.label': 'Name',
      'rules.code': 'Placeholder code',
      'rules.codeHint': 'Starts with an uppercase letter; placeholders look like {{{code}_3fa9c1}}',
      'rules.enabled': 'Enabled',
      'rules.terms': 'Terms',
      'rules.termsHint': 'One per line, longest match wins; paste a spreadsheet column directly',
      'rules.termCount': '{n} terms',
      'rules.dupes': '{n} duplicates ignored',
      'rules.patternsHint': 'For IDs with a fixed format or range, e.g. employee numbers EMP-88 followed by 4 digits: EMP-88\\d{4}',
      'rules.regex': 'Regular expression',
      'rules.ignoreCase': 'Ignore case',
      'rules.addPattern': 'Add rule',
      'rules.noPatterns': 'No regex rules yet',
      'rules.builtinsHint': 'Generic personal-data detectors, off by default',
      'rules.builtin.phone': 'Mobile number',
      'rules.builtin.phoneHint': 'Mainland China 11-digit numbers',
      'rules.builtin.idcard': 'ID card number',
      'rules.builtin.idcardHint': '18 digits with a valid checksum',
      'rules.builtin.email': 'Email',
      'rules.builtin.emailHint': 'Example domains such as example.com are skipped',
      'rules.allowlistHint': 'Never masked (one per line): false positives, or values the model must see',
      'rules.toolsHint': 'Tools that send their arguments off the machine; blocked when the arguments carry protected data. A trailing * matches a prefix, e.g. mcp__remote__*',
      'rules.dirty': 'Unsaved changes',
      'rules.saved': 'Saved',
      'rules.invalid': 'Save failed',
      'rules.deleteCategory': 'Delete category',
      'rules.storage': 'Stored on this machine in {dir}, never in the plugin folder or profile config',
      'try.input': 'Original',
      'try.inputPlaceholder': 'Paste text that contains sensitive values…',
      'try.output': 'The model receives',
      'try.draft': 'Uses the rules being edited (including unsaved changes)',
      'try.hits': 'Matches',
      'try.none': 'Nothing matched',
      'history.all': 'All',
      'history.mask': 'Masked',
      'history.block': 'Request blocked',
      'history.toolBlock': 'Tool blocked',
      'history.empty': 'No records yet',
      'history.emptyHint': 'With masking on, the first occurrence of each sensitive value per session is recorded here: category, length and a short preview only, never the value.',
      'history.session': 'Session',
      'history.occurrences': '{n} occurrences in this request',
      'history.reason.network': 'Protected data kept from an external service',
      'history.reason.unresolved': 'The model used a placeholder that cannot be restored',
      'history.total': '{n} records',
      'history.privacy': 'Category, length and a short preview only',
      'time.justNow': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
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
        const dict = DICTS[currentLocale()] || zh;
        let text = dict[key] ?? en[key] ?? key;
        if (values) for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
        return text;
      }
      translate.currentLocale = currentLocale;
      return translate;
    }

    function useLocaleTick(subscribe) {
      const [tick, setTick] = useState(0);
      useEffect(() => subscribe(() => setTick((n) => n + 1)), [subscribe]);
      return tick;
    }

    // ---------------------------------------------------------------------------------------
    // API
    // ---------------------------------------------------------------------------------------

    async function api(path, body) {
      const response = await fetch(`${API}${path}`, body === undefined
        ? { method: 'GET', headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
      let json = null;
      try {
        json = await response.json();
      } catch {
        // non-JSON error page
      }
      if (!response.ok || !json?.ok) {
        const error = new Error(json?.error || `HTTP ${response.status}`);
        error.problems = json?.problems;
        throw error;
      }
      return json;
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    const HUES = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
    const BUILTIN_CODES = { PHONE: 'phone', IDCARD: 'idcard', EMAIL: 'email' };

    function hueFor(code, rules) {
      const codes = [
        ...(rules?.categories ?? []).map((c) => c.code),
        ...(rules?.patterns ?? []).map((p) => p.code),
        ...Object.keys(BUILTIN_CODES),
      ];
      const index = codes.indexOf(code);
      if (index >= 0) return HUES[index % HUES.length];
      let sum = 0;
      for (const ch of String(code)) sum += ch.charCodeAt(0);
      return HUES[sum % HUES.length];
    }

    function linesOf(text) {
      return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }

    function uniqueCount(lines) {
      return new Set(lines).size;
    }

    function relativeTime(at, t) {
      const diff = Date.now() - at;
      if (diff < 60000) return t('time.justNow');
      if (diff < 3600000) return t('time.minutes', { n: Math.floor(diff / 60000) });
      if (diff < 86400000) return t('time.hours', { n: Math.floor(diff / 3600000) });
      const date = new Date(at);
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function shortSession(id) {
      if (typeof id !== 'string') return '—';
      return id.replace(/^session-/, '').slice(0, 8);
    }

    /** Editable draft: textareas keep raw text so typing is never reformatted under the cursor. */
    function toDraft(rules) {
      return {
        enabled: rules.enabled,
        categories: rules.categories.map((c) => ({ ...c, termsText: c.terms.join('\n') })),
        patterns: rules.patterns.map((p) => ({ ...p })),
        builtins: { ...rules.builtins },
        allowlistText: rules.allowlist.join('\n'),
        blockedToolsText: rules.blockedTools.join('\n'),
      };
    }

    function fromDraft(draft) {
      return {
        enabled: draft.enabled,
        categories: draft.categories.map(({ termsText, ...c }) => ({ ...c, terms: linesOf(termsText) })),
        patterns: draft.patterns.map((p) => ({ ...p })),
        builtins: { ...draft.builtins },
        allowlist: linesOf(draft.allowlistText),
        blockedTools: linesOf(draft.blockedToolsText),
      };
    }

    // ---------------------------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------------------------

    function svg(size, children, extra = {}) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { display: 'block', flex: 'none' }, ...extra }, ...children);
    }

    function ShieldIcon({ size = 20 }) {
      return svg(size, [
        h('path', { key: 's', d: 'M8 1.8l5 2.1v3.6c0 3.1-2.1 5.7-5 6.7-2.9-1-5-3.6-5-6.7V3.9l5-2.1z' }),
        h('path', { key: 'a', d: 'M5.7 7.1h4.6' }),
        h('path', { key: 'b', d: 'M5.7 9.4h2.8' }),
      ]);
    }
    const CheckIcon = ({ size = 13 }) => svg(size, [h('path', { key: 'c', d: 'M3.5 8.3l2.9 2.9 6.1-6.4' })]);
    const CrossIcon = ({ size = 13 }) => svg(size, [h('path', { key: 'a', d: 'M4.5 4.5l7 7' }), h('path', { key: 'b', d: 'M11.5 4.5l-7 7' })]);
    const AlertIcon = ({ size = 14 }) => svg(size, [h('path', { key: 't', d: 'M8 2.2l6 10.6H2L8 2.2z' }), h('path', { key: 'l', d: 'M8 6.6v3' }), h('circle', { key: 'd', cx: 8, cy: 11.4, r: 0.4, fill: 'currentColor' })]);
    const PlusIcon = ({ size = 13 }) => svg(size, [h('path', { key: 'a', d: 'M8 3.5v9' }), h('path', { key: 'b', d: 'M3.5 8h9' })]);
    const TrashIcon = ({ size = 13 }) => svg(size, [h('path', { key: 'a', d: 'M3 4.5h10' }), h('path', { key: 'b', d: 'M6.5 4.5V3h3v1.5' }), h('path', { key: 'c', d: 'M4.5 4.5l.6 8.5h5.8l.6-8.5' })]);
    const ArrowIcon = ({ size = 14 }) => svg(size, [h('path', { key: 'a', d: 'M3 8h9.5' }), h('path', { key: 'b', d: 'M9.5 5l3 3-3 3' })]);
    const LockIcon = ({ size = 12 }) => svg(size, [h('rect', { key: 'r', x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }), h('path', { key: 'p', d: 'M5.5 7V5.3a2.5 2.5 0 015 0V7' })]);

    // ---------------------------------------------------------------------------------------
    // Small components
    // ---------------------------------------------------------------------------------------

    function Switch({ checked, onChange, disabled, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          className: `dm-switch${checked ? ' is-on' : ''}`,
          disabled,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'dm-switch-knob' }),
      );
    }

    function Token({ code, text, rules }) {
      const hue = hueFor(code, rules);
      return h('span', { className: 'dm-token', style: { '--dm-hue': hue } }, text);
    }

    function Alert({ tone = 'error', title, hint }) {
      return h(
        'div',
        { className: `dm-alert is-${tone}`, role: tone === 'error' ? 'alert' : 'status' },
        h(AlertIcon, { size: 15 }),
        h('div', { className: 'dm-alert-text' }, h('div', { className: 'dm-alert-title' }, title), hint ? h('div', { className: 'dm-alert-hint' }, hint) : null),
      );
    }

    /** Masked text with every placeholder rendered as a coloured chip. */
    function MaskedText({ text, rules }) {
      const parts = [];
      const re = /\{\{([A-Z][A-Z0-9]{0,15})_([0-9a-f]{6,16})\}\}/g;
      let cursor = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m.index > cursor) parts.push(text.slice(cursor, m.index));
        parts.push(h(Token, { key: `${m.index}`, code: m[1], text: m[0], rules }));
        cursor = m.index + m[0].length;
      }
      if (cursor < text.length) parts.push(text.slice(cursor));
      return h('div', { className: 'dm-masked' }, ...parts);
    }

    // ---------------------------------------------------------------------------------------
    // Overview
    // ---------------------------------------------------------------------------------------

    function Overview({ state, t }) {
      const { status, rules, stats } = state;
      const terms = rules ? rules.categories.reduce((sum, c) => sum + (c.enabled ? c.terms.length : 0), 0) : 0;
      const ruleCount = rules ? rules.patterns.filter((p) => p.enabled).length + Object.values(rules.builtins).filter(Boolean).length : 0;
      const tools = rules?.blockedTools?.length ? rules.blockedTools.join('、') : '—';
      const maxValues = Math.max(1, ...stats.byCode.map((b) => b.values));
      const sample = [
        { code: 'DEPT', original: '风控二部', token: '{{DEPT_3fa9c1}}' },
        { code: 'PERSON', original: '张三丰', token: '{{PERSON_8b20e4}}' },
      ];
      const scope = [
        { ok: true, title: t('scope.native'), hint: t('scope.nativeHint') },
        { ok: true, title: t('scope.restore'), hint: t('scope.restoreHint') },
        { ok: status.sessionLogGuarded || !status.sessionLogPresent, title: t('scope.sessionLog'), hint: t('scope.sessionLogHint') },
        { ok: (rules?.blockedTools?.length ?? 0) > 0, title: t('scope.tools'), hint: t('scope.toolsHint', { tools }) },
        { ok: false, title: t('scope.acp'), hint: t('scope.acpHint') },
        { ok: 'warn', title: t('scope.feedback'), hint: t('scope.feedbackHint') },
      ];
      const sampleRules = { categories: [{ code: 'DEPT' }, { code: 'PERSON' }], patterns: [] };
      return h(
        'div',
        { className: 'dm-overview' },
        h(
          'div',
          { className: 'dm-kpis' },
          kpi(t('kpi.sessions'), status.protectedSessions, t('kpi.sessionsHint')),
          kpi(t('kpi.masked'), stats.masked, t('kpi.maskedHint', { n: stats.today })),
          kpi(t('kpi.terms'), terms + ruleCount, t('kpi.termsHint', { terms, rules: ruleCount })),
          kpi(t('kpi.blocked'), stats.blocked + stats.toolBlocked, t('kpi.blockedHint', { req: stats.blocked, tool: stats.toolBlocked })),
        ),
        h(
          'div',
          { className: 'dm-grid' },
          h(
            'section',
            { className: 'dm-card' },
            h('div', { className: 'dm-card-title' }, t('how.title')),
            h(
              'div',
              { className: 'dm-flow' },
              flowStep(t('how.original'), h('span', null, `请${sample[0].original}的${sample[1].original}确认上线`)),
              h('span', { className: 'dm-flow-arrow' }, h(ArrowIcon)),
              flowStep(t('how.sent'), h('span', null, '请', h(Token, { code: 'DEPT', text: sample[0].token, rules: sampleRules }), '的', h(Token, { code: 'PERSON', text: sample[1].token, rules: sampleRules }), '确认上线'), true),
              flowStep(t('how.reply'), h('span', null, '已通知 ', h(Token, { code: 'PERSON', text: sample[1].token, rules: sampleRules }), ' 确认'), true),
              h('span', { className: 'dm-flow-arrow' }, h(ArrowIcon)),
              flowStep(t('how.back'), h('span', null, `已通知 ${sample[1].original} 确认`)),
            ),
            h('div', { className: 'dm-note' }, t('how.note')),
            h('div', { className: 'dm-card-title dm-gap' }, t('scope.title')),
            h(
              'ul',
              { className: 'dm-scope' },
              ...scope.map((item, index) =>
                h(
                  'li',
                  { key: index, className: `dm-scope-item ${item.ok === true ? 'is-ok' : item.ok === 'warn' ? 'is-warn' : 'is-off'}` },
                  h('span', { className: 'dm-scope-mark' }, item.ok === true ? h(CheckIcon) : item.ok === 'warn' ? h(AlertIcon, { size: 12 }) : h(CrossIcon)),
                  h('div', null, h('div', { className: 'dm-scope-title' }, item.title), h('div', { className: 'dm-scope-hint' }, item.hint)),
                ),
              ),
            ),
            h('div', { className: 'dm-note' }, t('scope.uninstall')),
          ),
          h(
            'section',
            { className: 'dm-card' },
            h('div', { className: 'dm-card-title' }, t('stats.title'), h('span', { className: 'dm-card-meta' }, t('stats.hint'))),
            stats.byCode.length === 0
              ? h('div', { className: 'dm-empty-small' }, t('stats.empty'))
              : h(
                  'div',
                  { className: 'dm-bars' },
                  ...stats.byCode.map((bucket) =>
                    h(
                      'div',
                      { key: bucket.code, className: 'dm-bar-row' },
                      h('span', { className: 'dm-bar-label' }, bucket.label),
                      h('span', { className: 'dm-bar-track' }, h('span', { className: 'dm-bar-fill', style: { width: `${(bucket.values / maxValues) * 100}%`, background: hueFor(bucket.code, rules) } })),
                      h('span', { className: 'dm-bar-value' }, bucket.values),
                    ),
                  ),
                ),
          ),
        ),
      );
    }

    function kpi(label, value, hint) {
      return h('div', { className: 'dm-kpi' }, h('div', { className: 'dm-kpi-label' }, label), h('div', { className: 'dm-kpi-value' }, String(value ?? 0)), h('div', { className: 'dm-kpi-hint' }, hint));
    }

    function flowStep(label, body, masked) {
      return h('div', { className: `dm-flow-step${masked ? ' is-masked' : ''}` }, h('div', { className: 'dm-flow-label' }, masked ? h(LockIcon) : null, label), h('div', { className: 'dm-flow-body' }, body));
    }

    // ---------------------------------------------------------------------------------------
    // Rules editor
    // ---------------------------------------------------------------------------------------

    function RulesEditor({ draft, setDraft, t, dataDir, problems }) {
      const [section, setSection] = useState('cat:0');
      const update = (fn) => setDraft((current) => {
        const next = structuredClone(current);
        fn(next);
        return next;
      });
      const categoryIndex = section.startsWith('cat:') ? Number(section.slice(4)) : -1;
      const category = categoryIndex >= 0 ? draft.categories[categoryIndex] : null;
      useEffect(() => {
        if (section.startsWith('cat:') && !draft.categories[categoryIndex]) setSection(draft.categories.length ? 'cat:0' : 'patterns');
      }, [draft.categories.length]);

      const addCategory = () => {
        const used = new Set([...draft.categories.map((c) => c.code), ...draft.patterns.map((p) => p.code)]);
        let n = 1;
        while (used.has(`CUSTOM${n}`)) n += 1;
        update((d) => {
          d.categories.push({ id: `c${Date.now().toString(36)}`, code: `CUSTOM${n}`, label: `${t('rules.newCategory')} ${n}`, enabled: true, terms: [], termsText: '' });
        });
        setSection(`cat:${draft.categories.length}`);
      };

      const nav = (key, label, count, hue) =>
        h(
          'button',
          { key, type: 'button', className: `dm-nav-item${section === key ? ' is-active' : ''}`, onClick: () => setSection(key) },
          hue ? h('span', { className: 'dm-dot', style: { background: hue } }) : null,
          h('span', { className: 'dm-nav-label' }, label),
          count !== undefined ? h('span', { className: 'dm-nav-count' }, count) : null,
        );

      const rulesForHue = fromDraft(draft);
      let body = null;
      if (category) {
        const lines = linesOf(category.termsText);
        const distinct = uniqueCount(lines);
        body = h(
          'div',
          { className: 'dm-editor' },
          h(
            'div',
            { className: 'dm-row' },
            field(t('rules.label'), h('input', { className: 'dm-input', value: category.label, maxLength: 24, onChange: (e) => update((d) => { d.categories[categoryIndex].label = e.target.value; }) })),
            field(t('rules.code'), h('input', { className: 'dm-input dm-mono', value: category.code, maxLength: 16, onChange: (e) => update((d) => { d.categories[categoryIndex].code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); }) }), t('rules.codeHint', { code: category.code || 'CODE' })),
            h('div', { className: 'dm-field dm-field-switch' }, h('div', { className: 'dm-field-label' }, t('rules.enabled')), h(Switch, { checked: category.enabled, label: t('rules.enabled'), onChange: (value) => update((d) => { d.categories[categoryIndex].enabled = value; }) })),
          ),
          h(
            'div',
            { className: 'dm-field dm-grow' },
            h('div', { className: 'dm-field-label' }, t('rules.terms'), h('span', { className: 'dm-field-meta' }, t('rules.termCount', { n: distinct }), lines.length > distinct ? ` · ${t('rules.dupes', { n: lines.length - distinct })}` : '')),
            h('textarea', { className: 'dm-textarea', spellCheck: false, value: category.termsText, placeholder: '华东大区\n风控二部\n…', onChange: (e) => update((d) => { d.categories[categoryIndex].termsText = e.target.value; }) }),
            h('div', { className: 'dm-field-hint' }, t('rules.termsHint')),
          ),
          h(
            'div',
            { className: 'dm-editor-foot' },
            h('button', { type: 'button', className: 'dm-btn dm-btn-ghost dm-btn-danger', onClick: () => update((d) => { d.categories.splice(categoryIndex, 1); }) }, h(TrashIcon), t('rules.deleteCategory')),
          ),
        );
      } else if (section === 'patterns') {
        body = h(
          'div',
          { className: 'dm-editor' },
          h('div', { className: 'dm-field-hint dm-lead' }, t('rules.patternsHint')),
          draft.patterns.length === 0 ? h('div', { className: 'dm-empty-small' }, t('rules.noPatterns')) : null,
          ...draft.patterns.map((pattern, index) =>
            h(
              'div',
              { key: pattern.id, className: 'dm-pattern' },
              h('span', { className: 'dm-dot', style: { background: hueFor(pattern.code, rulesForHue) } }),
              h('input', { className: 'dm-input dm-pattern-label', value: pattern.label, placeholder: t('rules.label'), onChange: (e) => update((d) => { d.patterns[index].label = e.target.value; }) }),
              h('input', { className: 'dm-input dm-mono dm-pattern-code', value: pattern.code, placeholder: 'CODE', maxLength: 16, onChange: (e) => update((d) => { d.patterns[index].code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); }) }),
              h('input', { className: 'dm-input dm-mono dm-pattern-regex', value: pattern.regex, placeholder: t('rules.regex'), spellCheck: false, onChange: (e) => update((d) => { d.patterns[index].regex = e.target.value; }) }),
              h('label', { className: 'dm-check' }, h('input', { type: 'checkbox', checked: pattern.ignoreCase, onChange: (e) => update((d) => { d.patterns[index].ignoreCase = e.target.checked; }) }), t('rules.ignoreCase')),
              h(Switch, { checked: pattern.enabled, label: t('rules.enabled'), onChange: (value) => update((d) => { d.patterns[index].enabled = value; }) }),
              h('button', { type: 'button', className: 'dm-icon-btn', title: t('action.remove'), 'aria-label': t('action.remove'), onClick: () => update((d) => { d.patterns.splice(index, 1); }) }, h(TrashIcon)),
            ),
          ),
          h(
            'div',
            null,
            h('button', {
              type: 'button',
              className: 'dm-btn',
              onClick: () => update((d) => {
                const used = new Set([...d.categories.map((c) => c.code), ...d.patterns.map((p) => p.code)]);
                let n = 1;
                while (used.has(`ID${n}`)) n += 1;
                d.patterns.push({ id: `p${Date.now().toString(36)}`, code: `ID${n}`, label: '', regex: '', ignoreCase: false, enabled: true });
              }),
            }, h(PlusIcon), t('rules.addPattern')),
          ),
        );
      } else if (section === 'builtins') {
        body = h(
          'div',
          { className: 'dm-editor' },
          h('div', { className: 'dm-field-hint dm-lead' }, t('rules.builtinsHint')),
          ...['phone', 'idcard', 'email'].map((key) =>
            h(
              'div',
              { key, className: 'dm-toggle-row' },
              h('div', null, h('div', { className: 'dm-toggle-title' }, t(`rules.builtin.${key}`)), h('div', { className: 'dm-field-hint' }, t(`rules.builtin.${key}Hint`))),
              h(Switch, { checked: draft.builtins[key], label: t(`rules.builtin.${key}`), onChange: (value) => update((d) => { d.builtins[key] = value; }) }),
            ),
          ),
        );
      } else if (section === 'allowlist' || section === 'tools') {
        const key = section === 'allowlist' ? 'allowlistText' : 'blockedToolsText';
        body = h(
          'div',
          { className: 'dm-editor' },
          h(
            'div',
            { className: 'dm-field dm-grow' },
            h('div', { className: 'dm-field-hint dm-lead' }, t(section === 'allowlist' ? 'rules.allowlistHint' : 'rules.toolsHint')),
            h('textarea', { className: `dm-textarea${section === 'tools' ? ' dm-mono' : ''}`, spellCheck: false, value: draft[key], onChange: (e) => update((d) => { d[key] = e.target.value; }) }),
          ),
        );
      }

      return h(
        'div',
        { className: 'dm-rules' },
        h(
          'nav',
          { className: 'dm-nav' },
          h('div', { className: 'dm-nav-group' }, t('rules.categories')),
          ...draft.categories.map((c, index) => nav(`cat:${index}`, c.label || c.code, uniqueCount(linesOf(c.termsText)), hueFor(c.code, rulesForHue))),
          h('button', { type: 'button', className: 'dm-nav-item dm-nav-add', onClick: addCategory }, h(PlusIcon), t('rules.newCategory')),
          h('div', { className: 'dm-nav-group' }, t('tab.rules')),
          nav('patterns', t('rules.patterns'), draft.patterns.length),
          nav('builtins', t('rules.builtins'), Object.values(draft.builtins).filter(Boolean).length),
          nav('allowlist', t('rules.allowlist'), linesOf(draft.allowlistText).length),
          nav('tools', t('rules.tools'), linesOf(draft.blockedToolsText).length),
          h('div', { className: 'dm-nav-foot' }, h(LockIcon), h('span', null, t('rules.storage', { dir: dataDir }))),
        ),
        h(
          'div',
          { className: 'dm-rules-body' },
          problems && problems.length
            ? h('div', { className: 'dm-problems', role: 'alert' }, h('div', { className: 'dm-alert-title' }, t('rules.invalid')), h('ul', null, ...problems.map((p, i) => h('li', { key: i }, p))))
            : null,
          body,
        ),
      );
    }

    function field(label, control, hint) {
      return h('label', { className: 'dm-field' }, h('div', { className: 'dm-field-label' }, label), control, hint ? h('div', { className: 'dm-field-hint' }, hint) : null);
    }

    // ---------------------------------------------------------------------------------------
    // Try it
    // ---------------------------------------------------------------------------------------

    function TryIt({ draft, t }) {
      const [text, setText] = useState('');
      const [result, setResult] = useState(null);
      const [error, setError] = useState(null);
      const draftRules = useMemo(() => fromDraft(draft), [draft]);
      useEffect(() => {
        if (!text.trim()) {
          setResult(null);
          setError(null);
          return undefined;
        }
        let live = true;
        const timer = setTimeout(() => {
          api('/preview', { text, rules: draftRules })
            .then((json) => { if (live) { setResult(json); setError(null); } })
            .catch((err) => { if (live) setError(err.problems?.join('；') || err.message); });
        }, 220);
        return () => { live = false; clearTimeout(timer); };
      }, [text, draftRules]);

      return h(
        'div',
        { className: 'dm-try' },
        h(
          'div',
          { className: 'dm-try-pane' },
          h('div', { className: 'dm-card-title' }, t('try.input')),
          h('textarea', { className: 'dm-textarea dm-try-input', value: text, placeholder: t('try.inputPlaceholder'), onChange: (e) => setText(e.target.value), spellCheck: false }),
          h('div', { className: 'dm-field-hint' }, t('try.draft')),
        ),
        h(
          'div',
          { className: 'dm-try-pane' },
          h('div', { className: 'dm-card-title' }, h(LockIcon), t('try.output')),
          error ? h(Alert, { tone: 'error', title: error }) : null,
          h('div', { className: 'dm-try-output' }, result ? h(MaskedText, { text: result.masked, rules: draftRules }) : h('span', { className: 'dm-muted' }, '—')),
          result
            ? h(
                'div',
                { className: 'dm-hits' },
                h('div', { className: 'dm-field-label' }, t('try.hits')),
                result.items.length === 0
                  ? h('div', { className: 'dm-muted' }, t('try.none'))
                  : h('div', { className: 'dm-chips' }, ...result.items.map((item) => h('span', { key: item.token, className: 'dm-chip', style: { '--dm-hue': hueFor(item.code, draftRules) } }, h('b', null, item.label), ` ${item.preview}`, item.count > 1 ? ` ×${item.count}` : ''))),
              )
            : null,
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // History
    // ---------------------------------------------------------------------------------------

    function History({ t, rules, onCleared, sessionId, isVisible }) {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [filter, setFilter] = useState('all');
      const [onlySession, setOnlySession] = useState(Boolean(sessionId));
      const [confirming, setConfirming] = useState(false);
      const load = useCallback(() => {
        if (!isVisible()) return;
        const query = onlySession && sessionId ? `&session=${encodeURIComponent(sessionId)}` : '';
        api(`/history?limit=500${query}`).then((json) => { setData(json); setError(null); }).catch((err) => setError(err.message));
      }, [onlySession, sessionId, isVisible]);
      useEffect(() => {
        load();
        const timer = setInterval(load, 8000);
        return () => clearInterval(timer);
      }, [load]);
      const entries = (data?.entries ?? []).filter((entry) => filter === 'all' || entry.kind === filter);
      const counts = { all: data?.entries?.length ?? 0, mask: 0, block: 0, 'tool-block': 0 };
      for (const entry of data?.entries ?? []) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
      const kindLabel = { mask: t('history.mask'), block: t('history.block'), 'tool-block': t('history.toolBlock') };

      return h(
        'div',
        { className: 'dm-history' },
        h(
          'div',
          { className: 'dm-history-bar' },
          h(
            'div',
            { className: 'dm-seg', role: 'tablist' },
            ...['all', 'mask', 'block', 'tool-block'].map((key) =>
              h('button', { key, type: 'button', role: 'tab', 'aria-selected': filter === key, className: `dm-seg-item${filter === key ? ' is-active' : ''}`, onClick: () => setFilter(key) }, key === 'all' ? t('history.all') : kindLabel[key], h('span', { className: 'dm-seg-count' }, counts[key] ?? 0)),
            ),
          ),
          sessionId
            ? h('label', { className: 'dm-check dm-only-session' }, h('input', { type: 'checkbox', checked: onlySession, onChange: (e) => setOnlySession(e.target.checked) }), t('history.thisSession'))
            : null,
          h('span', { className: 'dm-history-privacy', title: t('history.privacy') }, h(LockIcon)),
          confirming
            ? h(
                'span',
                { className: 'dm-confirm' },
                h('button', { type: 'button', className: 'dm-btn dm-btn-danger-solid', onClick: () => { setConfirming(false); api('/history/clear', {}).then(() => { load(); onCleared(); }).catch((err) => setError(err.message)); } }, t('action.clearConfirm')),
                h('button', { type: 'button', className: 'dm-btn', onClick: () => setConfirming(false) }, t('action.cancel')),
              )
            : h('button', { type: 'button', className: 'dm-btn', disabled: !counts.all, onClick: () => setConfirming(true) }, h(TrashIcon), t('action.clear')),
        ),
        error ? h(Alert, { tone: 'error', title: error }) : null,
        entries.length === 0
          ? h('div', { className: 'dm-empty' }, h('span', { className: 'dm-empty-icon' }, h(ShieldIcon, { size: 22 })), h('div', { className: 'dm-empty-title' }, t('history.empty')), h('div', { className: 'dm-empty-hint' }, t('history.emptyHint')))
          : h(
              'div',
              { className: 'dm-list' },
              ...entries.map((entry) =>
                h(
                  'div',
                  { key: entry.id, className: `dm-entry is-${entry.kind}` },
                  h('div', { className: 'dm-entry-head' }, h('span', { className: `dm-kind is-${entry.kind}` }, kindLabel[entry.kind] ?? entry.kind), entry.tool ? h('code', { className: 'dm-entry-tool' }, entry.tool) : null, h('span', { className: 'dm-entry-meta' }, `${t('history.session')} ${shortSession(entry.sessionId)}`), entry.model ? h('span', { className: 'dm-entry-meta' }, entry.model) : null, h('span', { className: 'dm-entry-time', title: new Date(entry.at).toLocaleString() }, relativeTime(entry.at, t))),
                  entry.items?.length
                    ? h('div', { className: 'dm-chips' }, ...entry.items.map((item, index) => h('span', { key: index, className: 'dm-chip', style: { '--dm-hue': hueFor(item.code, rules) } }, h('b', null, item.label), ` ${item.preview}`, item.count > 1 ? ` ×${item.count}` : '')))
                    : null,
                  entry.kind === 'block' ? h('div', { className: 'dm-entry-reason is-clamped', title: entry.reason }, entry.reason) : null,
                  entry.kind === 'tool-block' ? h('div', { className: 'dm-entry-reason' }, t(entry.reason === 'unresolved-placeholder' ? 'history.reason.unresolved' : 'history.reason.network')) : null,
                  entry.kind === 'mask' && entry.occurrences ? h('div', { className: 'dm-entry-foot' }, t('history.occurrences', { n: entry.occurrences })) : null,
                ),
              ),
            ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------------------------

    function DataMaskingPage({ t, subscribeLocale, sessionId }) {
      useLocaleTick(subscribeLocale);
      const rootRef = useRef(null);
      // keepMounted bodies stay alive in hidden tabs and background sessions: only poll when shown.
      const isVisible = useCallback(() => {
        const node = rootRef.current;
        return !node || (node.offsetParent !== null && document.visibilityState !== 'hidden');
      }, []);
      const [state, setState] = useState(null);
      const [loadError, setLoadError] = useState(null);
      const [tab, setTab] = useState('overview');
      const [draft, setDraft] = useState(null);
      const [baseline, setBaseline] = useState('');
      const [saving, setSaving] = useState(false);
      const [toggling, setToggling] = useState(false);
      const [problems, setProblems] = useState(null);
      const [flash, setFlash] = useState(null);
      const [confirmOff, setConfirmOff] = useState(false);
      const dirtyRef = useRef(false);

      const adopt = useCallback((json, resetDraft) => {
        setState(json);
        setLoadError(null);
        const source = json.rules ?? json.defaults;
        if (source && (resetDraft || !dirtyRef.current)) {
          const next = toDraft(source);
          setDraft(next);
          setBaseline(JSON.stringify(fromDraft(next)));
        }
      }, []);

      const statePath = sessionId ? `/state?session=${encodeURIComponent(sessionId)}` : '/state';
      const load = useCallback((force) => {
        if (!force && !isVisible()) return;
        api(statePath).then((json) => adopt(json, false)).catch((err) => setLoadError(err.message));
      }, [adopt, statePath, isVisible]);

      useEffect(() => {
        load(true);
        const timer = setInterval(() => load(false), 8000);
        return () => clearInterval(timer);
      }, [load]);

      const dirty = draft !== null && (Boolean(state?.status?.rulesError) || JSON.stringify(fromDraft(draft)) !== baseline);
      dirtyRef.current = dirty;

      useEffect(() => {
        if (!flash) return undefined;
        const timer = setTimeout(() => setFlash(null), 2200);
        return () => clearTimeout(timer);
      }, [flash]);

      const save = () => {
        setSaving(true);
        setProblems(null);
        const rules = fromDraft(draft);
        delete rules.enabled; // the switch owns `enabled`
        api('/rules', rules)
          .then((json) => { adopt(json, true); setFlash(t('rules.saved')); })
          .catch((err) => setProblems(err.problems?.length ? err.problems : [err.message]))
          .finally(() => setSaving(false));
      };

      const toggle = (enabled) => {
        if (!enabled && !confirmOff) {
          setConfirmOff(true);
          return;
        }
        setConfirmOff(false);
        setToggling(true);
        api('/toggle', { enabled })
          .then((json) => adopt(json, false))
          .catch((err) => setLoadError(err.message))
          .finally(() => setToggling(false));
      };

      const status = state?.status;
      const enabled = status?.enabled === true;
      const alerts = [];
      if (status?.rulesError) alerts.push(h(Alert, { key: 'rules', tone: 'error', title: t('alert.rulesError'), hint: `${status.rulesError}。${t('alert.rulesErrorHint')}` }));
      if (status?.protectedError) alerts.push(h(Alert, { key: 'protected', tone: 'error', title: t('alert.protectedError'), hint: status.protectedError }));
      if (status && !status.interceptorReady) alerts.push(h(Alert, { key: 'seam', tone: enabled ? 'error' : 'warn', title: t('alert.seam'), hint: t('alert.seamHint') }));
      if (status && status.sessionLogPresent && !status.sessionLogGuarded) alerts.push(h(Alert, { key: 'guard', tone: enabled ? 'error' : 'warn', title: t('alert.guard'), hint: t('alert.guardHint') }));
      if (enabled && state?.rules) {
        const empty = state.rules.categories.every((c) => !c.enabled || c.terms.length === 0) && !state.rules.patterns.some((p) => p.enabled) && !Object.values(state.rules.builtins).some(Boolean);
        if (empty) alerts.push(h(Alert, { key: 'empty', tone: 'warn', title: t('alert.empty'), hint: t('alert.emptyHint') }));
      }

      const tabs = [
        ['overview', t('tab.overview')],
        ['rules', t('tab.rules')],
        ['try', t('tab.try')],
        ['history', t('tab.history')],
      ];

      let content;
      if (!state) {
        content = loadError
          ? h('div', { className: 'dm-empty' }, h('div', { className: 'dm-empty-title' }, t('state.error', { error: loadError })), h('button', { type: 'button', className: 'dm-btn', onClick: () => load(true) }, t('action.retry')))
          : h('div', { className: 'dm-empty' }, h('span', { className: 'dm-spinner' }), h('div', { className: 'dm-empty-hint' }, t('state.loading')));
      } else if (tab === 'overview') {
        content = h(Overview, { state, t });
      } else if (tab === 'rules') {
        content = draft ? h(RulesEditor, { draft, setDraft, t, dataDir: state.dataDir, problems }) : null;
      } else if (tab === 'try') {
        content = draft ? h(TryIt, { draft, t }) : null;
      } else {
        content = h(History, { t, rules: state.rules, onCleared: () => load(true), sessionId, isVisible });
      }

      const sessionProtected = status?.sessionProtected === true;
      let sessionLine = null;
      if (status && sessionId && !status.rulesError) {
        if (enabled) sessionLine = sessionProtected ? t('session.protected') : t('session.pending');
        else sessionLine = sessionProtected ? t('session.protectedOff') : t('session.off');
      }
      const statusText = status?.rulesError ? t('switch.unknown') : enabled ? t('switch.on') : t('switch.off');

      return h(
        'div',
        { className: 'dm-root', ref: rootRef },
        h('style', null, sharedPanelCss('.dm-root') + CSS),
        h(
          'div',
          { className: 'dm-panel' },
          h(
            'header',
            { className: `dm-header${status?.rulesError ? ' is-error' : enabled ? ' is-on' : ''}` },
            h('span', { className: 'dm-brand-icon' }, h(ShieldIcon, { size: 16 })),
            h(
              'div',
              { className: 'dm-brand-text' },
              h('div', { className: 'dm-title' }, statusText),
              h('div', { className: 'dm-subtitle', title: sessionLine ?? t('page.subtitle') }, sessionLine ?? t('page.subtitle')),
            ),
            h(Switch, { checked: enabled, disabled: !state || toggling || Boolean(status?.rulesError), label: t('page.title'), onChange: toggle }),
          ),
          confirmOff
            ? h(
                'div',
                { className: 'dm-confirm-off', role: 'alertdialog', 'aria-label': t('off.title') },
                h(AlertIcon, { size: 15 }),
                h('div', { className: 'dm-alert-text' }, h('div', { className: 'dm-alert-title' }, t('off.title')), h('div', { className: 'dm-alert-hint' }, t('off.body'))),
                h('div', { className: 'dm-confirm' }, h('button', { type: 'button', className: 'dm-btn', onClick: () => setConfirmOff(false) }, t('action.cancel')), h('button', { type: 'button', className: 'dm-btn dm-btn-danger-solid', onClick: () => toggle(false) }, t('off.confirm'))),
              )
            : null,
          alerts.length ? h('div', { className: 'dm-alerts' }, ...alerts) : null,
          h(
            'div',
            { className: 'dm-tabs', role: 'tablist' },
            ...tabs.map(([key, label]) => h('button', { key, type: 'button', role: 'tab', 'aria-selected': tab === key, className: `dm-tab${tab === key ? ' is-active' : ''}`, onClick: () => setTab(key) }, label, key === 'rules' && dirty ? h('span', { className: 'dm-tab-dirty', title: t('rules.dirty') }) : null)),
          ),
          h('div', { className: 'dm-content' }, content),
          (tab === 'rules' || tab === 'try') && draft
            ? h(
                'div',
                { className: `dm-savebar${dirty ? ' is-dirty' : ''}` },
                h('span', { className: 'dm-savebar-text' }, flash ? h('span', { className: 'dm-saved' }, h(CheckIcon), flash) : dirty ? t('rules.dirty') : ''),
                h('button', { type: 'button', className: 'dm-btn', disabled: !dirty || saving, onClick: () => { const next = toDraft(state.rules ?? state.defaults); setDraft(next); setProblems(null); } }, t('action.discard')),
                h('button', { type: 'button', className: 'dm-btn dm-btn-primary', disabled: !dirty || saving, onClick: save }, saving ? h('span', { className: 'dm-spinner' }) : null, saving ? t('action.saving') : t('action.save')),
              )
            : null,
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Styles — DSH design tokens
    // ---------------------------------------------------------------------------------------

    const ACCENT = 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))';
    const CSS = `
.dm-root { container: dmroot / inline-size; height: 100%; min-height: 0; overflow: hidden; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
.dm-root *, .dm-root *::before, .dm-root *::after { box-sizing: border-box; }
.dm-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; }
.dm-header { flex: none; display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); transition: background var(--dshp-dur) ease, border-color var(--dshp-dur) ease; }
.dm-header.is-on { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 30%, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 6%, var(--dsw-alias-bg-layer-1)); }
.dm-header.is-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, var(--dsw-alias-border-l1)); }
.dm-brand-icon { width: 30px; height: 30px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); transition: color var(--dshp-dur) ease, background var(--dshp-dur) ease; }
.dm-header.is-on .dm-brand-icon { color: var(--dsw-alias-state-success-primary, #16a34a); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 15%, transparent); }
.dm-header.is-error .dm-brand-icon { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.dm-brand-text { flex: 1; min-width: 0; }
.dm-title { font-size: 13.5px; font-weight: 600; white-space: nowrap; }
.dm-header.is-on .dm-title { color: var(--dsw-alias-state-success-primary, #16a34a); }
.dm-header.is-error .dm-title { color: var(--dsw-alias-state-error-primary); }
.dm-subtitle { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-switch { position: relative; width: 36px; height: 20px; flex: none; border-radius: 999px; border: 0; padding: 0; cursor: pointer;
  background: var(--dsw-alias-border-l2, rgba(127,127,127,.35)); transition: background var(--dshp-dur) var(--dshp-ease-out); }
.dm-switch.is-on { background: var(--dsw-alias-state-success-primary, #16a34a); }
.dm-switch:disabled { opacity: .5; cursor: default; }
.dm-switch:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }
.dm-switch-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: transform var(--dshp-dur) var(--dshp-ease-out); }
.dm-switch.is-on .dm-switch-knob { transform: translateX(16px); }

.dm-alerts { flex: none; display: flex; flex-direction: column; gap: 6px; }
.dm-alert { display: flex; gap: 9px; align-items: flex-start; padding: 8px 12px; border-radius: 10px; font-size: 12px; }
.dm-alert.is-error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent); }
.dm-alert.is-warn { color: var(--dsw-alias-state-warn-primary, #b45309); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 8%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 26%, transparent); }
.dm-alert svg { margin-top: 1px; }
.dm-alert-title { font-weight: 600; }
.dm-confirm-off { flex: none; display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 10px; font-size: 12px;
  color: var(--dsw-alias-state-warn-primary, #b45309); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 8%, var(--dsw-alias-bg-layer-1));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 30%, transparent); animation: dm-fade-in var(--dshp-dur) var(--dshp-ease-out); }
.dm-confirm-off .dm-alert-text { flex: 1; min-width: 0; }
.dm-confirm-off .dm-alert-hint { color: var(--dsw-alias-label-secondary); }
.dm-alert-hint { color: var(--dsw-alias-label-secondary); margin-top: 2px; word-break: break-all; }

.dm-tabs { flex: none; display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dm-tab { position: relative; border: 0; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 12.5px; padding: 6px 12px 7px; cursor: pointer; white-space: nowrap; transition: color var(--dshp-dur-fast) ease, background var(--dshp-dur-fast) ease; }
.dm-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dm-tab.is-active { color: var(--dsw-alias-label-primary); border-bottom-color: ${ACCENT}; font-weight: 600; }
.dm-tab-dirty { position: absolute; top: 6px; right: 4px; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary, #d97706); }
.dm-content { flex: 1; min-height: 0; overflow: auto; }

.dm-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary);
  border-radius: 8px; padding: 5px 11px; font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer; white-space: nowrap;
  transition: background var(--dshp-dur-fast) ease, border-color var(--dshp-dur-fast) ease, opacity var(--dshp-dur-fast) ease; }
.dm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dm-btn:disabled { opacity: .5; cursor: default; }
.dm-btn:focus-visible, .dm-icon-btn:focus-visible, .dm-nav-item:focus-visible, .dm-tab:focus-visible, .dm-seg-item:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 1px; }
.dm-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.dm-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); filter: brightness(1.06); }
.dm-btn-ghost { border-color: transparent; }
.dm-btn-danger { color: var(--dsw-alias-state-error-primary); }
.dm-btn-danger-solid { background: var(--dsw-alias-state-error-primary); border-color: transparent; color: #fff; }
.dm-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none; border: 0; border-radius: 7px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dm-icon-btn:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dm-spinner { display: inline-block; width: 12px; height: 12px; border: 1.6px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: dm-spin .8s linear infinite; }
@keyframes dm-spin { to { transform: rotate(360deg); } }

.dm-card { min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px 14px; }
.dm-card-title { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; margin-bottom: 10px; }
.dm-card-title.dm-gap { margin-top: 16px; }
.dm-card-meta { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dm-note { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
.dm-muted { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }

.dm-overview { display: flex; flex-direction: column; gap: 10px; padding-bottom: 4px; }
.dm-kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.dm-kpi { min-width: 0; padding: 9px 12px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dm-kpi-label { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-kpi-value { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin: 2px 0 1px; }
.dm-kpi-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; align-items: start; }

.dm-flow { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 8px 6px; align-items: stretch; }
.dm-flow-arrow { display: flex; align-items: center; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dm-flow-step { min-width: 0; border-radius: 9px; padding: 7px 9px; background: var(--dsw-alias-bg-layer-2); }
.dm-flow-step.is-masked { background: color-mix(in srgb, ${ACCENT} 7%, var(--dsw-alias-bg-layer-1)); outline: 1px dashed color-mix(in srgb, ${ACCENT} 35%, transparent); }
.dm-flow-label { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); margin-bottom: 4px; }
.dm-flow-body { font-size: 12px; line-height: 1.7; word-break: break-all; }

.dm-token { display: inline; font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: .86em; padding: 1px 5px; border-radius: 5px;
  color: color-mix(in srgb, var(--dm-hue) 82%, var(--dsw-alias-label-primary)); background: color-mix(in srgb, var(--dm-hue) 13%, transparent); white-space: nowrap; }
.dm-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.dm-chip { display: inline-flex; align-items: center; gap: 2px; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
  background: color-mix(in srgb, var(--dm-hue) 11%, transparent); color: var(--dsw-alias-label-primary); }
.dm-chip b { font-weight: 600; color: color-mix(in srgb, var(--dm-hue) 80%, var(--dsw-alias-label-primary)); }

.dm-scope { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dm-scope-item { display: flex; gap: 9px; align-items: flex-start; }
.dm-scope-mark { width: 20px; height: 20px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; flex: none; margin-top: 1px; }
.dm-scope-item.is-ok .dm-scope-mark { color: var(--dsw-alias-state-success-primary, #16a34a); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 13%, transparent); }
.dm-scope-item.is-off .dm-scope-mark { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dm-scope-item.is-warn .dm-scope-mark { color: var(--dsw-alias-state-warn-primary, #d97706); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 13%, transparent); }
.dm-scope-title { font-size: 12.5px; font-weight: 500; }
.dm-scope-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

.dm-bars { display: flex; flex-direction: column; gap: 9px; }
.dm-bar-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 36px; gap: 8px; align-items: center; font-size: 12px; }
.dm-bar-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary); }
.dm-bar-track { height: 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dm-bar-fill { display: block; height: 100%; border-radius: 999px; transition: width var(--dshp-dur) var(--dshp-ease-out); }
.dm-bar-value { text-align: right; font-variant-numeric: tabular-nums; }
.dm-empty-small { font-size: 12px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); padding: 6px 0; }

.dm-rules { height: 100%; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: 10px; }
.dm-nav { min-height: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.dm-nav-group { align-items: center; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); padding: 8px 8px 4px; }
.dm-nav-group:first-child { padding-top: 2px; }
.dm-nav-item { display: flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); font-family: inherit;
  font-size: 12px; text-align: left; padding: 4px 9px; border-radius: 999px; cursor: pointer; }
.dm-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dm-nav-item.is-active { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); font-weight: 600; }
.dm-nav-add { color: var(--dsw-alias-label-secondary); }
.dm-nav-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-nav-count { font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.dm-nav-foot { margin-top: auto; display: flex; gap: 6px; align-items: flex-start; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); padding: 12px 8px 2px; word-break: break-all; }
.dm-nav-foot svg { margin-top: 2px; }
.dm-nav-group, .dm-nav-foot { display: none; }
.dm-dot { width: 8px; height: 8px; border-radius: 3px; flex: none; }
.dm-rules-body { min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.dm-editor { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 12px; }
.dm-editor-foot { display: flex; justify-content: flex-end; }
.dm-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px; align-items: start; }
.dm-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dm-field.dm-grow { flex: 1; min-height: 180px; }
.dm-field-switch { align-items: flex-start; }
.dm-field-label { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dm-field-meta { margin-left: auto; font-weight: 400; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.dm-field-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dm-lead { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dm-input, .dm-textarea { width: 100%; font-family: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-base)); padding: 6px 9px; transition: border-color var(--dshp-dur-fast) ease, box-shadow var(--dshp-dur-fast) ease; }
.dm-input:focus, .dm-textarea:focus { outline: none; border-color: ${ACCENT}; box-shadow: 0 0 0 3px color-mix(in srgb, ${ACCENT} 16%, transparent); }
.dm-textarea { flex: 1; min-height: 160px; resize: none; line-height: 1.6; }
.dm-mono { font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.dm-pattern { display: grid; grid-template-columns: auto minmax(0, 1fr) 84px auto auto; gap: 6px 8px; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dm-pattern .dm-pattern-regex { grid-column: 2 / -1; grid-row: 2; }
.dm-pattern .dm-check { grid-column: 2 / -1; grid-row: 3; }
.dm-check { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dm-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dm-toggle-row:last-child { border-bottom: 0; }
.dm-toggle-title { font-size: 12.5px; font-weight: 500; }
.dm-problems { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent); border-radius: 10px; padding: 8px 12px; font-size: 12px; }
.dm-problems ul { margin: 4px 0 0; padding-left: 18px; }

.dm-savebar { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dm-savebar-text { margin-right: auto; font-size: 12px; color: var(--dsw-alias-state-warn-primary, #b45309); }
.dm-saved { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-state-success-primary, #16a34a); animation: dm-fade-in var(--dshp-dur) var(--dshp-ease-out); }
@keyframes dm-fade-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }

.dm-try { height: 100%; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.dm-try-pane { min-height: 0; display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; }
.dm-try-pane .dm-card-title { margin-bottom: 0; }
.dm-try-input { min-height: 100px; }
.dm-try-output { flex: 1; min-height: 80px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 9px 11px; }
.dm-masked { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.8; }
.dm-hits { display: flex; flex-direction: column; gap: 6px; }

.dm-history { display: flex; flex-direction: column; gap: 10px; min-height: 100%; }
.dm-history-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dm-only-session { margin-left: auto; }
.dm-history-privacy { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dm-confirm { display: inline-flex; gap: 6px; }
.dm-seg { display: inline-flex; padding: 2px; gap: 1px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.dm-seg-item { display: inline-flex; align-items: center; gap: 5px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; padding: 3px 9px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.dm-seg-item:hover { color: var(--dsw-alias-label-primary); }
.dm-seg-item.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.dm-seg-count { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.dm-list { display: flex; flex-direction: column; gap: 6px; }
.dm-entry { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 8px 12px; display: flex; flex-direction: column; gap: 6px;
  animation: dm-fade-in var(--dshp-dur) var(--dshp-ease-out); }
.dm-entry.is-block { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, var(--dsw-alias-border-l1)); }
.dm-entry-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dm-kind { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 5px; white-space: nowrap; }
.dm-kind.is-mask { color: var(--dsw-alias-state-success-primary, #16a34a); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 12%, transparent); }
.dm-kind.is-block { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.dm-kind.is-tool-block { color: var(--dsw-alias-state-warn-primary, #b45309); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 12%, transparent); }
.dm-entry-tool { font-size: 11.5px; padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); }
.dm-entry-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-entry-time { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); white-space: nowrap; }
.dm-entry-reason { font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.dm-entry-reason.is-clamped { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dm-entry-foot { font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }

.dm-empty { height: 100%; min-height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 24px; }
.dm-empty-icon { width: 44px; height: 44px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dm-empty-title { font-size: 13.5px; font-weight: 600; }
.dm-empty-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); max-width: 460px; }

@container dmroot (max-width: 420px) {
  .dm-row { grid-template-columns: minmax(0, 1fr) auto; }
  .dm-row > .dm-field:nth-child(2) { grid-column: 1 / -1; grid-row: 2; }
  .dm-history-bar .dm-seg-count { display: none; }
}
@container dmroot (min-width: 720px) {
  .dm-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .dm-pattern { grid-template-columns: auto minmax(0, 1fr) 96px minmax(0, 1.6fr) auto auto auto; padding-bottom: 0; border-bottom: 0; }
  .dm-pattern .dm-pattern-regex, .dm-pattern .dm-check { grid-column: auto; grid-row: auto; }
}
@container dmroot (min-width: 900px) {
  .dm-grid { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); }
  .dm-try { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .dm-rules { grid-template-columns: 200px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .dm-nav { flex-direction: column; flex-wrap: nowrap; overflow: auto; gap: 1px; }
  .dm-nav-item { width: 100%; border-color: transparent; border-radius: 7px; padding: 6px 8px; font-size: 12.5px; }
  .dm-nav-group, .dm-nav-foot { display: flex; }
}
`;

    // ---------------------------------------------------------------------------------------
    // Mount
    // ---------------------------------------------------------------------------------------

    const inject = ['slots', 'locale', 'sidebarRightTabs'];
    const TAB_ID = '@local/dsh-data-masking';
    const TAB_KIND = 'data-masking';

    function apply(ctx) {
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en });
        } catch {
          return () => {};
        }
      }, 'data-masking: copy');
      const t = makeTranslate(ctx);
      const subscribeLocale = (listener) => {
        try {
          return ctx.locale.subscribe(listener);
        } catch {
          return () => {};
        }
      };

      // A right-sidebar page per session, opened from the sidebar's guide (like page preview).
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        keepMounted: true,
        title: () => t('page.title'),
        guide: [{
          id: 'data-masking.panel',
          order: 60,
          title: () => t('page.title'),
          description: () => t('guide.description'),
          icon: ShieldIcon,
        }],
      }), 'data-masking: tab type');

      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
        inject: (sessionId) => ({ t, subscribeLocale, sessionId }),
      }, DataMaskingPage));
    }

    return { inject, apply };
  },
});
