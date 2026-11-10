/**
 * On-demand transcript reading and the merged project timeline.
 *
 * The snapshot only carries session *summaries*: a full transcript is read when the user opens a
 * session or a project timeline, then kept in a bounded in-memory cache keyed by the session's
 * `updatedAt` so a re-open is instant and a changed session re-reads itself.
 */

import { finalizeMessages, previewText } from './model.js';

const MAX_CACHED_TRANSCRIPTS = 80;
const MAX_CACHED_TIMELINES = 400;
/** Hard ceiling for one cached transcript so a giant session cannot pin memory. */
const MAX_TRANSCRIPT_CHARS = 2_000_000;
/**
 * Total text budget per cache. The count limits alone allow 80 × 2M chars; a few long sessions
 * should evict older ones instead. The most recent entry is always kept, whatever its size.
 */
const MAX_CACHED_TRANSCRIPT_CHARS = 24_000_000;
const MAX_CACHED_TIMELINE_CHARS = 24_000_000;
/**
 * Searchable text kept per session for full-text search. Search visits the same most-recent
 * sessions in the same order every time, which an LRU smaller than that set turns into a miss on
 * every visit; so this cache admits entries until its budget is full and then stops admitting
 * (see {@link TranscriptReader#getSearchText}) instead of evicting what the next search reads first.
 * The texts are the transcript's own strings, so an entry also held by `cache` costs no extra text.
 */
const MAX_CACHED_SEARCH_SESSIONS = 400;
const MAX_CACHED_SEARCH_CHARS = 24_000_000;

export class TranscriptReader {
  /**
   * @param {{read: (session: import('./types.js').SessionSummary, signal: AbortSignal) =>
   *            Promise<{supported: boolean, messages: Array<import('./types.js').TranscriptMessage>}>}} options
   */
  constructor(options) {
    this.read = options.read;
    /**
     * Current version of a session's source. The snapshot's `updatedAt` only changes on a scan,
     * so without this a session that is still being written would show its old transcript.
     */
    this.version = options.version;
    /** @type {Map<string, {key: string, supported: boolean, messages: Array<import('./types.js').TranscriptMessage>}>} */
    this.cache = new Map();
    /** Timeline reads keep only the readable slice of each session. @type {Map<string, {key: string, messages: any[]}>} */
    this.timelineCache = new Map();
    /** @type {Map<string, {key: string, texts: Array<{text: string, ts: number}>, chars: number}>} */
    this.searchCache = new Map();
    /** Reads in progress, so concurrent requests for one session version share one read. @type {Map<string, {key: string, promise: Promise<any>}>} */
    this.pending = new Map();
    this.cacheChars = 0;
    this.timelineCacheChars = 0;
    this.searchCacheChars = 0;
  }

  /**
   * Read and finalize one transcript, joining a read of the same session version already in
   * progress. The joined read runs with the first caller's signal; a failure reaches every caller
   * and is not remembered, so the next request retries.
   * @param {import('./types.js').SessionSummary} session @param {AbortSignal} signal @param {string} key
   */
  load(session, signal, key) {
    const running = this.pending.get(session.id);
    if (running && running.key === key) return running.promise;
    const promise = (async () => {
      const result = await this.read(session, signal);
      const complete = finalizeMessages(result?.messages || []);
      const messages = limitTranscriptChars(complete);
      return { key, supported: Boolean(result?.supported), messages, chars: messageChars(messages), clipped: messages !== complete };
    })().finally(() => {
      if (this.pending.get(session.id)?.promise === promise) this.pending.delete(session.id);
    });
    this.pending.set(session.id, { key, promise });
    return promise;
  }

  /** @param {import('./types.js').SessionSummary} session */
  async keyOf(session) {
    return `${session.updatedAt}:${this.version === undefined ? '' : await this.version(session)}`;
  }

