/**
 * Shared filesystem / parsing helpers for scan providers.
 *
 * Pure Node.js builtins only: this file is loaded by the DSH Host (Node 24) from a profile
 * bundle, so it must not import npm packages and must not keep module-level side effects.
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { join, resolve, sep, posix } from 'node:path';
import zlib from 'node:zlib';

/** True on Windows. */
export const IS_WINDOWS = osPlatform() === 'win32';

/**
 * The OS user's home directory.
 *
 * On Windows `USERPROFILE` is authoritative: shells such as Git Bash and some launchers also set
 * `HOME` (sometimes to a Cygwin-style path), so preferring HOME there would look in the wrong
 * place. On macOS/Linux `HOME` wins.
 * @returns {string}
 */
export function homeDir() {
  if (IS_WINDOWS) return process.env.USERPROFILE || process.env.HOME || homedir() || '';
  return process.env.HOME || process.env.USERPROFILE || homedir() || '';
}

/**
 * Expand `~`, `~/x`, and `${ENV}` / `%ENV%` segments in a configured path.
 * @param {string} input
 * @returns {string} absolute path (when the input is already absolute) or expanded relative path.
 */
export function expandPath(input) {
  if (typeof input !== 'string' || input.trim() === '') return '';
  let out = input.trim();
  // Windows users often paste a quoted path ("C:\Users\…") into a settings field.
  if (out.length >= 2 && ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'")))) {
    out = out.slice(1, -1).trim();
  }
  if (out === '~') out = homeDir();
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = join(homeDir(), out.slice(2));
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => process.env[name] ?? '');
  return out;
}

/**
 * Standard per-platform roots a provider usually needs.
 * @returns {{home: string, platform: NodeJS.Platform, appData: string, localAppData: string, xdgData: string}}
 */
export function platformRoots() {
  const home = homeDir();
  const appData = IS_WINDOWS
    ? process.env.APPDATA || join(home, 'AppData', 'Roaming')
    : osPlatform() === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : join(home, '.config');
  const localAppData = IS_WINDOWS ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local') : '';
  const xdgData = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  return { home, platform: osPlatform(), appData, localAppData, xdgData };
}

/** @returns {Promise<{size:number,mtimeMs:number,isFile:boolean,isDirectory:boolean}|null>} */
export async function statSafe(path) {
  if (typeof path !== 'string' || path === '') return null;
  try {
    const st = await fs.stat(path);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
    };
  } catch {
    return null;
  }
}

