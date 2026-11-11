/**
 * On-disk state under `$DSH_HOME/data-masking/` (0600 files):
 *   rules.json               dictionaries, patterns, switches (the only file holding sensitive terms)
 *   secret.key               HMAC key for placeholders (random, created once)
 *   protected-sessions.json  ids of sessions that ever ran with masking on (session-log exclusion)
 *   history.jsonl            interception records: category, length, short preview — never values
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRules, normalizeRules } from './engine.js';

/** JSON.parse messages quote the surrounding source text; keep only the position. */
function parseErrorSummary(error) {
  const message = String(error?.message ?? '');
  const position = message.match(/position (\d+)/);
  const line = message.match(/line (\d+) column (\d+)/);
  if (line) return `JSON 语法错误（第 ${line[1]} 行第 ${line[2]} 列）`;
  if (position) return `JSON 语法错误（位置 ${position[1]}）`;
  return 'JSON 语法错误';
}

const HISTORY_KEEP = 2000;
const HISTORY_COMPACT_AT = 3000;

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.paths = {
      rules: join(dataDir, 'rules.json'),
      secret: join(dataDir, 'secret.key'),
      sessions: join(dataDir, 'protected-sessions.json'),
      history: join(dataDir, 'history.jsonl'),
    };
    this.historyLines = null;
  }

  ensureDir() {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Missing file -> defaults (masking off). Unreadable or invalid file -> throws, so the caller can
   * fail closed instead of treating a broken rules file as "no rules".
   */
  loadRules() {
    if (!existsSync(this.paths.rules)) return defaultRules();
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.paths.rules, 'utf8'));
    } catch (error) {
      throw new Error(`规则文件无法解析（${this.paths.rules}）：${parseErrorSummary(error)}`);
    }
    try {
      return normalizeRules(parsed);
    } catch (error) {
      throw new Error(`规则文件校验失败（${this.paths.rules}）：${error.message}`);
    }
  }

  saveRules(rules) {
    this.ensureDir();
    writeAtomic(this.paths.rules, `${JSON.stringify(rules, null, 2)}\n`);
  }

  loadSecret() {
    this.ensureDir();
    if (existsSync(this.paths.secret)) {
      const key = readFileSync(this.paths.secret);
      if (key.length >= 32) return key;
    }
    const key = randomBytes(32);
    writeFileSync(this.paths.secret, key, { mode: 0o600 });
    try {
      chmodSync(this.paths.secret, 0o600);
    } catch {
      // best effort on platforms without POSIX modes
    }
    return key;
  }

  loadProtectedSessions() {
    if (!existsSync(this.paths.sessions)) return new Set();
    try {
      const list = JSON.parse(readFileSync(this.paths.sessions, 'utf8'));
      return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
    } catch (error) {
      throw new Error(`受保护会话列表无法解析（${this.paths.sessions}）：${parseErrorSummary(error)}`);
    }
  }

  saveProtectedSessions(set) {
    this.ensureDir();
    writeAtomic(this.paths.sessions, `${JSON.stringify([...set])}\n`);
  }

  appendHistory(entry) {
    this.ensureDir();
    const record = { id: randomUUID(), at: Date.now(), ...entry };
    appendFileSync(this.paths.history, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (this.historyLines !== null) this.historyLines += 1;
    else this.historyLines = this.readHistoryRaw().length;
    if (this.historyLines > HISTORY_COMPACT_AT) {
      const kept = this.readHistoryRaw().slice(-HISTORY_KEEP);
      writeAtomic(this.paths.history, kept.length ? `${kept.join('\n')}\n` : '');
      this.historyLines = kept.length;
    }
    return record;
  }

  readHistoryRaw() {
    if (!existsSync(this.paths.history)) return [];
    return readFileSync(this.paths.history, 'utf8').split('\n').filter((line) => line.trim() !== '');
  }

  /** Newest first. */
  readHistory({ limit = 200, before, sessionId } = {}) {
    const out = [];
    const lines = this.readHistoryRaw();
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (before !== undefined && record.at >= before) continue;
      if (sessionId !== undefined && record.sessionId !== sessionId) continue;
      out.push(record);
    }
    return { entries: out, total: lines.length };
  }

  clearHistory() {
    this.ensureDir();
    writeAtomic(this.paths.history, '');
    this.historyLines = 0;
  }
}
