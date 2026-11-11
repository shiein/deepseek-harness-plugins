/**
 * Request walker: produces the masked copy of one `GenerateOptions` envelope.
 *
 * Fail-safe by construction: every string leaf of `system`, `messages` and tool descriptions is
 * masked, including block types this plugin has never heard of. Only structural keys that the
 * provider needs verbatim (ids, roles, block types, tool names, the provider-owned `source`
 * metadata) are skipped. File blocks are projected to the exact handle text the adapter would
 * produce, so the file name/path text is masked too instead of being projected after this hook.
 */

/** Keys whose string values are structure, not content. */
const STRUCTURAL_KEYS = new Set(['type', 'role', 'id', 'toolCallId', 'isError', 'source', 'attachment', 'mimeType', 'mediaType']);

/**
 * @param {object} options frozen GenerateOptions
 * @param {import('./engine.js').Masker} masker
 * @param {import('./engine.js').Vault} vault
 * @param {Array} hits
 * @param {(ref: unknown) => string} fileText resolves a FileBlock attachment to its handle text
 */
export function maskRequest(options, masker, vault, hits, fileText) {
  const maskValue = (value, key) => {
    if (typeof value === 'string') return STRUCTURAL_KEYS.has(key) ? value : masker.maskText(value, vault, hits);
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const masked = maskValue(item, undefined);
        if (masked !== item) changed = true;
        return masked;
      });
      return changed ? next : value;
    }
    if (value && typeof value === 'object') return maskObject(value);
    return value;
  };

  const maskObject = (object) => {
    if (object.type === 'file' && object.attachment !== undefined) {
      return { type: 'text', text: masker.maskText(fileText(object.attachment), vault, hits) };
    }
    let next = null;
    for (const [key, value] of Object.entries(object)) {
      let masked;
      if (STRUCTURAL_KEYS.has(key)) masked = value;
      else if (object.type === 'tool-call' && key === 'name') masked = value;
      else if (object.type === 'tool-call' && key === 'arguments' && typeof value === 'string') masked = masker.maskJson(value, vault, hits);
      else masked = maskValue(value, key);
      if (masked !== value) {
        next ??= { ...object };
        next[key] = masked;
      }
    }
    return next ?? object;
  };

  const messages = maskValue(options.messages, 'messages');
  const system = typeof options.system === 'string' ? masker.maskText(options.system, vault, hits) : options.system;
  const tools = Array.isArray(options.tools) ? maskToolSchemas(options.tools, masker, vault, hits) : options.tools;
  if (messages === options.messages && system === options.system && tools === options.tools) return options;
  return { ...options, messages, ...(system === undefined ? {} : { system }), ...(tools === undefined ? {} : { tools }) };
}

/** Mask `description` strings anywhere in tool schemas; names and schema keywords stay verbatim. */
function maskToolSchemas(tools, masker, vault, hits) {
  const walk = (value) => {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const masked = walk(item);
        if (masked !== item) changed = true;
        return masked;
      });
      return changed ? next : value;
    }
    if (!value || typeof value !== 'object') return value;
    let next = null;
    for (const [key, item] of Object.entries(value)) {
      const masked = key === 'description' && typeof item === 'string' ? masker.maskText(item, vault, hits) : walk(item);
      if (masked !== item) {
        next ??= { ...value };
        next[key] = masked;
      }
    }
    return next ?? value;
  };
  return walk(tools);
}
