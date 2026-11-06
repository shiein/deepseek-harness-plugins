/**
 * Small filesystem helpers shared by the scanner and cache (no npm dependencies).
 */

import fs from 'node:fs/promises';
import { dirname } from 'node:path';

/** @param {string} path @returns {Promise<void>} */
export async function mkdirSafe(path) {
  try {
    await fs.mkdir(path, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Write text atomically (temp file + rename), best effort.
 * @param {string} path
 * @param {string} content
 * @returns {Promise<boolean>}
 */
export async function writeTextAtomic(path, content) {
  try {
    await mkdirSafe(dirname(path));
    const temporary = `${path}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} path @returns {Promise<string|null>} */
export async function readTextSafe(path) {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** @param {string} path @param {string} content @returns {Promise<boolean>} */
export async function appendTextSafe(path, content) {
  try {
    await fs.appendFile(path, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}