  /** @param {import('./types.js').SessionSummary} session @param {AbortSignal} signal */
  async get(session, signal) {
    const key = await this.keyOf(session);
    const cached = this.cache.get(session.id);
    if (cached && cached.key === key) {
      // Refresh recency without re-reading the transcript.
      this.cache.delete(session.id);
      this.cache.set(session.id, cached);
      return cached;
    }
    // A failed read propagates and is NOT cached: caching it as an empty transcript would hide the
    // error and pin the empty result until the session changes.
    const entry = await this.load(session, signal, key);
    this.cacheChars = putBounded(this.cache, this.cacheChars, session.id, entry, MAX_CACHED_TRANSCRIPTS, MAX_CACHED_TRANSCRIPT_CHARS);
    return entry;
  }

  /**
   * The messages full-text search looks at (no tool plumbing, no system notes), from a cache of its
   * own so a search neither re-reads every transcript each time nor evicts the transcripts the user
   * opened. A failed read propagates and is not cached.
   * @param {import('./types.js').SessionSummary} session @param {AbortSignal} signal
   * @returns {Promise<Array<{text: string, ts: number}>>}
   */
  async getSearchText(session, signal) {
    const key = await this.keyOf(session);
    const cached = this.searchCache.get(session.id);
    if (cached && cached.key === key) return cached.texts;
    const full = this.cache.get(session.id);
    const entry = full && full.key === key ? full : await this.load(session, signal, key);
    const texts = [];
    let chars = 0;
    for (const message of entry.messages) {
      if (message.kind === 'tool-call' || message.kind === 'tool-result' || message.role === 'system') continue;
      texts.push({ text: message.text, ts: message.ts });
      chars += message.text.length;
    }
    this.searchCacheChars -= cached?.chars || 0;
    this.searchCache.delete(session.id);
    // Admit while it fits; once full, keep what is cached (the sessions every search starts with).
    if (this.searchCache.size < MAX_CACHED_SEARCH_SESSIONS && this.searchCacheChars + chars <= MAX_CACHED_SEARCH_CHARS) {
      this.searchCache.set(session.id, { key, texts, chars });
      this.searchCacheChars += chars;
    }
    return texts;
  }

  /**
   * Drop search entries of sessions the next search will not visit, so the admission budget goes to
   * the current most recent sessions rather than ones that fell out of that set.
   * @param {Set<string>} ids
   */
  retainSearch(ids) {
    for (const [id, entry] of this.searchCache) {
      if (ids.has(id)) continue;
      this.searchCache.delete(id);
      this.searchCacheChars -= entry.chars;
    }
  }

  /**
   * Read the slice of a transcript that the merged project timeline needs: most messages of most
   * sessions, but a bounded tail for very long ones. Cached separately from the full transcript so
   * one session can serve both views without reading twice per scan generation.
   * @param {import('./types.js').SessionSummary} session
   * @param {AbortSignal} signal
   * @param {number} [maxMessages]
   * A failed read returns `error` with no messages and is not cached, so the next request retries;
   * one unreadable session must not fail the whole merged timeline.
   * @returns {Promise<{messages: Array<import('./types.js').TranscriptMessage>, truncated: boolean, error?: string}>}
   */
  async getForTimeline(session, signal, maxMessages = 300) {
    const key = `${await this.keyOf(session)}:${maxMessages}`;
    const cached = this.timelineCache.get(session.id);
    if (cached && cached.key === key) {
      this.timelineCache.delete(session.id);
      this.timelineCache.set(session.id, cached);
      return { messages: cached.messages, truncated: cached.truncated };
    }
    let entry;
    try {
      entry = await this.get(session, signal);
    } catch (error) {
      return { messages: [], truncated: false, error: error instanceof Error ? error.message : String(error) };
    }
    const readable = entry.messages.filter((message) => message.role !== 'system');
    const truncated = readable.length > maxMessages || entry.clipped === true;
    // Keep the tail: the latest work of a very long session is what the merged view reads.
    const sliced = readable.length > maxMessages ? readable.slice(readable.length - maxMessages) : readable;
    const slice = { key, messages: sliced, truncated, chars: messageChars(sliced) };
    this.timelineCacheChars = putBounded(
      this.timelineCache, this.timelineCacheChars, session.id, slice, MAX_CACHED_TIMELINES, MAX_CACHED_TIMELINE_CHARS,
    );
    return { messages: sliced, truncated };
  }

