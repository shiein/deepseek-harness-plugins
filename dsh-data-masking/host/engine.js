/**
 * Masking engine: rules -> matcher -> deterministic placeholders.
 *
 * Pure module (no I/O). A value always maps to the same placeholder for a given secret, so the
 * masked request history is byte-stable across requests (provider prompt caches keep hitting) and
 * the model's own earlier output, which only ever contained placeholders, replays unchanged.
 *
 * Placeholder shape: `{{CODE_hhhhhh}}` — CODE names the category (REGION, DEPT, PERSON …) so the
 * model still knows what kind of thing it is looking at; the hex suffix is an HMAC of the value.
 */

import { createHmac } from 'node:crypto';

export const TOKEN_RE = /\{\{([A-Z][A-Z0-9]{0,15})_([0-9a-f]{6,16})\}\}/g;
const CODE_RE = /^[A-Z][A-Z0-9]{0,15}$/;
const MAX_TERM_LENGTH = 200;
const MAX_PATTERN_LENGTH = 300;
const MAX_TERMS = 20000;

/** Built-in personal-data detectors, off by default. */
export const BUILTINS = {
  phone: { code: 'PHONE', label: '手机号', regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  idcard: {
    code: 'IDCARD',
    label: '身份证号',
    regex: /(?<![0-9A-Za-z])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/g,
    check: idCardChecksumOk,
  },
  email: {
    code: 'EMAIL',
    label: '邮箱',
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    check: (value) => !/@(?:[^@]*\.)?(?:example\.(?:com|org|net)|test|invalid|localhost)$/i.test(value),
  },
};

export const DEFAULT_CATEGORIES = [
  { id: 'region', code: 'REGION', label: '区域' },
  { id: 'dept', code: 'DEPT', label: '部门' },
  { id: 'term', code: 'TERM', label: '术语' },
  { id: 'person', code: 'PERSON', label: '人员' },
  { id: 'addr', code: 'ADDR', label: '地址' },
];

export const DEFAULT_BLOCKED_TOOLS = ['web_search', 'web_fetch'];

export function defaultRules() {
  return {
    version: 1,
    enabled: false,
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category, enabled: true, terms: [] })),
    patterns: [],
    builtins: { phone: false, idcard: false, email: false },
    allowlist: [],
    blockedTools: [...DEFAULT_BLOCKED_TOOLS],
  };
}

