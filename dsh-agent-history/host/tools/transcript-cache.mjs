/**
 * Transcript cache checks.
 *
 * Read failures must surface and must not be cached as an empty "supported" transcript:
 * the session view gets the original error and a re-open retries; the merged timeline skips the
 * unreadable session with its error instead of failing the whole page.
 *
 * The cache also holds a total text budget: a few huge sessions evict older ones.
 *
 *   node host/tools/transcript-cache.mjs
 */

import { TranscriptReader } from '../transcript.js';

let failures = 0;
let checks = 0;
function check(label, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
}

let reads = 0;
let broken = true;
const reader = new TranscriptReader({
  read: async () => {
    reads += 1;
    if (broken) throw new Error('EACCES: permission denied');
    return { supported: true, messages: [{ role: 'user', ts: 1, text: 'hello' }] };
  },
});
const session = { id: 'session-1', updatedAt: 10 };
const signal = new AbortController().signal;

let error = '';
try {
  await reader.get(session, signal);
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
}
check('get() rethrows the original read error', error === 'EACCES: permission denied', error);
check('a failed read is not cached', !reader.cache.has(session.id));

const timeline = await reader.getForTimeline(session, signal);
check('timeline slice reports the error with no messages', timeline.error === 'EACCES: permission denied' && timeline.messages.length === 0, JSON.stringify(timeline));
check('a failed timeline read is not cached', !reader.timelineCache.has(session.id));

broken = false;
const recovered = await reader.get(session, signal);
check('the next open retries and succeeds', recovered.supported === true && recovered.messages.length === 1 && reads === 3, `reads=${reads}`);

// Text budget: messages are clipped to ~20k chars each, so 80 of them make a ~1.6M-char session;
// 20 such sessions exceed the 24M budget and must evict the oldest.
const longMessages = Array.from({ length: 80 }, (_, index) => ({ role: 'assistant', ts: index + 1, text: 'x'.repeat(20_000) }));
const budgetReader = new TranscriptReader({
  read: async () => ({ supported: true, messages: longMessages }),
});
for (let index = 0; index < 20; index += 1) {
  await budgetReader.get({ id: `big-${index}`, updatedAt: 1 }, signal);
}
check('cache stays within the total char budget', budgetReader.cacheChars <= 24_000_000, `chars=${budgetReader.cacheChars}`);
check('oldest sessions are evicted first', !budgetReader.cache.has('big-0') && budgetReader.cache.has('big-19'));
check('char total matches the cached entries',
  budgetReader.cacheChars === [...budgetReader.cache.values()].reduce((sum, entry) => sum + entry.chars, 0));
budgetReader.forget('big-19');
check('forget() releases its chars',
  budgetReader.cacheChars === [...budgetReader.cache.values()].reduce((sum, entry) => sum + entry.chars, 0));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