  /** @param {string} sessionId */
  forget(sessionId) {
    this.cacheChars -= this.cache.get(sessionId)?.chars || 0;
    this.timelineCacheChars -= this.timelineCache.get(sessionId)?.chars || 0;
    this.searchCacheChars -= this.searchCache.get(sessionId)?.chars || 0;
    this.cache.delete(sessionId);
    this.timelineCache.delete(sessionId);
    this.searchCache.delete(sessionId);
  }
}

/** @param {Array<{text: string}>} messages */
function messageChars(messages) {
  let total = 0;
  for (const message of messages) total += message.text.length;
  return total;
}

/**
 * Insert `entry` as the most recent item of an LRU map, then evict the oldest items until both the
 * count and the char budget hold (the new entry itself is never evicted). Returns the new char total.
 * @param {Map<string, {chars: number}>} map
 */
function putBounded(map, totalChars, id, entry, maxEntries, maxChars) {
  let total = totalChars - (map.get(id)?.chars || 0);
  map.delete(id);
  map.set(id, entry);
  total += entry.chars;
  for (const [oldId, oldEntry] of map) {
    if (map.size <= 1 || (map.size <= maxEntries && total <= maxChars)) break;
    if (oldId === id) continue;
    map.delete(oldId);
    total -= oldEntry.chars;
  }
  return total;
}

/** Keep one transcript under the memory ceiling, dropping the oldest messages first. @param {any[]} messages */
function limitTranscriptChars(messages) {
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    total += messages[index].text.length;
    if (total > MAX_TRANSCRIPT_CHARS) {
      const kept = messages.slice(index + 1);
      kept.unshift({ role: 'system', ts: 0, text: `…（较早的 ${index + 1} 条消息已省略）` });
      return kept;
    }
  }
  return messages;
}

/**
 * Merge the messages of every session of one project into one chronological event stream.
 *
 * Parallel development is the normal case (several agents working the same folder at once), so the
 * stream is ordered by message time and every event keeps its agent and session identity; the UI
 * draws the agent rail and can jump back to the owning session.
 *
 * @param {Array<{session: import('./types.js').SessionSummary, messages: Array<import('./types.js').TranscriptMessage>}>} inputs
 * @param {{limit?: number, cursor?: string, order?: 'asc'|'desc', role?: 'all'|'user'|'assistant', query?: string}} options
 *   cursor = key of the last returned event; `order` defaults to newest first; `role` / `query`
 *   filter before pagination so `total` and the cursor always describe the filtered stream.
 * @returns {{events: Array<Object>, nextCursor: string|null, total: number, cursorLost: boolean}}
 */
export function buildTimeline(inputs, options = {}) {
  const limit = Math.max(1, Math.min(500, options.limit || 200));
  const order = options.order === 'asc' ? 'asc' : 'desc';
  const role = options.role === 'user' || options.role === 'assistant' ? options.role : 'all';
  const needle = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  const events = [];
  for (const input of inputs) {
    const session = input.session;
    let index = 0;
    for (const message of input.messages) {
      index += 1;
      // Tool plumbing is available in the session detail view; the merged timeline stays readable.
      if (message.kind === 'tool-call' || message.kind === 'tool-result') continue;
      if (message.role === 'system') continue;
      if (role !== 'all' && message.role !== role) continue;
      if (needle !== '' && !message.text.toLowerCase().includes(needle)) continue;
      const ts = message.ts || session.updatedAt;
      events.push({
        key: `${ts}:${session.id}:${index}`,
        ts,
        sessionId: session.id,
        agentId: session.agentId,
        sessionTitle: session.title,
        role: message.role,
        text: previewText(message.text, 280),
        length: message.text.length,
      });
    }
  }
  events.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
  if (order === 'desc') events.reverse();
  let start = 0;
  let cursorLost = false;
  if (options.cursor) {
    const found = events.findIndex((event) => event.key === options.cursor);
    // The stream changed under the cursor (rescan, filter change): never restart at page one,
    // which would append duplicates; report it so the client reloads from the top.
    if (found === -1) {
      cursorLost = true;
      start = events.length;
    } else {
      start = found + 1;
    }
  }
  const slice = events.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const nextCursor = start + limit < events.length && last ? last.key : null;
  return { events: slice, nextCursor, total: events.length, cursorLost };
}