function idCardChecksumOk(value) {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(value[i]) * weights[i];
  return checks[sum % 11] === value[17].toUpperCase();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate and normalize a rules document. Throws an Error listing every problem, so a broken file
 * or form never silently degrades to "fewer rules".
 * @param {unknown} input
 */
export function normalizeRules(input) {
  const problems = [];
  const src = input && typeof input === 'object' ? input : {};
  const base = defaultRules();
  const out = {
    version: 1,
    enabled: src.enabled === true,
    categories: [],
    patterns: [],
    builtins: { ...base.builtins },
    allowlist: [],
    blockedTools: [],
  };
  const codes = new Set();
  const categories = Array.isArray(src.categories) ? src.categories : base.categories;
  let termCount = 0;
  for (const [index, raw] of categories.entries()) {
    const label = typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim() : `分类 ${index + 1}`;
    const code = typeof raw?.code === 'string' ? raw.code.trim().toUpperCase() : '';
    if (!CODE_RE.test(code)) problems.push(`分类「${label}」的代号必须是大写字母开头的 1–16 位字母或数字`);
    else if (codes.has(code)) problems.push(`代号 ${code} 重复`);
    codes.add(code);
    const terms = [];
    const seen = new Set();
    for (const term of Array.isArray(raw?.terms) ? raw.terms : []) {
      if (typeof term !== 'string') continue;
      const value = term.trim();
      if (!value || seen.has(value)) continue;
      if (value.length > MAX_TERM_LENGTH) {
        problems.push(`分类「${label}」中有词条超过 ${MAX_TERM_LENGTH} 字`);
        continue;
      }
      seen.add(value);
      terms.push(value);
    }
    termCount += terms.length;
    out.categories.push({
      id: typeof raw?.id === 'string' && raw.id ? raw.id : `c${index}`,
      code,
      label,
      enabled: raw?.enabled !== false,
      terms,
    });
  }
  if (termCount > MAX_TERMS) problems.push(`词条总数 ${termCount} 超过上限 ${MAX_TERMS}`);
  for (const [index, raw] of (Array.isArray(src.patterns) ? src.patterns : []).entries()) {
    const label = typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim() : `规则 ${index + 1}`;
    const code = typeof raw?.code === 'string' ? raw.code.trim().toUpperCase() : '';
    const regex = typeof raw?.regex === 'string' ? raw.regex : '';
    if (!CODE_RE.test(code)) problems.push(`规则「${label}」的代号必须是大写字母开头的 1–16 位字母或数字`);
    else if (codes.has(code)) problems.push(`代号 ${code} 重复`);
    codes.add(code);
    const error = patternError(regex);
    if (error) problems.push(`规则「${label}」：${error}`);
    out.patterns.push({
      id: typeof raw?.id === 'string' && raw.id ? raw.id : `p${index}`,
      code,
      label,
      regex,
      ignoreCase: raw?.ignoreCase === true,
      enabled: raw?.enabled !== false,
    });
  }
  for (const key of Object.keys(BUILTINS)) {
    out.builtins[key] = src.builtins?.[key] === true;
    if (codes.has(BUILTINS[key].code)) problems.push(`代号 ${BUILTINS[key].code} 为内置规则保留`);
  }
  out.allowlist = uniqueStrings(src.allowlist);
  out.blockedTools = Array.isArray(src.blockedTools) ? uniqueStrings(src.blockedTools) : [...DEFAULT_BLOCKED_TOOLS];
  if (problems.length > 0) {
    const error = new Error(problems.join('；'));
    error.problems = problems;
    throw error;
  }
  return out;
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** Reject patterns that cannot compile, match the empty string, or are suspiciously large. */
export function patternError(source) {
  if (typeof source !== 'string' || source === '') return '正则不能为空';
  if (source.length > MAX_PATTERN_LENGTH) return `正则长度超过 ${MAX_PATTERN_LENGTH}`;
  // Nested unbounded quantifiers ((a+)+, (a*)*, …) are the classic catastrophic-backtracking shape.
  if (/\([^()]*[+*][^()]*\)[+*{]/.test(source)) return '包含嵌套的重复量词（可能导致回溯失控），请改写';
  let re;
  try {
    re = new RegExp(source, 'gu');
  } catch (error) {
    return `无法编译：${error.message}`;
  }
  re.lastIndex = 0;
  if (re.test('')) return '会匹配空字符串';
  return null;
}

/**
 * Compile normalized rules into a matcher.
 * @param {ReturnType<typeof normalizeRules>} rules
 * @param {string|Buffer} secret HMAC key that makes placeholders unguessable and stable.
 */
export function compileRules(rules, secret) {
  const termOwner = new Map(); // term -> category (first category wins)
  for (const category of rules.categories) {
    if (!category.enabled) continue;
    for (const term of category.terms) if (!termOwner.has(term)) termOwner.set(term, category);
  }
  const terms = [...termOwner.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const termRegex = terms.length > 0 ? new RegExp(terms.map(escapeRegExp).join('|'), 'g') : null;
  const detectors = [];
  for (const pattern of rules.patterns) {
    if (!pattern.enabled) continue;
    detectors.push({ code: pattern.code, label: pattern.label, ruleId: pattern.id, regex: new RegExp(pattern.regex, pattern.ignoreCase ? 'giu' : 'gu') });
  }
  for (const [key, builtin] of Object.entries(BUILTINS)) {
    if (!rules.builtins[key]) continue;
    detectors.push({ code: builtin.code, label: builtin.label, ruleId: `builtin:${key}`, regex: new RegExp(builtin.regex.source, 'g'), check: builtin.check });
  }
  const allow = new Set(rules.allowlist);
  const labels = new Map();
  for (const category of rules.categories) labels.set(category.code, category.label);
  for (const pattern of rules.patterns) labels.set(pattern.code, pattern.label);
  for (const builtin of Object.values(BUILTINS)) labels.set(builtin.code, builtin.label);

  /** All non-overlapping matches in `text`, earliest first, longest wins at the same start. */
  function find(text) {
    const found = [];
    if (termRegex) {
      termRegex.lastIndex = 0;
      for (let m = termRegex.exec(text); m; m = termRegex.exec(text)) {
        const category = termOwner.get(m[0]);
        found.push({ start: m.index, end: m.index + m[0].length, value: m[0], code: category.code, ruleId: category.id });
      }
    }
    for (const detector of detectors) {
      detector.regex.lastIndex = 0;
      for (let m = detector.regex.exec(text); m; m = detector.regex.exec(text)) {
        if (m[0] === '') {
          detector.regex.lastIndex += 1;
          continue;
        }
        if (detector.check && !detector.check(m[0])) continue;
        found.push({ start: m.index, end: m.index + m[0].length, value: m[0], code: detector.code, ruleId: detector.ruleId });
      }
    }
    if (found.length === 0) return found;
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    // Never mask inside text that already is a placeholder (e.g. a term "DEPT").
    const tokenSpans = [];
    if (text.includes('{{')) {
      TOKEN_RE.lastIndex = 0;
      for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) tokenSpans.push([m.index, m.index + m[0].length]);
    }
    const kept = [];
    let cursor = -1;
    for (const match of found) {
      if (match.start < cursor) continue;
      if (allow.has(match.value)) continue;
      if (tokenSpans.some(([start, end]) => match.start < end && match.end > start)) continue;
      kept.push(match);
      cursor = match.end;
    }
    return kept;
  }

  function tokenFor(code, value, length = 6) {
    const hex = createHmac('sha256', secret).update(`${code}\0${value}`).digest('hex');
    return `{{${code}_${hex.slice(0, length)}}}`;
  }

  return {
    empty: terms.length === 0 && detectors.length === 0,
    find,
    tokenFor,
    labelOf: (code) => labels.get(code) ?? code,
    codes: new Set(labels.keys()),
  };
}

/**
 * Per-request vault: token <-> value, with collision handling. Tokens are deterministic, so a
 * fresh vault per request reproduces the same tokens; the vault is what restore uses.
 */
export class Vault {
  constructor(matcher) {
    this.matcher = matcher;
    this.byToken = new Map();
    this.byValue = new Map();
  }

  token(code, value) {
    const key = `${code}\0${value}`;
    const known = this.byValue.get(key);
    if (known) return known;
    for (let length = 6; length <= 16; length += 2) {
      const token = this.matcher.tokenFor(code, value, length);
      const owner = this.byToken.get(token);
      if (owner === undefined || owner.value === value) {
        this.byToken.set(token, { code, value });
        this.byValue.set(key, token);
        return token;
      }
    }
    throw new Error('placeholder collision could not be resolved');
  }

  valueOf(token) {
    return this.byToken.get(token)?.value;
  }
}

/** Placeholders in `text` that look like ours (category code configured) but are not in the vault. */
export function unresolvedTokens(text, vault, codes) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('{{')) return out;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    if (codes.has(m[1]) && vault.valueOf(m[0]) === undefined) out.push(m[0]);
  }
  return out;
}

