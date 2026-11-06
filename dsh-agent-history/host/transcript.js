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

export class TranscriptReader {
  /**
   * @param {{read: (session: import('./types.js').SessionSummary, signal: AbortSignal) =>
   *            Promise<{supported: boolean, messages: Array<import('./types.js').TranscriptMessage>}>}} options
   */
  constructor(options) {
    this.read = options.read;
    /** @type {Map<string, {key: string, supported: boolean, messages: Array<import('./types.js').TranscriptMessage>}>} */
    this.cache = new Map();
    /** Timeline reads keep only the readable slice of each session. @type {Map<string, {key: string, messages: any[]}>} */
    this.timelineCache = new Map();
  }

  /** @param {import('./types.js').SessionSummary} session @param {AbortSignal} signal */
  async get(session, signal) {
    const key = `${session.updatedAt}`;
    const cached = this.cache.get(session.id);
    if (cached && cached.key === key) {
      // Refresh recency without re-reading the transcript.
      this.cache.delete(session.id);
      this.cache.set(session.id, cached);
      return cached;
    }
    let result;
    try {
      result = await this.read(session, signal);
    } catch {
      result = { supported: true, messages: [] };
    }
    const entry = {
      key,
      supported: Boolean(result?.supported),
      messages: limitTranscriptChars(finalizeMessages(result?.messages || [])),
    };
    this.cache.set(session.id, entry);
    while (this.cache.size > MAX_CACHED_TRANSCRIPTS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return entry;
  }

  /**
   * Read the slice of a transcript that the merged project timeline needs: most messages of most
   * sessions, but a bounded tail for very long ones. Cached separately from the full transcript so
   * one session can serve both views without reading twice per scan generation.
   * @param {import('./types.js').SessionSummary} session
   * @param {AbortSignal} signal
   * @param {number} [maxMessages]
   * @returns {Promise<{messages: Array<import('./types.js').TranscriptMessage>, truncated: boolean}>}
   */
  async getForTimeline(session, signal, maxMessages = 300) {
    const key = `${session.updatedAt}:${maxMessages}`;
    const cached = this.timelineCache.get(session.id);
    if (cached && cached.key === key) {
      this.timelineCache.delete(session.id);
      this.timelineCache.set(session.id, cached);
      return { messages: cached.messages, truncated: cached.truncated };
    }
    const entry = await this.get(session, signal);
    const readable = entry.messages.filter((message) => message.role !== 'system');
    const truncated = readable.length > maxMessages;
    // Keep the tail: the latest work of a very long session is what the merged view reads.
    const sliced = truncated ? readable.slice(readable.length - maxMessages) : readable;
    this.timelineCache.set(session.id, { key, messages: sliced, truncated });
    while (this.timelineCache.size > MAX_CACHED_TIMELINES) {
      const oldest = this.timelineCache.keys().next();
      if (oldest.done) break;
      this.timelineCache.delete(oldest.value);
    }
    return { messages: sliced, truncated };
  }

  /** @param {string} sessionId */
  forget(sessionId) {
    this.cache.delete(sessionId);
    this.timelineCache.delete(sessionId);
  }

  clear() {
    this.cache.clear();
    this.timelineCache.clear();
  }
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
