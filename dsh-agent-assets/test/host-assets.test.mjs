/**
 * Dependency-free Host-module tests for the Agent Assets bundle.
 *
 * Run from the bundle directory: `node --test test/host-assets.test.mjs`
 * All fixtures live under a unique `os.tmpdir()` directory that is removed in
 * `after()`, so the tests never touch the real `~/.dsh` / `~/.agents` homes.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createSkills } from '../host/skills.js'
import { createInstructions } from '../host/instructions.js'
import { displayPath, parseSkillFile, renderSkillFile } from '../host/shared.js'

/** Filesystem root for the whole suite. */
let root
/** Isolated Harness homes (never the real ones). */
let homes
/** Main workspace. */
let workspace
/** Per-root skill directories. */
let projectDshSkills
let projectAgentsSkills
let userDshSkills
let userAgentsSkills
/** Skills API under test. */
let skills
/** Instruction-file API under test. */
let instructions
/** Instruction-fixture workspace. */
let instructionWorkspace

/** Write a SKILL.md fixture. */
async function writeSkillFixture(rootPath, name, options = {}) {
  const directory = join(rootPath, name)
  await mkdir(directory, { recursive: true })
  const lines = ['---', `name: ${name}`]
  if (options.description !== undefined) {
    lines.push(`description: ${JSON.stringify(options.description)}`)
  }
  if (options.whenToUse !== undefined && options.whenToUse !== null) {
    lines.push(`whenToUse: ${JSON.stringify(options.whenToUse)}`)
  }
  if (Array.isArray(options.extraLines)) lines.push(...options.extraLines)
  lines.push('---', '')
  await writeFile(join(directory, 'SKILL.md'), `${lines.join('\n')}${options.body ?? ''}`, 'utf8')
  return directory
}

/** Write a plain file fixture, creating parents. */
async function writeFileFixture(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/** Await a rejected AssetsError and assert its API code. */
async function expectError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, 'AssetsError')
    assert.equal(error?.code, code)
    assert.equal(typeof error?.message, 'string')
    return true
  })
}

/** `stat` that resolves to `undefined` when the path is absent. */
async function statOrUndefined(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-assets-test-'))
  homes = {
    dshHome: join(root, 'dsh-home'),
    agentsHome: join(root, 'agents-home'),
    claudeHome: join(root, 'claude-home'),
    windsurfHome: join(root, 'windsurf-home'),
    devinHome: join(root, 'devin-home'),
  }
  workspace = join(root, 'workspace')

  projectDshSkills = join(workspace, '.dsh', 'skills')
  projectAgentsSkills = join(workspace, '.agents', 'skills')
  userDshSkills = join(homes.dshHome, 'skills')
  userAgentsSkills = join(homes.agentsHome, 'skills')
  for (const directory of [projectDshSkills, projectAgentsSkills, userDshSkills, userAgentsSkills]) {
    await mkdir(directory, { recursive: true })
  }

  // Four filesystem roots with deliberate duplicates of `shared`.
  await writeSkillFixture(projectDshSkills, 'alpha', {
    description: 'Alpha project skill',
    whenToUse: 'When alpha',
    body: '# Alpha\n\nAlpha body.\n',
  })
  await writeSkillFixture(projectDshSkills, 'shared', {
    description: 'Shared from project-dsh',
    body: 'Project dsh body.\n',
  })
  await writeSkillFixture(projectAgentsSkills, 'beta', {
    description: 'Beta agents skill',
    body: 'Beta body.\n',
  })
  await writeSkillFixture(projectAgentsSkills, 'shared', {
    description: 'Shared from project-agents',
    body: 'Project agents body.\n',
  })
  await writeSkillFixture(userDshSkills, 'shared', {
    description: 'Shared from user-dsh',
    body: 'User dsh body.\n',
  })
  await writeSkillFixture(userDshSkills, 'gamma', {
    description: 'Gamma user skill',
    body: 'Gamma body.\n',
  })
  await writeSkillFixture(userDshSkills, 'delta', {
    description: 'Delta skill',
    body: 'Delta body.\n',
    extraLines: ['license: MIT', 'metadata: keep-me'],
  })
  await writeSkillFixture(userAgentsSkills, 'epsilon', {
    description: 'Epsilon agents skill',
    body: 'Epsilon body.\n',
  })
  await writeSkillFixture(userAgentsSkills, 'shared', {
    description: 'Shared from user-agents',
    body: 'User agents body.\n',
  })

  // Read-only provider entries; a filesystem-sourced entry must be ignored.
  const serviceEntries = [
    { name: 'bundled-one', description: 'Bundled skill', whenToUse: null, source: 'bundled', provider: 'bundled' },
    { name: 'shared', description: 'Service shared', whenToUse: null, source: 'bundled', provider: 'bundled' },
    { name: 'alpha', description: 'Service alpha duplicate', whenToUse: null, source: 'project-dsh', provider: 'filesystem' },
    { name: 'runtime-one', description: 'Runtime skill', whenToUse: null, source: 'runtime', provider: 'runtime' },
  ]
  skills = createSkills({ homes, serviceSkills: async () => serviceEntries })

  // Instruction-file fixtures.
  instructionWorkspace = join(root, 'instruction-workspace')
  await writeFileFixture(join(instructionWorkspace, 'AGENTS.md'), '# Workspace agents\n')
  await writeFileFixture(join(instructionWorkspace, 'CLAUDE.local.md'), '# Workspace claude local\n')
  await writeFileFixture(join(homes.dshHome, 'AGENTS.md'), '# DSH home agents\n')
  await writeFileFixture(join(instructionWorkspace, 'packages', 'app', 'AGENTS.md'), '# Nested app\n')
  await writeFileFixture(join(instructionWorkspace, 'extras', 'CLAUDE.md'), '# Nested extras\n')
  await writeFileFixture(join(instructionWorkspace, 'level2', 'CLAUDE.md'), '# Nested level2\n')
  await writeFileFixture(join(instructionWorkspace, 'node_modules', 'pkg', 'AGENTS.md'), '# Must be skipped\n')
  await writeFileFixture(join(instructionWorkspace, 'deep', 'a', 'b', 'AGENTS.md'), '# Too deep\n')

  instructions = createInstructions({ homes })
})

