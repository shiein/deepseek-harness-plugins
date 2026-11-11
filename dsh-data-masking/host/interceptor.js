/**
 * Runtime core, independent of Cordis so it can be unit-tested with fakes.
 *
 * Fail-closed rules (masking on, or its state unknown):
 *   - rules file unreadable/invalid            -> every model request is blocked
 *   - DSH internal adapter entry point missing  -> blocked (DSH upgrade changed the seam)
 *   - session-log uploader present but our exclusion not registered -> blocked
 *   - masking throws                            -> blocked
 * A blocked request ends as a terminal `finish` error chunk with code DATA_MASKING_BLOCKED; nothing
 * is sent to the provider.
 */

import { Masker, Vault, compileRules, previewOf, TOKEN_RE } from './engine.js';
import { maskRequest } from './request.js';
import { restoreStream } from './restore.js';

export const BLOCKED_CODE = 'DATA_MASKING_BLOCKED';
const SEEN_SESSIONS_LIMIT = 500;
const LITERAL_LIMIT = 5000;

/** Every string leaf of a parsed tool-argument value (keys excluded). */
function stringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringLeaves(item, out);
  return out;
}

async function* blockedStream(message) {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: BLOCKED_CODE, message: `数据脱敏：${message}` } } };
}

function toolNameMatches(name, patterns) {
  for (const pattern of patterns) {
    if (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern) return true;
  }
  return false;
}

export class Interceptor {
  /**
   * @param {{ store: import('./store.js').Store, logger?: any, sessionLogPresent?: () => boolean }} deps
   */
  constructor({ store, logger, sessionLogPresent = () => false }) {
    this.store = store;
    this.logger = logger;
    this.sessionLogPresent = sessionLogPresent;
    this.exclusionActive = false;
    this.rules = null;
    this.rulesError = null;
    this.matcher = null;
    this.masker = null;
    this.protectedSessions = new Set();
    this.protectedError = null;
    this.seen = new Map(); // sessionId -> Set<token> already recorded in history
    this.counters = { requests: 0, masked: 0, blocked: 0 };
    this.literals = new Set(); // placeholder-shaped text seen verbatim in outgoing requests
    this.secret = store.loadSecret();
    this.reload();
    try {
      this.protectedSessions = store.loadProtectedSessions();
    } catch (error) {
      this.protectedError = error.message;
    }
  }

  /** Re-read rules from disk. */
  reload() {
    try {
      this.applyRules(this.store.loadRules());
      this.rulesError = null;
    } catch (error) {
      this.rules = null;
      this.matcher = null;
      this.masker = null;
      this.rulesError = error.message;
      this.logger?.warn?.(`[data-masking] ${error.message}`);
    }
  }

  applyRules(rules) {
    this.matcher = compileRules(rules, this.secret);
    this.masker = new Masker(this.matcher);
    this.masker.literalSink = (token) => {
      if (this.literals.has(token)) return;
      if (this.literals.size >= LITERAL_LIMIT) this.literals.delete(this.literals.values().next().value);
      this.literals.add(token);
    };
    this.rules = rules;
    this.seen.clear();
  }

  /** Validated rules -> disk -> live. */
  saveRules(rules) {
    this.store.saveRules(rules);
    this.applyRules(rules);
    this.rulesError = null;
  }

  /** null when masking is definitely off; true when on or unknown (fail closed). */
  get active() {
    if (this.rulesError) return true;
    return this.rules?.enabled === true;
  }

  status(llm) {
    return {
      enabled: this.rules?.enabled === true,
      rulesError: this.rulesError,
      protectedError: this.protectedError,
      interceptorReady: typeof llm?.adapterStream === 'function',
      sessionLogPresent: this.sessionLogPresent(),
      sessionLogGuarded: this.exclusionActive,
      protectedSessions: this.protectedSessions.size,
      counters: { ...this.counters },
    };
  }

  /** Session-log upload predicate: synchronous, memory only. */
  excludeSessionLog(upload) {
    if (this.active) return true;
    return typeof upload?.sessionId === 'string' && this.protectedSessions.has(upload.sessionId);
  }

