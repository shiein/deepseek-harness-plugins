/**
 * JSDoc-only type definitions shared by providers and the scanner.
 * This module has no runtime behavior; it exists so editors and `// @ts-check` see the contract.
 */

/**
 * @typedef {Object} Cell
 * @property {string} model          Raw model id; 'unknown' when unavailable.
 * @property {string} day            Local calendar day, 'YYYY-MM-DD'.
 * @property {number} input          Uncached input tokens.
 * @property {number} output         Output tokens (reasoning included when the source folds it in).
 * @property {number} cacheRead      Cache-read tokens (0 when not reported).
 * @property {number} cacheWrite     Cache-write tokens (0 when not reported).
 * @property {number} [reasoning]    Reasoning tokens reported separately by the source.
 * @property {number} [costUsd]      Cost reported by the source itself, in USD.
 * @property {number} messages       Number of model responses contributing to the cell.
 * @property {number} [firstTs]      Epoch ms of the earliest contribution.
 * @property {number} [lastTs]       Epoch ms of the latest contribution.
 * @property {string} [tier]         Speed/tier reported by the source ('fast', 'standard', ...).
 */

/**
 * @typedef {Object} Source
 * @property {string} label          Short human label, e.g. 'Claude Code transcripts'.
 * @property {string} path           Exact path or descriptive location.
 * @property {boolean} exists        Whether the data was found on this machine.
 * @property {number} files          Files parsed (0 when absent).
 * @property {number} [bytes]        Bytes read (approximate is fine).
 * @property {string} [note]         Extra note shown in the UI source list.
 */

/**
 * @typedef {Object} ProviderMeta
 * @property {string} id             Stable kebab-case id (also the UI agent id).
 * @property {string} name           Human-readable name.
 * @property {string} color          Hex color used by the UI.
 * @property {string} [homepage]     Product URL.
 * @property {number} [cacheVersion] Bump when parsing or cell semantics change.
 * @property {boolean} [beta]        Mark as experimental in the UI.
 */

/**
 * @typedef {Object} CacheFace
 * @property {(filePath: string, fingerprint: string) => Cell[]|undefined} get
 * @property {(filePath: string, fingerprint: string, cells: Cell[], state?: unknown) => void} set
 * @property {(filePath: string) => ({fp: string, cells: Cell[], state?: unknown}|undefined)} [peek]
 *   previous entry regardless of fingerprint (incremental providers); optional in test harnesses
 */

/**
 * @typedef {Object} EnvFace
 * @property {string} home
 * @property {string} platform
 * @property {string} appData
 * @property {string} localAppData
 * @property {string} xdgData
 * @property {Record<string, unknown>} config
 */

/**
 * @typedef {Object} ScanContext
 * @property {string} providerId
 * @property {AbortSignal} signal
 * @property {EnvFace} env
 * @property {typeof import('./scan-utils.js')} utils
 * @property {CacheFace} cache
 * @property {(message: string) => void} warn
 */

export {};
