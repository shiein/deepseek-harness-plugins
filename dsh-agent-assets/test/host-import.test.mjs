/**
 * Skill import: discovery layouts, archives, conflicts/overwrite, symlink + size safety.
 * Everything runs in a temp tree; the real ~/.dsh / ~/.agents are never touched.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSkills } from '../host/skills.js'

let root
let skills
let workspace
let userDsh

async function pkg(dir, name, extra = {}) {
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  ${extra.description ?? `about ${name}`}\n---\nbody of ${name}\n`)
  await writeFile(join(dir, 'scripts', 'run.sh'), 'echo hi\n')
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'aa-import-'))
  workspace = join(root, 'ws')
  await mkdir(workspace, { recursive: true })
  userDsh = join(root, 'home', '.dsh')
  skills = createSkills({ homes: { dshHome: userDsh, agentsHome: join(root, 'home', '.agents') } })
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('skills: import', { concurrency: false }, () => {
  it('imports a single skill folder with its assets', async () => {
    const src = join(root, 'src-single', 'alpha')
    await pkg(src, 'alpha')
    const dry = await skills.importSkills({ scope: 'user', workspace, source: src, dryRun: true })
    assert.equal(dry.candidates.length, 1)
    assert.equal(dry.candidates[0].name, 'alpha')
    assert.equal(dry.candidates[0].description, 'about alpha')
    assert.equal(dry.candidates[0].files, 2)
    const done = await skills.importSkills({ scope: 'user', workspace, source: src })
    assert.deepEqual(done.imported.map((item) => item.name), ['alpha'])
    assert.equal(await readFile(join(userDsh, 'skills', 'alpha', 'scripts', 'run.sh'), 'utf8'), 'echo hi\n')
    const leftovers = (await readdir(join(userDsh, 'skills'))).filter((name) => name.startsWith('.'))
    assert.deepEqual(leftovers, [])
  })

  it('discovers a repository layout and imports only the selected names', async () => {
    const repo = join(root, 'repo')
    await pkg(join(repo, 'skills', 'beta'), 'beta')
    await pkg(join(repo, 'skills', 'gamma'), 'gamma')
    await mkdir(join(repo, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(repo, 'node_modules', 'x', 'SKILL.md'), '---\nname: nope\n---\n')
    const dry = await skills.importSkills({ scope: 'workspace', workspace, source: repo, dryRun: true })
    assert.deepEqual(dry.candidates.map((item) => item.name).sort(), ['beta', 'gamma'])
    const done = await skills.importSkills({ scope: 'workspace', workspace, source: repo, names: ['gamma'] })
    assert.deepEqual(done.imported.map((item) => item.name), ['gamma'])
    assert.ok((await lstat(join(workspace, '.dsh', 'skills', 'gamma', 'SKILL.md'))).isFile())
    await assert.rejects(lstat(join(workspace, '.dsh', 'skills', 'beta')))
  })

  it('skips an existing name unless overwrite, then replaces it in place', async () => {
    const src = join(root, 'src-v2', 'alpha')
    await pkg(src, 'alpha', { description: 'second version' })
    const dry = await skills.importSkills({ scope: 'user', workspace, source: src, dryRun: true })
    assert.ok(dry.candidates[0].conflict)
    const skipped = await skills.importSkills({ scope: 'user', workspace, source: src })
    assert.equal(skipped.imported.length, 0)
    assert.equal(skipped.skipped[0].name, 'alpha')
    const replaced = await skills.importSkills({ scope: 'user', workspace, source: src, overwrite: true })
    assert.equal(replaced.imported[0].replaced, true)
    assert.match(await readFile(join(userDsh, 'skills', 'alpha', 'SKILL.md'), 'utf8'), /second version/)
  })

  it('never copies symlinks and rejects invalid names', async () => {
    const src = join(root, 'src-link', 'delta')
    await pkg(src, 'delta')
    await symlink('/etc/hosts', join(src, 'escape'))
    const bad = join(root, 'src-bad', 'Bad_Name')
    await mkdir(bad, { recursive: true })
    await writeFile(join(bad, 'SKILL.md'), '---\nname: Bad_Name\ndescription: x\n---\n')
    const done = await skills.importSkills({ scope: 'user', workspace, source: src })
    assert.deepEqual(done.imported.map((item) => item.name), ['delta'])
    await assert.rejects(lstat(join(userDsh, 'skills', 'delta', 'escape')))
    const dry = await skills.importSkills({ scope: 'user', workspace, source: bad, dryRun: true })
    assert.match(dry.candidates[0].error, /kebab-case/)
  })

  it('unpacks a .zip archive', async (t) => {
    const stage = join(root, 'zip-stage')
    await pkg(join(stage, 'epsilon'), 'epsilon')
    const archive = join(root, 'epsilon.zip')
    try {
      execFileSync(process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar', ['-a', '-cf', archive, '-C', stage, 'epsilon'])
    } catch {
      t.skip('platform tar cannot write zip archives')
      return
    }
    const done = await skills.importSkills({ scope: 'user', workspace, source: archive })
    assert.deepEqual(done.imported.map((item) => item.name), ['epsilon'])
    assert.ok((await lstat(join(userDsh, 'skills', 'epsilon', 'scripts', 'run.sh'))).isFile())
  })

  it('reports a missing source and refuses the bundled scope', async () => {
    await assert.rejects(skills.importSkills({ scope: 'user', workspace, source: join(root, 'missing') }), (error) => error.code === 'not_found')
    await assert.rejects(skills.importSkills({ scope: 'bundled', workspace, source: root }))
  })
})