after(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('SKILL.md frontmatter: multi-line scalars', () => {
  it('reads folded/literal block scalars and plain continuations', () => {
    const folded = parseSkillFile('---\nname: a\ndescription: >-\n  line one\n  line two\n\n  para\nlicense: MIT\n---\nbody')
    assert.equal(folded.data.description, 'line one line two\npara')
    assert.deepEqual(folded.extraLines, ['license: MIT'])
    assert.equal(parseSkillFile('---\nname: b\ndescription: |\n  x\n    y\n---\n').data.description, 'x\n  y')
    assert.equal(parseSkillFile('---\nname: c\ndescription: first\n  second\n---\n').data.description, 'first second')
  })

  it('round-trips descriptions with backslashes and control characters', () => {
    for (const description of ['path is C:\\new\\table', 'tab\there', 'quote " and \\" mix', 'a: b', 'bell\u0007 end', '\\u0041 stays']) {
      const rendered = renderSkillFile({ data: { name: 'a', description }, body: 'b' })
      assert.equal(parseSkillFile(rendered).data.description, description)
    }
  })

  it('keeps nested unknown keys intact and never leaves orphan continuation lines on save', () => {
    const parsed = parseSkillFile('---\nname: d\ndescription: >\n  old text\n  more\nmetadata:\n  owner: me\n---\nB')
    assert.deepEqual(parsed.extraLines, ['metadata:', '  owner: me'])
    const rendered = renderSkillFile({ ...parsed, data: { ...parsed.data, description: 'new' } })
    assert.ok(!rendered.includes('old text'), rendered)
    const again = parseSkillFile(rendered)
    assert.equal(again.data.description, 'new')
    assert.deepEqual(again.extraLines, ['metadata:', '  owner: me'])
  })
})

describe('skills: listing', { concurrency: false }, () => {
  it('merges the four roots and the bundled service with precedence + shadowed', async () => {
    const result = await skills.list({ workspace })
    assert.equal(result.warnings.length, 0)
    assert.deepEqual(result.counts, { user: 3, workspace: 3, bundled: 2 })

    const names = result.skills.map((skill) => skill.name)
    assert.equal(result.skills.length, names.length)
    assert.deepEqual(names, [
      'alpha',
      'shared',
      'beta',
      'delta',
      'gamma',
      'epsilon',
      'bundled-one',
      'runtime-one',
    ])

    const alpha = result.skills.find((skill) => skill.name === 'alpha')
    assert.equal(alpha.scope, 'workspace')
    assert.equal(alpha.source, 'project-dsh')
    assert.equal(alpha.provider, 'filesystem')
    assert.equal(alpha.editable, true)
    assert.equal(alpha.whenToUse, 'When alpha')
    assert.equal(alpha.path, join(projectDshSkills, 'alpha', 'SKILL.md'))
    assert.equal(alpha.dir, join(projectDshSkills, 'alpha'))
    assert.deepEqual(alpha.shadowed, [])

    const shared = result.skills.find((skill) => skill.name === 'shared')
    assert.equal(shared.scope, 'workspace')
    assert.equal(shared.source, 'project-dsh')
    assert.equal(shared.path, join(projectDshSkills, 'shared', 'SKILL.md'))
    assert.deepEqual(shared.shadowed, [
      { scope: 'workspace', path: join(projectAgentsSkills, 'shared', 'SKILL.md') },
      { scope: 'user', path: join(userDshSkills, 'shared', 'SKILL.md') },
      { scope: 'user', path: join(userAgentsSkills, 'shared', 'SKILL.md') },
      { scope: 'bundled', path: null },
    ])
  })

  it('marks bundled/runtime entries read-only and pathless', async () => {
    const { skills: listed } = await skills.list({ workspace })
    const bundled = listed.find((skill) => skill.name === 'bundled-one')
    assert.equal(bundled.scope, 'bundled')
    assert.equal(bundled.source, 'bundled')
    assert.equal(bundled.provider, 'bundled')
    assert.equal(bundled.editable, false)
    assert.equal(bundled.path, null)
    assert.equal(bundled.dir, null)

    const runtime = listed.find((skill) => skill.name === 'runtime-one')
    assert.equal(runtime.scope, 'bundled')
    assert.equal(runtime.source, 'runtime')
    assert.equal(runtime.provider, 'runtime')
    assert.equal(runtime.editable, false)
  })

  it('survives a corrupt root with invalid/missing SKILL.md files', async () => {
    const corruptWorkspace = join(root, 'corrupt-workspace')
    const corruptRoot = join(corruptWorkspace, '.dsh', 'skills')
    await mkdir(join(corruptRoot, 'broken'), { recursive: true })
    await writeFile(join(corruptRoot, 'broken', 'SKILL.md'), 'no frontmatter at all\n', 'utf8')
    await mkdir(join(corruptRoot, 'empty'), { recursive: true })
    await writeFile(join(corruptRoot, 'stray-file.txt'), 'not a skill directory\n', 'utf8')
    await writeFileFixture(
      join(corruptRoot, 'Odd_Name', 'SKILL.md'),
      '---\nname: Odd_Name\ndescription: Legacy skill\n---\n\nLegacy body.\n',
    )

    const result = await skills.list({ workspace: corruptWorkspace })
    const byName = new Map(result.skills.map((skill) => [skill.name, skill]))
    assert.ok(byName.has('broken'))
    assert.ok(byName.has('empty'))
    assert.ok(!byName.has('stray-file.txt'))
    assert.equal(byName.get('broken').description, '')
    assert.ok(result.warnings.some((warning) => warning.includes('broken')))
    assert.ok(result.warnings.some((warning) => warning.includes('empty')))

    // Reads do not build a path from the name, so legacy directory names open.
    const legacy = await skills.read({ scope: 'workspace', workspace: corruptWorkspace, name: 'Odd_Name' })
    assert.equal(legacy.skill.description, 'Legacy skill')
    assert.ok(legacy.skill.body.includes('Legacy body.'))
  })

  it('never throws for absent skill roots', async () => {
    const result = await skills.list({ workspace: join(root, 'does-not-exist') })
    // The workspace roots are absent, so the user copies of `shared` win.
    assert.deepEqual(result.counts, { user: 4, workspace: 0, bundled: 2 })
    assert.deepEqual(result.skills.map((skill) => skill.name), [
      'delta',
      'gamma',
      'shared',
      'epsilon',
      'bundled-one',
      'runtime-one',
    ])
  })

  it('warns when the live skills service is unavailable', async () => {
    const nullSkills = createSkills({ homes, serviceSkills: async () => null })
    const nullResult = await nullSkills.list({ workspace })
    assert.equal(nullResult.counts.bundled, 0)
    assert.ok(nullResult.warnings.some((warning) => warning.includes('skills service unavailable')))

    const throwingSkills = createSkills({
      homes,
      serviceSkills: async () => {
        throw new Error('boom')
      },
    })
    const throwingResult = await throwingSkills.list({ workspace })
    assert.equal(throwingResult.counts.bundled, 0)
    assert.ok(throwingResult.warnings.some((warning) => warning.includes('boom')))
  })
})

describe('skills: reading', { concurrency: false }, () => {
  it('reads a filesystem skill with body + raw SKILL.md', async () => {
    const { skill } = await skills.read({ scope: 'workspace', workspace, name: 'alpha' })
    assert.equal(skill.name, 'alpha')
    assert.equal(skill.description, 'Alpha project skill')
    assert.equal(skill.whenToUse, 'When alpha')
    assert.equal(skill.scope, 'workspace')
    assert.ok(skill.raw.startsWith('---\nname: alpha'))
    assert.ok(skill.body.includes('# Alpha'))
    assert.ok(skill.body.includes('Alpha body.'))
  })

  it('reads a bundled entry without a body', async () => {
    const { skill } = await skills.read({ scope: 'bundled', workspace, name: 'bundled-one' })
    assert.equal(skill.scope, 'bundled')
    assert.equal(skill.editable, false)
    assert.equal(skill.body, '')
    assert.equal(skill.raw, '')
  })

  it('404s a missing skill', async () => {
    await expectError(skills.read({ scope: 'workspace', workspace, name: 'nope' }), 'not_found')
  })

  it('404s names that do not match a scanned skill and validates the argument type', async () => {
    await expectError(skills.read({ scope: 'workspace', workspace, name: '../escape' }), 'not_found')
    await expectError(skills.read({ scope: 'workspace', workspace, name: '' }), 'bad_request')
    await expectError(skills.read({ scope: 'workspace', workspace, name: 42 }), 'bad_request')
  })
})

describe('skills: create', { concurrency: false }, () => {
  it('creates a skill directory with parents and the supplied fields', async () => {
    const { skill } = await skills.create({
      scope: 'workspace',
      workspace,
      name: 'new-skill',
      description: 'New workspace skill',
      whenToUse: 'When new',
      body: '# New\n\ntext\n',
    })
    assert.equal(skill.name, 'new-skill')
    assert.equal(skill.scope, 'workspace')
    assert.equal(skill.source, 'project-dsh')
    assert.equal(skill.editable, true)
    assert.equal(skill.path, join(projectDshSkills, 'new-skill', 'SKILL.md'))
    assert.deepEqual(skill.shadowed, [])

    const text = await readFile(skill.path, 'utf8')
    assert.ok(text.includes('name: new-skill'))
    assert.ok(text.includes('description: New workspace skill'))
    assert.ok(text.includes('whenToUse: When new'))
    assert.ok(text.includes('---\n# New'))
    assert.ok(text.includes('text'))
  })

  it('reports same-scope duplicates as conflict, including the secondary root', async () => {
    await expectError(
      skills.create({ scope: 'workspace', workspace, name: 'new-skill', description: 'dup', body: '' }),
      'conflict',
    )
    // `epsilon` only exists under the user-agents root of the user scope.
    await expectError(
      skills.create({ scope: 'user', workspace, name: 'epsilon', description: 'dup', body: '' }),
      'conflict',
    )
  })

  it('lets a lower-precedence scope shadow a higher one and reports the shadowed copy', async () => {
    const { skill } = await skills.create({
      scope: 'user',
      workspace,
      name: 'alpha',
      description: 'User alpha override',
      body: 'user alpha\n',
    })
    assert.equal(skill.scope, 'user')
    assert.equal(skill.path, join(userDshSkills, 'alpha', 'SKILL.md'))
    assert.deepEqual(skill.shadowed, [
      { scope: 'workspace', path: join(projectDshSkills, 'alpha', 'SKILL.md') },
    ])
    // The workspace entry still wins the merged list.
    const { skill: winner } = await skills.read({ scope: 'workspace', workspace, name: 'alpha' })
    assert.equal(winner.description, 'Alpha project skill')
  })

  it('validates name, description, whenToUse, body and bundled scope', async () => {
    for (const name of ['../evil', 'Bad Name', 'a/b', 'UPPER_CASE', '']) {
      await expectError(skills.create({ scope: 'workspace', workspace, name, description: 'x', body: '' }), 'bad_request')
    }
    await expectError(
      skills.create({ scope: 'workspace', workspace, name: 'ok-name', description: '', body: '' }),
      'bad_request',
    )
    await expectError(
      skills.create({ scope: 'workspace', workspace, name: 'ok-name', description: 'a\nb', body: '' }),
      'bad_request',
    )
    await expectError(
      skills.create({ scope: 'workspace', workspace, name: 'ok-name', description: 'x', body: 42 }),
      'bad_request',
    )
    await expectError(
      skills.create({ scope: 'bundled', workspace, name: 'ok-name', description: 'x', body: '' }),
      'bad_request',
    )
  })
})

describe('skills: update', { concurrency: false }, () => {
  it('rewrites supplied fields and preserves unknown frontmatter', async () => {
    const { skill } = await skills.update({
      scope: 'user',
      workspace,
      name: 'delta',
      description: 'Updated delta',
      whenToUse: 'When updated',
      body: 'Updated body.\n',
    })
    assert.equal(skill.description, 'Updated delta')
    assert.equal(skill.whenToUse, 'When updated')

    const text = await readFile(join(userDshSkills, 'delta', 'SKILL.md'), 'utf8')
    assert.ok(text.includes('name: delta'))
    assert.ok(text.includes('description: Updated delta'))
    assert.ok(text.includes('whenToUse: When updated'))
    assert.ok(text.includes('license: MIT'), 'unknown frontmatter must survive an update')
    assert.ok(text.includes('metadata: keep-me'), 'unknown frontmatter must survive an update')
    assert.ok(text.includes('Updated body.'))

    const { skill: reread } = await skills.read({ scope: 'user', workspace, name: 'delta' })
    assert.equal(reread.description, 'Updated delta')
    assert.ok(reread.body.includes('Updated body.'))
  })

  it('keeps whenToUse when omitted and clears it on explicit null', async () => {
    const { skill: kept } = await skills.update({
      scope: 'user',
      workspace,
      name: 'delta',
      description: 'Delta again',
      body: 'Second body.\n',
    })
    assert.equal(kept.whenToUse, 'When updated')

    const { skill: cleared } = await skills.update({
      scope: 'user',
      workspace,
      name: 'delta',
      description: 'Delta final',
      whenToUse: null,
      body: 'Final body.\n',
    })
    assert.equal(cleared.whenToUse, null)
    const text = await readFile(join(userDshSkills, 'delta', 'SKILL.md'), 'utf8')
    assert.ok(!text.includes('whenToUse:'))
    assert.ok(text.includes('license: MIT'))
  })

  it('404s a missing skill and rejects bundled updates', async () => {
    await expectError(
      skills.update({ scope: 'user', workspace, name: 'nope', description: 'x', body: '' }),
      'not_found',
    )
    await expectError(
      skills.update({ scope: 'bundled', workspace, name: 'bundled-one', description: 'x', body: '' }),
      'bad_request',
    )
    await expectError(
      skills.update({ scope: 'user', workspace, name: 'delta', description: '', body: '' }),
      'bad_request',
    )
  })
})

describe('skills: remove', { concurrency: false }, () => {
  it('deletes the whole skill directory and 404s afterwards', async () => {
    const directory = join(projectDshSkills, 'new-skill')
    const result = await skills.remove({ scope: 'workspace', workspace, name: 'new-skill' })
    assert.deepEqual(result, { deleted: true, name: 'new-skill', scope: 'workspace' })
    assert.equal(await statOrUndefined(directory), undefined)
    await expectError(skills.read({ scope: 'workspace', workspace, name: 'new-skill' }), 'not_found')
    await expectError(skills.remove({ scope: 'workspace', workspace, name: 'new-skill' }), 'not_found')
  })

  it('rejects traversal names and bundled deletions', async () => {
    await expectError(skills.remove({ scope: 'workspace', workspace, name: '../..' }), 'bad_request')
    await expectError(skills.remove({ scope: 'bundled', workspace, name: 'bundled-one' }), 'bad_request')
  })
})

describe('skills: path safety', { concurrency: false }, () => {
  it('skips a skill directory that symlinks outside its root', async () => {
    const outside = join(root, 'outside-skill')
    await mkdir(outside, { recursive: true })
    await writeSkillFixture(root, 'outside-skill', { description: 'Outside skill', body: 'outside\n' })
    await symlink(outside, join(projectDshSkills, 'evil-link'))

    const result = await skills.list({ workspace })
    assert.ok(!result.skills.some((skill) => skill.name === 'evil-link'))
    assert.ok(result.warnings.some((warning) => warning.includes('resolves outside')))

    await expectError(skills.read({ scope: 'workspace', workspace, name: 'evil-link' }), 'not_found')
    await expectError(skills.remove({ scope: 'workspace', workspace, name: 'evil-link' }), 'not_found')
    assert.ok((await statOrUndefined(outside)) !== undefined, 'outside tree must be untouched')
  })

  it('refuses to read through a SKILL.md symlinked outside the root', async () => {
    const leakyDirectory = join(projectDshSkills, 'leaky')
    await mkdir(leakyDirectory, { recursive: true })
    const secret = join(root, 'secret.md')
    await writeFile(secret, '# SECRET\n', 'utf8')
    await symlink(secret, join(leakyDirectory, 'SKILL.md'))

    const result = await skills.list({ workspace })
    assert.ok(result.skills.some((skill) => skill.name === 'leaky'))
    assert.ok(result.warnings.some((warning) => warning.includes('leaky')))

    await expectError(skills.read({ scope: 'workspace', workspace, name: 'leaky' }), 'forbidden')
    // Deleting the real directory is safe (the symlink is unlinked, not followed).
    const removal = await skills.remove({ scope: 'workspace', workspace, name: 'leaky' })
    assert.deepEqual(removal, { deleted: true, name: 'leaky', scope: 'workspace' })
    assert.equal(await statOrUndefined(leakyDirectory), undefined)
    assert.equal(await readFile(secret, 'utf8'), '# SECRET\n')
  })
})

describe('instructions: listing', { concurrency: false }, () => {
  it('lists the six fixed candidates, then sorted nested files', async () => {
    const result = await instructions.list({ workspace: instructionWorkspace })
    assert.equal(result.warnings.length, 0)

    const paths = result.files.map((file) => file.path)
    const expectedPrefix = [
      join(homes.dshHome, 'AGENTS.md'),
      join(homes.agentsHome, 'AGENTS.md'),
      join(instructionWorkspace, 'AGENTS.md'),
      join(instructionWorkspace, 'CLAUDE.md'),
      join(instructionWorkspace, 'AGENTS.local.md'),
      join(instructionWorkspace, 'CLAUDE.local.md'),
    ]
    assert.deepEqual(paths.slice(0, 6), expectedPrefix)
    assert.deepEqual(paths.slice(6), [
      join(instructionWorkspace, 'extras', 'CLAUDE.md'),
      join(instructionWorkspace, 'level2', 'CLAUDE.md'),
      join(instructionWorkspace, 'packages', 'app', 'AGENTS.md'),
    ])
    assert.equal(result.files.length, 9)
  })

  it('exposes label, displayPath, id, scope and exists metadata', async () => {
    const { files } = await instructions.list({ workspace: instructionWorkspace })
    const userDsh = files[0]
    assert.equal(userDsh.scope, 'user')
    assert.equal(userDsh.file, 'AGENTS.md')
    assert.equal(userDsh.label, displayPath(join(homes.dshHome, 'AGENTS.md')))
    assert.equal(userDsh.displayPath, displayPath(join(homes.dshHome, 'AGENTS.md')))
    assert.equal(userDsh.editable, true)
    assert.equal(userDsh.exists, true)
    assert.equal(userDsh.size, Buffer.byteLength('# DSH home agents\n', 'utf8'))
    assert.equal(typeof userDsh.modifiedAt, 'string')
    assert.ok(!Number.isNaN(Date.parse(userDsh.modifiedAt)))
    assert.equal(userDsh.id, `user|${userDsh.path}`)

    const userAgents = files[1]
    assert.equal(userAgents.scope, 'user')
    assert.equal(userAgents.exists, false)
    assert.equal(userAgents.size, 0)
    assert.equal(userAgents.modifiedAt, null)

    const workspaceAgents = files[2]
    assert.equal(workspaceAgents.scope, 'workspace')
    assert.equal(workspaceAgents.label, 'AGENTS.md')
    assert.equal(workspaceAgents.displayPath, './AGENTS.md')
    assert.equal(workspaceAgents.exists, true)
    assert.equal(workspaceAgents.id, `workspace|${workspaceAgents.path}`)

    const missingCandidate = files.find(
      (file) => file.path === join(instructionWorkspace, 'CLAUDE.md'),
    )
    assert.equal(missingCandidate.exists, false)
    assert.equal(missingCandidate.label, 'CLAUDE.md')
  })

  it('labels nested files with workspace-relative paths and skips blocked/deep dirs', async () => {
    const { files } = await instructions.list({ workspace: instructionWorkspace })
    const nested = files.slice(6)
    assert.deepEqual(nested.map((file) => file.label), [
      'extras/CLAUDE.md',
      'level2/CLAUDE.md',
      'packages/app/AGENTS.md',
    ])
    for (const file of nested) {
      assert.equal(file.scope, 'workspace')
      assert.equal(file.editable, true)
      assert.equal(file.exists, true)
      assert.equal(file.displayPath, `./${file.label}`)
    }
    assert.ok(!files.some((file) => file.path.includes('node_modules')))
    assert.ok(!files.some((file) => file.path.endsWith(join('deep', 'a', 'b', 'AGENTS.md'))))
  })

  it('still lists the fixed candidates for an absent workspace', async () => {
    const result = await instructions.list({ workspace: join(root, 'no-such-workspace') })
    assert.equal(result.files.length, 6)
    assert.ok(
      result.files
        .filter((file) => file.scope === 'workspace')
        .every((file) => file.exists === false),
    )
    assert.equal(result.warnings.length, 0)
  })
})

describe('instructions: read/write/delete', { concurrency: false }, () => {
  it('returns exists:false + empty content for a missing candidate (not 404)', async () => {
    const { instruction } = await instructions.read({
      scope: 'workspace',
      workspace: instructionWorkspace,
      path: join(instructionWorkspace, 'CLAUDE.md'),
    })
    assert.equal(instruction.exists, false)
    assert.equal(instruction.content, '')
    assert.equal(instruction.size, 0)
  })

  it('reads an existing candidate verbatim', async () => {
    const { instruction } = await instructions.read({
      scope: 'workspace',
      workspace: instructionWorkspace,
      path: join(instructionWorkspace, 'AGENTS.md'),
    })
    assert.equal(instruction.exists, true)
    assert.equal(instruction.content, '# Workspace agents\n')
    assert.equal(instruction.size, Buffer.byteLength('# Workspace agents\n', 'utf8'))
  })

  it('writes, re-reads and deletes an existing-target-candidate file', async () => {
    const target = join(instructionWorkspace, 'CLAUDE.md')
    const written = await instructions.write({
      scope: 'workspace',
      workspace: instructionWorkspace,
      path: target,
      content: 'written via api\n',
    })
    assert.equal(written.instruction.exists, true)
    assert.equal(written.instruction.content, 'written via api\n')
    assert.equal(written.instruction.path, target)
    assert.equal(await readFile(target, 'utf8'), 'written via api\n')

    const { instruction: reread } = await instructions.read({
      scope: 'workspace',
      workspace: instructionWorkspace,
      path: target,
    })
    assert.equal(reread.content, 'written via api\n')

    const deleted = await instructions.remove({
      scope: 'workspace',
      workspace: instructionWorkspace,
      path: target,
    })
    assert.deepEqual(deleted, { deleted: true })
    assert.equal(await statOrUndefined(target), undefined)
    await expectError(
      instructions.remove({ scope: 'workspace', workspace: instructionWorkspace, path: target }),
      'not_found',
    )
  })

  it('creates parent directories on write', async () => {
    const orphanHome = join(root, 'orphan-home')
    const orphanInstructions = createInstructions({
      homes: {
        dshHome: orphanHome,
        agentsHome: join(root, 'orphan-agents'),
        claudeHome: join(root, 'orphan-claude'),
        windsurfHome: join(root, 'orphan-windsurf'),
        devinHome: join(root, 'orphan-devin'),
      },
    })
    const target = join(orphanHome, 'AGENTS.md')
    const { instruction } = await orphanInstructions.write({
      scope: 'user',
      workspace: instructionWorkspace,
      path: target,
      content: 'parent created\n',
    })
    assert.equal(instruction.exists, true)
    assert.equal(instruction.content, 'parent created\n')
    assert.equal(await readFile(target, 'utf8'), 'parent created\n')
    assert.equal(await statOrUndefined(orphanHome).then((info) => info?.isDirectory()), true)
  })

  it('rejects paths outside the enumerated candidates with forbidden', async () => {
    await expectError(
      instructions.read({
        scope: 'workspace',
        workspace: instructionWorkspace,
        path: join(instructionWorkspace, 'random.md'),
      }),
      'forbidden',
    )
    await expectError(
      instructions.read({
        scope: 'workspace',
        workspace: instructionWorkspace,
        path: join(instructionWorkspace, 'deep', 'a', 'b', 'AGENTS.md'),
      }),
      'forbidden',
    )
    await expectError(
      instructions.read({
        scope: 'workspace',
        workspace: instructionWorkspace,
        path: join(homes.dshHome, 'AGENTS.md'),
      }),
      'forbidden',
    )
    await expectError(
      instructions.write({
        scope: 'workspace',
        workspace: instructionWorkspace,
        path: join(instructionWorkspace, 'random.md'),
        content: 'x',
      }),
      'forbidden',
    )
    await expectError(
      instructions.remove({
        scope: 'user',
        workspace: instructionWorkspace,
        path: join(instructionWorkspace, 'AGENTS.md'),
      }),
      'forbidden',
    )
  })

  it('rejects bundled scope and invalid input', async () => {
    await expectError(
      instructions.read({ scope: 'bundled', workspace: instructionWorkspace, path: 'anything' }),
      'bad_request',
    )
    await expectError(
      instructions.write({
        scope: 'workspace',
        workspace: instructionWorkspace,
        path: join(instructionWorkspace, 'CLAUDE.local.md'),
        content: 42,
      }),
      'bad_request',
    )
    await expectError(
      instructions.read({ scope: 'workspace', workspace: instructionWorkspace, path: 42 }),
      'bad_request',
    )
  })

  it('rejects reading, writing or deleting through a symlink escape', async () => {
    const symlinkWorkspace = join(root, 'symlink-workspace')
    await mkdir(symlinkWorkspace, { recursive: true })
    const secret = join(root, 'outside-secret.md')
    await writeFile(secret, 'TOP SECRET\n', 'utf8')
    const candidate = join(symlinkWorkspace, 'AGENTS.md')
    await symlink(secret, candidate)

    await expectError(
      instructions.read({ scope: 'workspace', workspace: symlinkWorkspace, path: candidate }),
      'forbidden',
    )
    await expectError(
      instructions.write({
        scope: 'workspace',
        workspace: symlinkWorkspace,
        path: candidate,
        content: 'overwritten\n',
      }),
      'forbidden',
    )
    await expectError(
      instructions.remove({ scope: 'workspace', workspace: symlinkWorkspace, path: candidate }),
      'forbidden',
    )
    assert.equal(await readFile(secret, 'utf8'), 'TOP SECRET\n')
  })
})

describe('third-party read-only assets', { concurrency: false }, () => {
  // Separate sandbox homes so nothing under the developer's real agent
  // directories (~/.claude, ~/.codeium/windsurf, ~/.devin) is ever touched.
  // `root` only exists after the outer `before`, so resolve lazily per test.
  const roHomes = () => {
    const roRoot = join(root, 'readonly-homes')
    return {
      dshHome: join(roRoot, 'dsh'),
      agentsHome: join(roRoot, 'agents'),
      claudeHome: join(roRoot, 'claude'),
      windsurfHome: join(roRoot, 'windsurf'),
      devinHome: join(roRoot, 'devin'),
    }
  }

  it('lists third-party skills read-only and refuses to mutate them', async () => {
    const homes = roHomes()
    await writeSkillFixture(join(homes.windsurfHome, 'skills'), 'foreign-skill', {
      description: 'Windsurf skill',
      body: 'foreign body\n',
    })
    await writeSkillFixture(join(homes.claudeHome, 'skills'), 'claude-skill', {
      description: 'Claude skill',
    })
    const roSkills = createSkills({ homes })
    const { skills: list, counts } = await roSkills.list({ workspace })
    const foreign = list.find((skill) => skill.name === 'foreign-skill')
    assert.equal(foreign.scope, 'user')
    assert.equal(foreign.source, 'user-windsurf')
    assert.equal(foreign.editable, false)
    assert.equal(list.find((skill) => skill.name === 'claude-skill').source, 'user-claude')
    assert.equal(counts.user, 2)

    const { skill } = await roSkills.read({ scope: 'user', name: 'foreign-skill', workspace })
    assert.match(skill.body, /foreign body/)

    await expectError(
      roSkills.update({ scope: 'user', name: 'foreign-skill', description: 'x', workspace }),
      'forbidden',
    )
    await expectError(
      roSkills.remove({ scope: 'user', name: 'foreign-skill', workspace }),
      'forbidden',
    )

    // Creating the same name in a writable root is allowed and shadows the foreign copy.
    const created = await roSkills.create({
      scope: 'user',
      name: 'foreign-skill',
      description: 'local copy',
      workspace,
    })
    assert.ok(created.skill.shadowed.some((entry) => entry.scope === 'user'))
  })

  it('lists third-party instruction files read-only and refuses to mutate them', async () => {
    const homes = roHomes()
    await writeFileFixture(join(homes.claudeHome, 'CLAUDE.md'), '# Claude rules\n')
    await writeFileFixture(
      join(homes.windsurfHome, 'memories', 'global_rules.md'),
      '# Windsurf rules\n',
    )
    const roInstructions = createInstructions({ homes })
    const { files } = await roInstructions.list({ workspace })

    const claude = files.find((file) => file.path === join(homes.claudeHome, 'CLAUDE.md'))
    assert.equal(claude.scope, 'user')
    assert.equal(claude.editable, false)
    assert.equal(claude.exists, true)
    const windsurf = files.find(
      (file) => file.path === join(homes.windsurfHome, 'memories', 'global_rules.md'),
    )
    assert.equal(windsurf.editable, false)

    // Absent third-party files are not listed — there is nothing to create there.
    assert.ok(!files.some((file) => file.path === join(homes.devinHome, 'AGENTS.md')))

    const { instruction } = await roInstructions.read({
      scope: 'user',
      workspace,
      path: join(homes.claudeHome, 'CLAUDE.md'),
    })
    assert.match(instruction.content, /Claude rules/)
    await expectError(
      roInstructions.write({
        scope: 'user',
        workspace,
        path: join(homes.claudeHome, 'CLAUDE.md'),
        content: 'x',
      }),
      'forbidden',
    )
    await expectError(
      roInstructions.remove({
        scope: 'user',
        workspace,
        path: join(homes.claudeHome, 'CLAUDE.md'),
      }),
      'forbidden',
    )
  })
})
