/**
 * Resume launcher: turn one historical session into a command that continues it, and start that
 * command in the user's own terminal window.
 *
 * Two modes:
 * - `dsh`  — a DeepSeek Harness session is resumed inside the running Web GUI by the Client half
 *            (`ctx.uiWorkspace.openSession`), so the Host only answers what to open.
 * - `cli`  — an external agent CLI is resumed in a new native terminal window, in the session's
 *            own project folder, so the agent sees exactly the folder it originally worked in.
 *
 * The command templates come from the providers' `meta.resume` (trusted, code-owned constants) and
 * are shell-quoted here; the session id itself always comes from a transcript file.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSafe } from './fs-extra.js';

/**
 * @typedef {Object} LaunchPlan
 * @property {'dsh'|'cli'|'unsupported'} kind
 * @property {string} [sessionId]
 * @property {string} [command]      Bare command name or absolute path.
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {string} [display]      Human-readable command line.
 * @property {string} [reason]       Why the agent cannot resume.
 */

/**
 * @param {import('./types.js').AgentSnapshot} agent
 * @param {import('./types.js').SessionSummary} session
 * @param {Record<string, unknown>} [config]
 * @returns {LaunchPlan}
 */
export function buildLaunchPlan(agent, session, config = {}) {
  const overrides = config?.commands && typeof config.commands === 'object' ? config.commands : {};
  const override = overrides[session.agentId];
  let command = agent?.resume?.command;
  let args = agent?.resume?.args ? [...agent.resume.args] : null;
  if (Array.isArray(override) && override.length > 0) {
    command = String(override[0]);
    args = override.slice(1).map((value) => String(value));
  }
  const kind = override ? 'cli' : agent?.resume?.kind || 'none';
  if (kind === 'dsh') {
    return { kind: 'dsh', sessionId: session.nativeId, display: `open DSH session ${session.nativeId}` };
  }
  if (kind !== 'cli' || !command || !args) {
    return {
      kind: 'unsupported',
      reason: `${agent?.name || session.agentId} does not expose a local resume command in this plugin`,
    };
  }
  const cwd = session.projectPath || '';
  const substituted = args.map((arg) => arg.replaceAll('{id}', session.nativeId).replaceAll('{cwd}', cwd));
  const display = [command, ...substituted].join(' ');
  return { kind: 'cli', command, args: substituted, cwd, display };
}

/**
 * Find an executable the way a terminal would, but predictable enough to launch from the Host:
 * absolute paths are verified, bare names are searched in PATH plus the usual agent install dirs.
 * @param {string} command
 * @param {Record<string, string>} [env]
 * @returns {string|null} absolute path or null
 */