/** @returns {Promise<import('node:fs').Dirent[]>} */
export async function readdirSafe(path) {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** @returns {Promise<boolean>} */
export async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively list files under `root` (no symlink following), newest-first is NOT guaranteed.
 * @param {string} root
 * @param {{exts?: string[]|null, maxFiles?: number, maxDepth?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{path: string, size: number, mtimeMs: number}[]>}
 */
export async function listFilesRecursive(root, options = {}) {
  const { exts = null, maxFiles = 20000, maxDepth = 12, signal } = options;
  /** @type {{path:string,size:number,mtimeMs:number}[]} */
  const out = [];
  if (!root) return out;
  const extSet = exts ? new Set(exts.map((e) => e.toLowerCase())) : null;
  /** @type {{dir: string, depth: number}[]} */
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    if (signal?.aborted) return out;
    if (out.length >= maxFiles) break;
    const { dir, depth } = stack.pop();
    const entries = await readdirSafe(dir);
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (extSet && !extSet.has(extnameLower(entry.name))) continue;
      const st = await statSafe(full);
      if (st === null) continue;
      out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** @param {string} name */
function extnameLower(name) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

/** True for zstd-compressed JSONL (`*.jsonl.zst` / `*.zstd`), which `readJsonl` decompresses. @param {string} path */
export function isZstdPath(path) {
  return /\.(zst|zstd)$/i.test(path);
}

/**
 * Stream a JSONL file line by line. `.zst` / `.zstd` files are decompressed on the fly; they cannot
 * be resumed from an offset (`startOffset` must be 0) and `bytes` / `endOffset` count decompressed
 * text, so incremental callers must only pass plain files.
 *
 * An aborted `signal` rejects with an `AbortError`: a partial read must never look like a complete
 * file to a caller that caches what it parsed.
 * @param {string} path
 * @param {(line: string, index: number) => void} onLine
 * @param {{startOffset?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{lines: number, bytes: number, endOffset: number}>}
 */
export async function readJsonl(path, onLine, options = {}) {
  const { startOffset = 0, signal } = options;
  let lines = 0;
  let bytes = 0;
  let tail = '';
  let index = 0;
  let atStart = startOffset === 0;
  /** Strip a UTF-8 BOM (Windows editors write one) and a trailing CR (CRLF files). */
  const cleanLine = (line) => {
    let text = line;
    if (text.endsWith('\r')) text = text.slice(0, -1);
    return text;
  };
  const zstd = isZstdPath(path);
  if (zstd && startOffset !== 0) throw new Error(`cannot resume a compressed JSONL file from an offset: ${path}`);
  if (zstd && typeof zlib.createZstdDecompress !== 'function') {
    throw new Error(`zstd-compressed JSONL needs Node.js ≥ 22.15 (running ${process.version}): ${path}`);
  }
  const abortError = () => Object.assign(new Error(`read aborted: ${path}`), { name: 'AbortError' });
  if (signal?.aborted) throw abortError();
  await new Promise((resolvePromise, reject) => {
    const raw = createReadStream(path, zstd ? {} : { encoding: 'utf8', start: startOffset });
    /** @type {import('node:stream').Readable} */
    let stream = raw;
    if (zstd) {
      raw.on('error', (error) => reject(error));
      stream = raw.pipe(zlib.createZstdDecompress());
      stream.setEncoding('utf8');
    }
    const destroy = () => {
      stream.destroy();
      if (stream !== raw) raw.destroy();
    };
    const onAbort = () => {
      destroy();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const detach = () => signal?.removeEventListener('abort', onAbort);
    stream.on('close', detach);
    stream.on('data', (chunk) => {
      if (signal?.aborted) return;
      bytes += Buffer.byteLength(chunk);
      tail += chunk;
      if (atStart) {
        atStart = false;
        if (tail.charCodeAt(0) === 0xfeff) tail = tail.slice(1);
      }
      let newline = tail.indexOf('\n');
      while (newline >= 0) {
        const line = cleanLine(tail.slice(0, newline));
        tail = tail.slice(newline + 1);
        lines += 1;
        if (line.trim() !== '') {
          try {
            onLine(line, index);
          } catch {
            // A provider bug on one line must not abort a scan.
          }
          index += 1;
        }
        newline = tail.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (tail.trim() !== '') {
        lines += 1;
        const line = cleanLine(tail);
        try {
          onLine(line, index);
        } catch {
          // ignore
        }
      }
      resolvePromise(undefined);
    });
    stream.on('error', (error) => reject(error));
  });
  return { lines, bytes, endOffset: startOffset + bytes };
}

/** @param {string} path @returns {Promise<string|null>} */
export async function readText(path) {
  try {
    const text = await fs.readFile(path, 'utf8');
    // Strip a UTF-8 BOM (common on Windows); JSON.parse and helpers then see a clean document.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/** @param {string} path @returns {Promise<Buffer|null>} */
export async function readBuffer(path) {
  try {
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

/** @param {Buffer} buffer @returns {boolean} */
export function isZstd(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd;
}

/**
 * Length of one zstd frame starting at `offset`, derived from the frame header and block headers.
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {number} byte length, or -1 when the frame header cannot be understood.
 */
export function zstdFrameLength(buffer, offset) {
  if (offset + 5 > buffer.length) return -1;
  if (buffer.readUInt32LE(offset) !== 0xfd2fb528) return -1;
  let p = offset + 4;
  const descriptor = buffer[p++];
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;
  const dictFlag = descriptor & 3;
  if (!singleSegment) {
    if (p >= buffer.length) return -1;
    p += 1; // Window_Descriptor
  }
  p += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4;
  if (fcsFlag === 0) p += singleSegment ? 1 : 0;
  else if (fcsFlag === 1) p += 2;
  else if (fcsFlag === 2) p += 4;
  else p += 8;
  while (p + 3 <= buffer.length) {
    const header = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16);
    p += 3;
    const lastBlock = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >>> 3;
    if (blockType === 0 || blockType === 2) p += blockSize;
    else if (blockType === 1) p += 1;
    else return -1; // reserved block type
    if (lastBlock) {
      if (hasChecksum) p += 4;
      return p - offset;
    }
  }
  return -1;
}

/**
 * Decompress a concatenation of zstd frames (DSH session logs append one frame per record).
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function zstdDecompressAll(buffer) {
  /** @type {Buffer[]} */
  const parts = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) {
      // Skip stray bytes until the next frame magic rather than failing the whole file.
      const next = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    const length = zstdFrameLength(buffer, offset);
    if (length <= 0) break;
    const frame = buffer.subarray(offset, offset + length);
    try {
      parts.push(zlib.zstdDecompressSync(frame));
    } catch {
      // A corrupt frame must not discard previously decoded records.
    }
    offset += length;
  }
  if (parts.length === 0) throw new Error('no readable zstd frame');
  return Buffer.concat(parts);
}

/**
 * Local calendar day for an epoch-ms timestamp.
 * @param {number} tsMs
 * @returns {string} 'YYYY-MM-DD'
 */
export function localDay(tsMs) {
  const date = new Date(Number(tsMs));
  if (Number.isNaN(date.getTime())) return localDay(Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Open a SQLite database read-only through Node's builtin `node:sqlite`.
 *
 * Other applications keep these databases open (WAL writers on Windows take brief locks), so a
 * transient `SQLITE_BUSY`/`SQLITE_LOCKED` is retried a few times before the provider degrades to a
 * warning. The connection itself is always read-only.
 * @param {string} path
 * @param {{readOnly?: boolean}} [options]
 * @returns {Promise<import('node:sqlite').DatabaseSync>}
 */
export async function openSqliteDatabase(path, options = {}) {
  const sqlite = await import('node:sqlite');
  const readOnly = options.readOnly !== false;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return new sqlite.DatabaseSync(path, { readOnly });
    } catch (error) {
      lastError = error;
      const detail = `${error?.code ?? ''} ${error?.message ?? error}`;
      const transient = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|EBUSY|EPERM/i.test(detail);
      if (!transient || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Run a query and return plain row objects.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @param {unknown[]} [params]
 * @param {(error: unknown) => void} [onError] told about a failed query, which reads as no rows
 * @returns {Record<string, unknown>[]}
 */
export function querySqlite(db, sql, params = [], onError) {
  try {
    const statement = db.prepare(sql);
    return statement.all(...params);
  } catch (error) {
    onError?.(error);
    return [];
  }
}

/**
 * Parse one JSON line without throwing.
 * @param {string} line
 * @returns {any|null}
 */
export function safeJsonParse(line) {
  if (typeof line !== 'string' || line === '') return null;
  // A UTF-8 BOM (Windows editors / PowerShell) breaks JSON.parse; CRLF trailing CR is fine but is
  // stripped for callers that compare raw text.
  let text = line;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {string} path @returns {string} */
export function jsonlFingerprint(stat) {
  if (!stat) return '';
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

/** @param {string[]} parts @returns {string} */
export function joinPath(...parts) {
  return join(...parts);
}

/** @param {string} path @returns {string} */
export function basenameOf(path) {
  const normalized = path.endsWith(sep) ? path.slice(0, -1) : path;
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** @param {string} path @returns {string} */
export function dirnameOf(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index <= 0 ? path : path.slice(0, index);
}

/** @param {string[]} candidates @returns {Promise<string[]>} */
export async function filterExisting(candidates) {
  const out = [];
  for (const candidate of candidates) {
    if (candidate && (await exists(candidate))) out.push(candidate);
  }
  return out;
}

/**
 * Local path of a `file://` URI as an agent recorded it, or '' when it is not one:
 * - `file:///Users/me/p`         -> `/Users/me/p`
 * - `file:///c%3A/Users/me/p`    -> `c:/Users/me/p`  (VS Code encodes the drive colon)
 * - `file://nas/team/p`          -> `\\nas\team\p`   (UNC share: the host is the server)
 * - `file:////nas/team/p`        -> `\\nas\team\p`   (the four-slash UNC spelling)
 * `localhost` is the local machine. A trailing separator is dropped unless it is the root.
 * @param {unknown} uri
 * @returns {string}
 */
export function fileUriToPath(uri) {
  if (typeof uri !== 'string') return '';
  const text = uri.trim();
  if (!/^file:\/\//i.test(text)) return '';
  let parsed;
  let path;
  try {
    parsed = new URL(text);
    path = decodeURIComponent(parsed.pathname || '');
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase() === 'localhost' ? '' : parsed.hostname;
  let unc = '';
  if (host !== '') unc = `${host}${path}`;
  else if (/^\/\/[^/]/.test(path)) unc = path.slice(2);
  if (unc !== '') {
    const out = `\\\\${unc.replace(/\//g, '\\')}`;
    return out.endsWith('\\') ? out.slice(0, -1) : out;
  }
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) path = path.slice(1);
  if (path.length > 1 && path.endsWith('/') && !/^[A-Za-z]:\/$/.test(path)) path = path.slice(0, -1);
  return path;
}

/** @param {string} path @returns {string} */
export function normalizeSlashes(path) {
  return String(path).replace(/\\/g, posix.sep);
}

// Path helpers under the names providers and CONTRACT.md expect (plus the historic aliases).
export { join, resolve, join as joinPathNode, resolve as resolvePath };
