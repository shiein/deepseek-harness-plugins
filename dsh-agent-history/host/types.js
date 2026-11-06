/**
 * Shared type descriptors for the Agent History bundle.
 *
 * The module is documentation only: every object crosses the Host -> Client JSON boundary, so the
 * shapes below stay plain JSON and stay stable enough for the Client to render defensively.
 */

/**
 * @typedef {Object} SourceInfo
 * @property {string} label       Short human label for a data directory.
 * @property {string} path        Exact path (or a description such as 'macOS Keychain').
 * @property {boolean} exists     Whether the directory/file is present on this machine.
 * @property {number} files       Session files/SQLite rows considered readable.
 * @property {number} bytes       Bytes read (0 when unknown).
 * @property {string} [note]      Optional explanation shown in the Sources view.
 */

/**
 * One stored conversation. `ref` is provider-private and only the owning provider reads it.
 *
 * @typedef {Object} SessionSummary
 * @property {string} id            Globally unique: `${agentId}:${nativeId}`.
 * @property {string} agentId
 * @property {string} nativeId      Agent-native session id used by the resume command.
 * @property {string} title         Human title (native title or first prompt).
 * @property {string} projectPath   Absolute project/cwd folder, '' when unknown.
 * @property {number} startedAt     Epoch ms of the first message.
 * @property {number} updatedAt     Epoch ms of the last activity.
 * @property {number} messages      Assistant + user text messages.
 * @property {number} userMessages  User prompts.
 * @property {number} sizeBytes     Approximate transcript size.
 * @property {string} preview       First prompt preview.
 * @property {string} lastPreview   Last message preview.
 * @property {string} sourcePath    File or database path (display only).
 * @property {string} [extra]       Short free-form note (model, branch, ...).
 * @property {Object} ref           Provider-private locator, JSON.
 */

/**
 * @typedef {Object} AgentSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} [homepage]
 * @property {'ok'|'empty'|'not-installed'|'error'|'broken'} status
 * @property {number} sessions
 * @property {number} messages
 * @property {number} durationMs
 * @property {SourceInfo[]} sources
 * @property {string[]} warnings
 * @property {string} [error]
 * @property {{kind: 'cli'|'dsh'|'none', command?: string, args?: string[], target?: string}} resume
 * @property {'messages'|'none'} detail  Whether readMessages can render this agent's transcript.
 */

/**
 * @typedef {Object} EnvFace
 * @property {string} home
 * @property {NodeJS.Platform} platform
 * @property {string} appData
 * @property {string} localAppData
 * @property {string} xdgData
 * @property {Record<string, unknown>} config
 */

/**
 * @typedef {Object} CacheFace
 * @property {(filePath: string, fingerprint: string) => SessionSummary[]|undefined} get
 * @property {(filePath: string, fingerprint: string, sessions: SessionSummary[], state?: unknown) => void} set
 * @property {(filePath: string) => ({fp: string, sessions: SessionSummary[], state?: unknown}|undefined)} [peek]
 *   previous entry regardless of fingerprint (incremental providers); optional in test harnesses
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

/**
 * @typedef {Object} TranscriptMessage
 * @property {'user'|'assistant'|'tool'|'system'} role
 * @property {number} ts
 * @property {string} text
 * @property {string} [kind]   'tool-call' | 'tool-result' | '' for plain text.
 * @property {string} [name]   Tool name / model name.
 */

export {};