  /**
   * `llm/stream` listener body.
   * @param {any} options
   * @param {() => AsyncIterable<any>} next
   * @param {any} llm the LlmRuntime instance
   */
  onStream(options, next, llm) {
    if (!this.active) return next();
    this.counters.requests += 1;
    const block = (reason) => {
      this.counters.blocked += 1;
      this.record({ kind: 'block', reason, sessionId: options?.sessionId, provider: options?.provider, model: options?.model });
      this.logger?.warn?.(`[data-masking] blocked a model request: ${reason}`);
      return blockedStream(reason);
    };
    if (this.rulesError) return block(`规则文件有误，已阻止发送。${this.rulesError}`);
    if (this.protectedError) return block(`受保护会话列表有误，已阻止发送。${this.protectedError}`);
    if (typeof llm?.adapterStream !== 'function') return block('当前 DSH 版本缺少脱敏所需的内部接口，已阻止发送。请升级插件或关闭脱敏。');
    if (this.sessionLogPresent() && !this.exclusionActive) return block('Session Log 上传保护尚未就绪，已阻止发送。');

    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined;
    if (sessionId && !this.protectedSessions.has(sessionId)) {
      try {
        const next = new Set(this.protectedSessions);
        next.add(sessionId);
        this.store.saveProtectedSessions(next);
        this.protectedSessions = next;
      } catch (error) {
        return block(`无法记录受保护会话：${error.message}`);
      }
    }

    const vault = new Vault(this.matcher);
    const hits = [];
    let masked;
    try {
      masked = maskRequest(options, this.masker, vault, hits, (ref) => {
        if (typeof llm.fileRequestText !== 'function') throw new Error('DSH 缺少文件引用投影接口');
        return llm.fileRequestText(ref);
      });
    } catch (error) {
      return block(`脱敏失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (hits.length === 0) return next();
    this.counters.masked += 1;
    this.recordHits(sessionId, options, hits);
    return restoreStream(llm.adapterStream(masked), vault);
  }

  /** Only values new to this session are recorded, so re-sent history is not counted again. */
  recordHits(sessionId, options, hits) {
    const key = sessionId ?? '(no-session)';
    let seen = this.seen.get(key);
    if (!seen) {
      if (this.seen.size >= SEEN_SESSIONS_LIMIT) this.seen.delete(this.seen.keys().next().value);
      seen = new Set();
      this.seen.set(key, seen);
    }
    const fresh = new Map();
    for (const hit of hits) {
      if (seen.has(hit.token)) continue;
      const item = fresh.get(hit.token);
      if (item) item.count += 1;
      else fresh.set(hit.token, { code: hit.code, label: this.matcher.labelOf(hit.code), preview: previewOf(hit.value), length: [...hit.value].length, ruleId: hit.ruleId, count: 1 });
    }
    if (fresh.size === 0) return;
    for (const token of fresh.keys()) seen.add(token);
    this.record({
      kind: 'mask',
      sessionId,
      provider: options.provider,
      model: options.model,
      items: [...fresh.values()],
      occurrences: hits.length,
    });
  }

  record(entry) {
    try {
      this.store.appendHistory(entry);
    } catch (error) {
      this.logger?.warn?.(`[data-masking] history write failed: ${error.message}`);
    }
  }

  /**
   * `ctx.tools.guard` body. Returns a model-visible denial reason or undefined.
   * Never echoes the protected value itself.
   */
  guardTool(exec) {
    if (!this.active || !this.matcher) return undefined;
    const leaves = stringLeaves(exec?.arguments);
    // A placeholder that survived restore and never appeared verbatim in a request was invented or
    // mangled by the model; writing it would put a placeholder into a real file.
    for (const leaf of leaves) {
      if (!leaf.includes('{{')) continue;
      TOKEN_RE.lastIndex = 0;
      for (let m = TOKEN_RE.exec(leaf); m; m = TOKEN_RE.exec(leaf)) {
        if (!this.matcher.codes.has(m[1]) || this.literals.has(m[0])) continue;
        this.record({ kind: 'tool-block', tool: exec?.name, reason: 'unresolved-placeholder', sessionId: sessionOf(exec) });
        return `参数中的占位符 ${m[0]} 无法还原为原值（不是对话中出现过的占位符）。请原样使用对话里已有的占位符，不要改写或自造占位符。`;
      }
    }
    if (typeof exec?.name === 'string' && toolNameMatches(exec.name, this.rules.blockedTools)) {
      const matches = leaves.flatMap((leaf) => this.matcher.find(leaf));
      if (matches.length > 0) {
        const labels = [...new Set(matches.map((match) => this.matcher.labelOf(match.code)))];
        this.record({
          kind: 'tool-block',
          tool: exec.name,
          reason: 'network-tool',
          sessionId: sessionOf(exec),
          items: matches.slice(0, 20).map((match) => ({ code: match.code, label: this.matcher.labelOf(match.code), preview: previewOf(match.value), length: [...match.value].length })),
        });
        return `工具 ${exec.name} 会把参数发送到外部服务，而参数中含有受保护的数据（${labels.join('、')}），已被数据脱敏插件拦截。请改用不含这些信息的参数，或改用本地工具完成。`;
      }
    }
    return undefined;
  }

  /** Try-it preview for the UI: masks `text` with the live (or draft) rules. */
  preview(text, rules) {
    const matcher = rules ? compileRules(rules, this.secret) : this.matcher;
    if (!matcher) throw new Error(this.rulesError ?? '规则未加载');
    const masker = new Masker(matcher, { memoLimit: 0 });
    const vault = new Vault(matcher);
    const hits = [];
    const masked = masker.maskText(text, vault, hits);
    const items = new Map();
    for (const hit of hits) {
      const item = items.get(hit.token);
      if (item) item.count += 1;
      else items.set(hit.token, { token: hit.token, code: hit.code, label: matcher.labelOf(hit.code), preview: previewOf(hit.value), count: 1 });
    }
    return { masked, items: [...items.values()] };
  }
}

function sessionOf(exec) {
  const id = exec?.agent?.session?.id ?? exec?.agent?.sessionId;
  return typeof id === 'string' ? id : undefined;
}