export function resolveExecutable(command, env = {}) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  if (command.includes('/') || command.includes('\\')) return command;
  const home = process.env.HOME || homedir();
  const pathEntries = `${env.PATH || ''}:${process.env.PATH || ''}`
    .split(platform() === 'win32' ? ';' : ':')
    .filter((entry) => entry && entry.trim() !== '');
  const extra = [
    join(home, '.local', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.codex', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(home, '.local', 'share', 'mise', 'shims'),
  ];
  const seen = new Set();
  for (const dir of [...extra, ...pathEntries]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, command);
    try {
      // Synchronous probe keeps the launch route simple; the list is short.
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

/** POSIX single-quote; safe for paths and ids with spaces or quotes. @param {string} value */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** {@link shellQuote} only when needed, so a copied command stays readable. @param {string} value */
function shellWord(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : shellQuote(text);
}

/** A script line that prints `text` literally: no expansion, unlike `echo "…"`. @param {string} text */
function printLine(text) {
  return `printf '%s\\n' ${shellQuote(text)}`;
}

/** Windows cmd quoting for one argument (spaces and cmd metacharacters). @param {string} value */
export function cmdQuote(value) {
  const text = String(value);
  return /[\s"&|<>^()%!,;=]/.test(text) || text === '' ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Full `cmd.exe` command line that opens a new console in `cwd` and runs the resume command.
 * Built verbatim (no Node re-quoting): `/s /c "<start …>"` strips exactly the outer quotes, `start ""`
 * gives the window an empty title, `/D` sets the folder (no `cd` parsing), and `/k "<cmd>"` keeps
 * the inner quoting of paths with spaces intact.
 * @param {string} cwd @param {string} command @param {string[]} args
 */
export function windowsLaunchLine(cwd, command, args) {
  const inner = [command, ...args].map(cmdQuote).join(' ');
  return `/d /s /c "start "" /D ${cmdQuote(cwd)} cmd.exe /k "${inner}""`;
}

/** Drop generated resume scripts older than a day so the launch folder does not grow forever. @param {string} dir */
async function pruneOldScripts(dir) {
  try {
    const cutoff = Date.now() - 86_400_000;
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith('resume-') || !name.endsWith('.command')) continue;
      const file = join(dir, name);
      const info = await fs.stat(file).catch(() => null);
      if (info && info.mtimeMs < cutoff) await fs.unlink(file).catch(() => {});
    }
  } catch {
    // best effort
  }
}

/**
 * Start one launch plan in a native terminal window.
 * @param {LaunchPlan} plan
 * @param {{dataDir: string, config?: Record<string, unknown>}} options
 * @returns {Promise<{ok: boolean, display: string, terminal?: string, error?: string}>}
 */
export async function launchInTerminal(plan, options) {
  if (plan.kind !== 'cli' || !plan.command) {
    return { ok: false, display: plan.display || '', error: plan.reason || 'nothing to launch' };
  }
  const config = options.config || {};
  const dataDir = options.dataDir;
  const launchDir = join(dataDir, 'launch');
  await mkdirSafe(launchDir);
  const display = plan.display || [plan.command, ...(plan.args || [])].join(' ');

  const resolved = resolveExecutable(plan.command, config);
  const commandLine = [resolved ? shellQuote(resolved) : shellQuote(plan.command), ...(plan.args || []).map(shellQuote)].join(' ');

  try {
    if (platform() === 'win32') {
      const cwd = plan.cwd && existsSync(plan.cwd) ? plan.cwd : homedir();
      const child = spawn(process.env.ComSpec || 'cmd.exe', [windowsLaunchLine(cwd, plan.command, plan.args || [])], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
        cwd,
      });
      child.unref();
      return { ok: true, display, terminal: 'cmd.exe' };
    }

    await pruneOldScripts(launchDir);
    const scriptPath = join(launchDir, `resume-${sanitize(plan.command)}-${Date.now()}.command`);
    const lines = [
      '#!/bin/zsh -l',
      '# Generated by dsh-agent-history: resume one historical agent conversation.',
      // The folder and session id come from transcript files: print them, never let the shell expand them.
      `cd ${shellQuote(plan.cwd || homedir())} || { ${printLine(`目录不存在: ${plan.cwd || ''}`)}; exit 1; }`,
      printLine(`▸ ${display}`),
      'echo',
      commandLine,
      'echo',
      'echo "[agent-history] 会话结束，可以关闭此窗口。"',
    ];
    await fs.writeFile(scriptPath, `${lines.join('\n')}\n`, 'utf8');
    await fs.chmod(scriptPath, 0o755);

    const terminalApp = typeof config.terminalApp === 'string' && config.terminalApp.trim() !== '' ? config.terminalApp.trim() : '';
    const args = terminalApp !== '' && terminalApp !== 'auto'
      ? ['-a', terminalApp, scriptPath]
      : [scriptPath];
    const child = spawn('open', args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, display, terminal: terminalApp || 'Terminal' };
  } catch (error) {
    return { ok: false, display, error: error instanceof Error ? error.message : String(error) };
  }
}

/** @param {string} value */
function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'agent';
}

/**
 * A shell command the user can copy when they would rather resume manually.
 * @param {LaunchPlan} plan
 * @returns {string}
 */
export function copyableCommand(plan) {
  if (plan.kind === 'dsh') return '';
  if (!plan.display) return '';
  if (platform() === 'win32') {
    const line = [plan.command, ...(plan.args || [])].map(cmdQuote).join(' ');
    return plan.cwd ? `cd /d ${cmdQuote(plan.cwd)} && ${line}` : line;
  }
  const dir = plan.cwd ? `cd ${shellQuote(plan.cwd)} && ` : '';
  return `${dir}${[plan.command, ...(plan.args || [])].map(shellWord).join(' ')}`;
}
