/**
 * The project folders the user explicitly opened in the panel (most recent first).
 *
 * Kept in `<dataDir>/opened-projects.json` so the list survives restarts and a new GUI port.
 * Only folders the user opened are listed — the scanned index of every project is never shown as
 * "opened". Writes are atomic; an unreadable file is never overwritten (that would silently drop
 * the whole list), the request fails instead.
 */

import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { comparablePath, normalizeProjectPath } from './model.js';
import { mkdirSafe } from './fs-extra.js';

const FILE = 'opened-projects.json';
const FORMAT = 1;

/** @param {string} message @param {number} status */
function storeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Absolute local folder path (POSIX or Windows drive / UNC), normalized. @param {unknown} value */
export function validProjectPath(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (raw === '' || raw.length > 4096 || raw.includes('\u0000')) return '';
  if (!isAbsolute(raw) && !/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith('\\\\')) return '';
  return normalizeProjectPath(raw);
}

export class OpenedProjects {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = join(dataDir, FILE);
  }

  /** @returns {Promise<Array<{path: string, name: string, openedAt: number, count: number}>>} */
  async read() {
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw storeError(`cannot read ${this.file}: ${error?.message || error}`, 500);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw storeError(`${this.file} is not valid JSON; fix or move it first`, 500);
    }
    const list = Array.isArray(parsed?.projects) ? parsed.projects : Array.isArray(parsed) ? parsed : null;
    if (list === null) throw storeError(`${this.file} has an unexpected shape`, 500);
    return list
      .filter((item) => item && typeof item.path === 'string' && item.path !== '')
      .map((item) => ({
        path: item.path,
        name: typeof item.name === 'string' && item.name !== '' ? item.name : basename(item.path) || item.path,
        openedAt: Number(item.openedAt) || 0,
        count: Math.max(1, Math.round(Number(item.count) || 1)),
      }));
  }

  /** @param {Array<object>} list */
  async write(list) {
    await mkdirSafe(this.dataDir);
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ format: FORMAT, projects: list }, null, 2), 'utf8');
    await fs.rename(temporary, this.file);
  }

  /** Listing for the UI, newest first, with a live `exists` flag. */
  async list() {
    const list = await this.read();
    return list
      .sort((a, b) => b.openedAt - a.openedAt)
      .map((item) => ({ ...item, exists: folderExists(item.path) }));
  }

  /** Record (or move to the top) one opened folder. @param {string} path */
  async open(path) {
    const normalized = validProjectPath(path);
    if (normalized === '') throw storeError('an absolute folder path is required', 400);
    const key = comparablePath(normalized);
    const list = await this.read();
    const existing = list.find((item) => comparablePath(item.path) === key);
    const rest = list.filter((item) => comparablePath(item.path) !== key);
    const entry = {
      path: existing?.path || normalized,
      name: basename(normalized) || normalized,
      openedAt: Date.now(),
      count: (existing?.count || 0) + 1,
    };
    await this.write([entry, ...rest]);
    return this.list();
  }

  /** Remove one folder, or every folder with `all`. @param {{path?: string, all?: boolean}} input */
  async remove(input) {
    if (input?.all === true) {
      await this.write([]);
      return [];
    }
    const normalized = validProjectPath(input?.path);
    if (normalized === '') throw storeError('path (or all: true) is required', 400);
    const key = comparablePath(normalized);
    const list = await this.read();
    await this.write(list.filter((item) => comparablePath(item.path) !== key));
    return this.list();
  }
}

/** @param {string} path */
function folderExists(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
