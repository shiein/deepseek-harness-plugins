/**
 * WorkBuddy (Tencent) history provider — detection only.
 *
 * WorkBuddy is a desktop agent built on the CodeBuddy harness. It keeps CodeBuddy-format JSONL
 * transcripts under its own home:
 *   $WORKBUDDY_CONFIG_DIR/projects
 *   ~/.workbuddy/projects        (workbuddy.cn)
 *   ~/.workbuddy-ai/projects     (WorkBuddy AI)
 * A completed trace summary may also exist under <home>/traces/<id>/trace_*.json.
 *
 * Detection only: the transcript directory is located and reported, but the JSONL conversations
 * are not converted into history entries by this bundle (the task split assigns WorkBuddy to
 * detection only), so no sessions are reported and no resume command is invented.
 */

import { join } from 'node:path';

export const meta = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  color: '#14b8a6',
  homepage: 'https://www.codebuddy.cn',
  cacheVersion: 1,
  resume: { kind: 'none' },
};

/**
 * @param {import('../types.js').EnvFace} env
 * @returns {string[]}
 */
function homeCandidates(env) {
  const configured = (process.env.WORKBUDDY_CONFIG_DIR || '').trim();
  if (configured !== '') return [configured.replace(/^~(?=$|[\\/])/, env.home)];
  return [join(env.home, '.workbuddy'), join(env.home, '.workbuddy-ai')];
}

/**
 * @param {import('../types.js').ScanContext} ctx
 */
export async function scan(ctx) {
  const { utils, env } = ctx;
  /** @type {import('../types.js').SourceInfo[]} */
  const sources = [];
  const homes = homeCandidates(env);
  let found = false;

  for (const home of homes) {
    const homeStat = await utils.statSafe(home);
    if (homeStat === null || !homeStat.isDirectory) continue;
    found = true;
    const projectsDir = join(home, 'projects');
    const projectsStat = await utils.statSafe(projectsDir);
    if (projectsStat && projectsStat.isDirectory) {
      const files = await utils.listFilesRecursive(projectsDir, {
        exts: ['.jsonl'],
        maxDepth: 6,
        maxFiles: 5000,
        signal: ctx.signal,
      });
      let bytes = 0;
      for (const file of files) bytes += file.size;
      sources.push({
        label: 'WorkBuddy transcripts',
        path: projectsDir,
        exists: true,
        files: files.length,
        bytes,
        note: 'CodeBuddy-format projects/<cwd>/<session>.jsonl; conversation parsing is not enabled (detection-only)',
      });
    } else {
      sources.push({
        label: 'WorkBuddy transcripts',
        path: projectsDir,
        exists: false,
        files: 0,
        bytes: 0,
        note: 'WorkBuddy home found but no projects/ transcripts',
      });
    }
    const tracesDir = join(home, 'traces');
    const tracesStat = await utils.statSafe(tracesDir);
    if (tracesStat && tracesStat.isDirectory) {
      sources.push({
        label: 'WorkBuddy trace summaries',
        path: tracesDir,
        exists: true,
        files: 0,
        bytes: 0,
        note: 'aggregate trace summaries; not parsed (detection-only)',
      });
    }
  }

  if (!found) {
    sources.push({
      label: 'WorkBuddy transcripts',
      path: join(homes[0], 'projects'),
      exists: false,
      files: 0,
      bytes: 0,
      note: 'WorkBuddy is not installed on this machine (no ~/.workbuddy or ~/.workbuddy-ai)',
    });
  } else {
    ctx.warn('WorkBuddy: a local transcript store was found but this provider is detection-only and reports no sessions');
  }

  return { sources, sessions: [] };
}