/**
 * Masks strings, memoizing per input string (the whole history is re-sent on every request).
 * The memo is bound to one compiled matcher; build a new Masker when rules change.
 */
export class Masker {
  constructor(matcher, { memoLimit = 20000, memoChars = 32 * 1024 * 1024 } = {}) {
    this.matcher = matcher;
    this.memo = new Map();
    this.memoLimit = memoLimit;
    this.memoChars = memoChars;
    this.memoSize = 0;
  }

  /**
   * @param {string} text
   * @param {Vault} vault
   * @param {Array} hits receives {code, value, token, ruleId}
   */
  maskText(text, vault, hits) {
    if (typeof text !== 'string' || text === '') return text;
    // Placeholder-shaped text that already exists in files/messages (docs, tests, fixtures) is
    // remembered, so the tool guard does not mistake a faithful copy of it for a mangled token.
    if (this.literalSink && text.includes('{{')) {
      TOKEN_RE.lastIndex = 0;
      for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) this.literalSink(m[0]);
    }
    if (this.matcher.empty) return text;
    let entry = this.memo.get(text);
    if (entry === undefined) {
      const matches = this.matcher.find(text);
      entry = matches.length === 0 ? null : matches;
      // Bounded by entry count and by total key length (tool results can be large files).
      if (text.length <= this.memoChars / 4) {
        while (this.memo.size > 0 && (this.memo.size >= this.memoLimit || this.memoSize + text.length > this.memoChars)) {
          const oldest = this.memo.keys().next().value;
          this.memo.delete(oldest);
          this.memoSize -= oldest.length;
        }
        if (this.memoLimit > 0) {
          this.memo.set(text, entry);
          this.memoSize += text.length;
        }
      }
    }
    if (entry === null) return text;
    let out = '';
    let cursor = 0;
    for (const match of entry) {
      const token = vault.token(match.code, match.value);
      out += text.slice(cursor, match.start) + token;
      cursor = match.end;
      hits.push({ code: match.code, value: match.value, token, ruleId: match.ruleId });
    }
    return out + text.slice(cursor);
  }

  /** Mask the decoded string values of a raw JSON argument string; keys and structure are kept. */
  maskJson(raw, vault, hits) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.maskText(raw, vault, hits);
    }
    const before = hits.length;
    const walk = (value) => {
      if (typeof value === 'string') return this.maskText(value, vault, hits);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        const next = {};
        for (const [key, item] of Object.entries(value)) next[key] = walk(item);
        return next;
      }
      return value;
    };
    const masked = walk(parsed);
    return hits.length === before ? raw : JSON.stringify(masked);
  }
}

/** Short display form of a sensitive value that never reveals the whole thing. */
export function previewOf(value) {
  const chars = [...value];
  if (chars.length <= 1) return '*';
  const shown = chars.length >= 8 ? 2 : 1;
  return chars.slice(0, shown).join('') + '*'.repeat(Math.min(chars.length - shown, 8));
}
