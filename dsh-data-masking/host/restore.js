/**
 * Streaming restore: swaps placeholders in the provider's chunk stream back to the original values
 * before the agent loop sees (and logs, executes, renders) them.
 *
 * A placeholder can be split across deltas, so each block keeps a small hold-back buffer: text that
 * could still grow into a placeholder is withheld until the next delta or the block end. Tool-call
 * arguments are raw JSON strings, so their restored values are JSON-escaped.
 *
 * `finish.replayState` is provider-opaque and is passed through untouched: it goes back to the same
 * provider, which must keep seeing placeholders.
 */

import { TOKEN_RE } from './engine.js';

const MAX_TOKEN_LENGTH = '{{'.length + 16 + 1 + 16 + '}}'.length;
// Every proper prefix of a well-formed placeholder.
const TOKEN_PREFIX_RE = /^\{(?:\{(?:[A-Z][A-Z0-9]{0,15}(?:_[0-9a-f]{0,16}(?:\})?)?)?)?$/;

/** Index from which `text` must be held back because it may be the start of a placeholder. */
export function holdBackIndex(text) {
  const from = Math.max(0, text.length - MAX_TOKEN_LENGTH);
  for (let i = text.indexOf('{', from); i !== -1; i = text.indexOf('{', i + 1)) {
    if (TOKEN_PREFIX_RE.test(text.slice(i))) return i;
  }
  return text.length;
}

/**
 * @param {string} text
 * @param {import('./engine.js').Vault} vault
 * @param {boolean} json escape restored values for a JSON string context
 */
export function restoreText(text, vault, json = false) {
  if (!text.includes('{{')) return text;
  return text.replace(TOKEN_RE, (token) => {
    const value = vault.valueOf(token);
    if (value === undefined) return token;
    return json ? JSON.stringify(value).slice(1, -1) : value;
  });
}

/**
 * Wrap a provider chunk stream.
 * @param {AsyncIterable<any>} stream
 * @param {import('./engine.js').Vault} vault
 * @param {{ onRestored?: (count: number) => void }} [hooks]
 */
export async function* restoreStream(stream, vault, hooks = {}) {
  /** @type {Map<number, string>} */
  const pending = new Map();
  /** @type {Map<number, {type: string, id?: unknown}>} */
  const kinds = new Map();
  let restored = 0;

  const take = (index, json, all) => {
    const text = pending.get(index) ?? '';
    const cut = all ? text.length : holdBackIndex(text);
    pending.set(index, text.slice(cut));
    const head = text.slice(0, cut);
    const out = restoreText(head, vault, json);
    if (out !== head) restored += 1;
    return out;
  };

  for await (const chunk of stream) {
    switch (chunk?.type) {
      case 'text-delta':
      case 'reasoning-delta': {
        pending.set(chunk.index, (pending.get(chunk.index) ?? '') + chunk.text);
        kinds.set(chunk.index, { type: chunk.type });
        const text = take(chunk.index, false, false);
        if (text !== '') yield { ...chunk, text };
        break;
      }
      case 'tool-call-delta': {
        pending.set(chunk.index, (pending.get(chunk.index) ?? '') + chunk.argumentsDelta);
        kinds.set(chunk.index, { type: chunk.type, id: chunk.id });
        // Always forward the delta (it may carry the call's name/id), even if its text is withheld.
        yield { ...chunk, argumentsDelta: take(chunk.index, true, false) };
        break;
      }
      case 'block-end': {
        const block = chunk.block;
        const rest = pending.has(chunk.index) ? take(chunk.index, block?.type === 'tool-call', true) : '';
        pending.delete(chunk.index);
        kinds.delete(chunk.index);
        if (rest !== '') {
          if (block?.type === 'tool-call') yield { type: 'tool-call-delta', index: chunk.index, id: block.id, argumentsDelta: rest };
          else yield { type: block?.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: chunk.index, text: rest };
        }
        yield { ...chunk, block: restoreBlock(block, vault) };
        break;
      }
      case 'finish': {
        // A stream that ends without block-end (error/abort) still must not drop held text.
        for (const index of [...pending.keys()]) {
          const kind = kinds.get(index) ?? { type: 'text-delta' };
          const rest = take(index, kind.type === 'tool-call-delta', true);
          pending.delete(index);
          if (rest === '') continue;
          if (kind.type === 'tool-call-delta') yield { type: 'tool-call-delta', index, id: kind.id, argumentsDelta: rest };
          else yield { type: kind.type, index, text: rest };
        }
        hooks.onRestored?.(restored);
        yield chunk;
        break;
      }
      default:
        yield chunk;
    }
  }
}

function restoreBlock(block, vault) {
  if (!block || typeof block !== 'object') return block;
  if (block.type === 'tool-call' && typeof block.arguments === 'string') return { ...block, arguments: restoreText(block.arguments, vault, true) };
  if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') return { ...block, text: restoreText(block.text, vault, false) };
  return block;
}
