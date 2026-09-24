import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

// Views without editing JSON: `view add`, the writer of the project file
// behind it, the questions a person at a terminal is asked, and the counts of
// what a view would show. Temporary directories and invented notes only.
//
// Nothing here may start another program but git (the project loader asks it
// whether `.atelier-local/` is ignored): an attempt throws before it runs.
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[method]
  childProcess[method] = function guarded(command, ...rest) {
    const program = path.basename(String(command).replaceAll('\\', '/')).toLowerCase().replace(/\.exe$/, '')
    if (program !== 'git') throw new Error(`spawn guard: this suite starts git only, never "${program}"`)
    return original.call(this, command, ...rest)
  }
}
syncBuiltinESMExports()

const { resolveProjectConfig, writeJson } = await import('../src/project/config.mjs')
const { EXIT, runObsidianCommand } = await import('../src/commands/obsidian.mjs')
const { ONLY_YOU_AUDIENCES, defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots, withDecision, workspaceStateRoot, writeMachineSettings } = await import('../src/runtime/obsidian/machine-settings.mjs')
const { DEFAULT_VIEW, planViewAdd, unifiedDiff, viewFromRequest, writeViewPlan } = await import('../src/runtime/obsidian/project-views.mjs')
const { askGoAhead, createQuestioner } = await import('../src/runtime/obsidian/questions.mjs')
const { viewCounts } = await import('../src/runtime/obsidian/view-counts.mjs')
const { onlyYouEligibility } = await import('../src/runtime/obsidian/pipeline.mjs')
const { resolveGitExecutable, runGit } = await import('../src/runtime/git-adapter.mjs')

const TMP = fs.realpathSync(os.tmpdir())
const EXT = 'mnstry.atelier.obsidian'
const NOW = '2026-01-05T10:00:00.000Z'
const POSIX = process.platform !== 'win32'

const note = ({ id, title, audience = 'team', tags, body = '' }) => [
  '---', `title: "${title}"`, ...(tags ? [`tags: [${tags.map((tag) => `"${tag}"`).join(', ')}]`] : []),
  'kg:', `  id: "${id}"`, '  type: "document"', '  status: "active"', `  audience: "${audience}"`, '---', '', `# ${title}`, '', body, '',
].join('\n')
const draft = (title) => `---\ntitle: "${title}"\n---\n\n# ${title}\n`
// Three notes anyone "only you" admits may see, one of an audience it does not admit, and two without a classification.
const FILES = {
  'harbor/notes/lantern.md': note({ id: 'harbor:lantern', title: 'Lantern room', tags: ['lighthouse'], body: 'The lamp turns once a minute.' }),
  'harbor/notes/compass.md': note({ id: 'harbor:compass', title: 'Compass rose', body: 'North is painted red. See the [tide log](../logs/tide.md).' }),
  'harbor/logs/tide.md': note({ id: 'harbor:tide', title: 'Tide log', audience: 'staff', body: 'High water at noon.' }),
  'harbor/logs/storm.md': note({ id: 'harbor:storm', title: 'Storm log', audience: 'sensitive', body: 'Kept apart.' }),
  'harbor/drafts/sketch.md': draft('Sketch'),
  'harbor/drafts/outline.md': draft('Outline'),
}
const projectDocument = ({ repositories = ['harbor'], ext } = {}) => ({
  schema: 'mnstry.atelier-project-config@v1', name: 'harbor-notes', roots: { workspace: '.', repoOps: '.' },
  graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
  projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
  repos: repositories.map((name) => ({ name, path: name, readBoundary: 'team' })),
  ...(ext === undefined ? {} : { ext: { [EXT]: ext } }),
})
const settingsOf = (scopes, extra = {}) => ({ schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes, ...extra })

// A project in a temporary directory. `git`: the project folder is a git repository, where `.atelier-local/` is not
// ignored until a .gitignore says so; without it, nothing is committed from there and nothing needs ignoring.
function makeWorld(t, { repositories = ['harbor'], ext, git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-views-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const projectDir = path.join(dir, 'project')
  for (const [relative, content] of Object.entries(FILES)) {
    const [repository, ...rest] = relative.split('/')
    if (!repositories.includes(repository)) continue
    fs.mkdirSync(path.dirname(path.join(projectDir, repository, ...rest)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, repository, ...rest), content)
  }
  for (const name of repositories) {
    fs.mkdirSync(path.join(projectDir, name, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, name, 'notes', `${name}-index.md`), note({ id: `${name}:index`, title: `${name} index` }))
    if (!git) fs.mkdirSync(path.join(projectDir, name, '.git'), { recursive: true })
  }
  if (git) {
    const executable = resolveGitExecutable()
    runGit(executable, projectDir, ['init', '--initial-branch=main'])
  }
  const configPath = path.join(projectDir, 'atelier.project.json')
  writeJson(configPath, projectDocument({ repositories, ext }))
  writeJson(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: Object.fromEntries(repositories.map((name) => [name, { readBoundary: 'team' }])) })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, CI: _ci, ATELIER_NONINTERACTIVE: _quiet, ...env } = process.env
  const loadProject = () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: projectDir, env, writeLocalState: false })
  const dataRoot = path.join(dir, 'data')
  const world = {
    dir, projectDir, configPath, dataRoot, env, loadProject,
    text: () => fs.readFileSync(configPath, 'utf8'),
    gitignore: () => fs.readFileSync(path.join(projectDir, '.gitignore'), { encoding: 'utf8', flag: fs.constants.O_RDONLY }),
    // The command in this process, as an agent runs it, or as a person at a terminal who types `answers`.
    async run(argv, { person = false, answers = null, ...extra } = {}) {
      const out = []
      const err = []
      const input = new PassThrough()
      const output = new PassThrough()
      const asked = []
      output.on('data', (chunk) => asked.push(String(chunk)))
      if (answers !== null) { input.write(answers.join('')); input.end() }
      const exit = await runObsidianCommand({
        argv: [...argv, `--project=${configPath}`, `--data-root=${dataRoot}`], seams: {}, env, cwd: projectDir, clock: () => new Date(NOW), contributions: [],
        stdout: (text) => out.push(text), stderr: (text) => err.push(text), ...(person ? { terminal: { stdin: true, stdout: true }, input, output, account: () => 'harbor-keeper' } : {}), ...extra,
      })
      const stdout = out.join('\n')
      let json = null
      try { json = JSON.parse(stdout) } catch { json = null }
      return { exit, stdout, stderr: err.join('\n'), json, asked: asked.join('') }
    },
    // Machine settings for this workspace, as `audience set` leaves them.
    decideAudience(audienceAllow, choice) {
      const project = loadProject()
      const pointer = ensureWorkspaceIdentity({ project, dataRoot, randomBytes: (size) => Buffer.alloc(size, 7) })
      const workspaceRoot = workspaceStateRoot(dataRoot, pointer.workspaceId)
      const settings = withDecision({ ...defaultMachineSettings({ workspaceId: pointer.workspaceId, updatedAt: NOW }), audienceAllow }, 'audience', { choice, unclassified: 'withheld' }, { decidedAt: NOW, via: 'command' })
      writeMachineSettings({ workspaceRoot, workspaceId: pointer.workspaceId, repositoryRoots: protectedRoots(project), settings })
    },
  }
  return world
}

test('`view add` turns what a person asks for into one view: every note, folders of a repository, or a tag', () => {
  const repositories = ['harbor']
  assert.deepEqual(viewFromRequest({ scopeId: 'everything', all: true, repositories }), { scopeId: 'everything', mode: 'full', selector: { all: true } })
  assert.deepEqual(viewFromRequest({ scopeId: 'north', folders: ['notes'], repositories }), { scopeId: 'north', mode: 'scoped', selector: { repo: 'harbor', pathPrefix: 'notes' } })
  assert.deepEqual(
    viewFromRequest({ scopeId: 'north', folders: ['./notes/', 'logs', 'notes'], repositories }),
    { scopeId: 'north', mode: 'scoped', selector: { union: [{ repo: 'harbor', pathPrefix: 'notes' }, { repo: 'harbor', pathPrefix: 'logs' }] } },
    'several folders are a union, each named once, written as the repository names them',
  )
  assert.deepEqual(viewFromRequest({ scopeId: 'all-harbor', folders: ['.', 'notes'], repositories }).selector, { repo: 'harbor' }, 'the repository\'s root is the whole repository')
  assert.deepEqual(viewFromRequest({ scopeId: 'west', folders: ['logs'], repo: 'west-wing', repositories: ['harbor', 'west-wing'] }).selector, { repo: 'west-wing', pathPrefix: 'logs' })
  assert.deepEqual(viewFromRequest({ scopeId: 'beacons', tag: 'lighthouse', repositories }), { scopeId: 'beacons', mode: 'scoped', selector: { tag: 'lighthouse' } })
  assert.deepEqual(
    viewFromRequest({ scopeId: 'north', folders: ['notes'], expand: '2:40', repositories }).expansion,
    { depth: 2, maxNodes: 40, direction: 'outgoing', order: 'canonical-id' },
    'an expansion follows outgoing links, in canonical order, within both budgets',
  )
  const refusals = [
    [{ scopeId: 'x', repositories }, 'usage', 'no selector'],
    [{ scopeId: 'x', all: true, tag: 't', repositories }, 'usage', 'two selectors'],
    [{ scopeId: 'x', tag: 't', repo: 'harbor', repositories }, 'usage', '--repo without --folder'],
    [{ scopeId: 'x', all: true, expand: '1:5', repositories }, 'usage', 'nothing to expand in every note'],
    [{ scopeId: '-x', all: true, repositories }, 'usage', 'a name that is no identifier'],
    [{ scopeId: 'x y', all: true, repositories }, 'usage', 'a name with a space'],
    [{ scopeId: 'x', folders: ['notes'], repositories: ['harbor', 'west-wing'] }, 'view-repository-ambiguous', 'two repositories and no --repo'],
    [{ scopeId: 'x', folders: ['notes'], repo: 'nowhere', repositories }, 'unknown-repo', 'a repository the project does not enrol'],
    ...['/abs/notes', '~/notes', 'C:/notes', 'notes/../..', '..', 'a\\b'].map((folder) => [{ scopeId: 'x', folders: [folder], repositories }, 'invalid-view', `folder ${folder}`]),
    ...['2', '0:5', '9:5', '1:0', '1:100001', 'x:y', '1:5:2'].map((expand) => [{ scopeId: 'x', folders: ['notes'], expand, repositories }, 'invalid-view', `--expand ${expand}`]),
  ]
  for (const [request, code, label] of refusals) assert.throws(() => viewFromRequest(request), (error) => error.code === code, label)
})

test('the project file gets the new view and nothing else: the exact change, over the bytes read, in the form it is in', (t) => {
  const world = makeWorld(t)
  const project = world.loadProject()
  const before = world.text()
  const plan = planViewAdd(project, { scope: DEFAULT_VIEW })
  assert.equal(world.text(), before, 'planning writes nothing')
  assert.deepEqual(plan.settings, { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, defaultScopeId: 'everything', scopes: [{ scopeId: 'everything', mode: 'full', selector: { all: true } }] }, 'the first view is the default')
  assert.equal(plan.ignore.needed, false, 'a project outside git commits nothing, so nothing needs ignoring')
  assert.equal(plan.diff, [
    '--- atelier.project.json',
    '+++ atelier.project.json',
    '@@ -19,5 +19,21 @@',
    '       "path": "harbor",',
    '       "readBoundary": "team"',
    '     }',
    '-  ]',
    '+  ],',
    '+  "ext": {',
    '+    "mnstry.atelier.obsidian": {',
    '+      "schema": "atelier-obsidian-ext-settings/v1",',
    '+      "enabled": true,',
    '+      "defaultScopeId": "everything",',
    '+      "scopes": [',
    '+        {',
    '+          "scopeId": "everything",',
    '+          "mode": "full",',
    '+          "selector": {',
    '+            "all": true',
    '+          }',
    '+        }',
    '+      ]',
    '+    }',
    '+  }',
    ' }',
    '',
  ].join('\n'))
  if (POSIX) fs.chmodSync(world.configPath, 0o640)
  const mode = fs.statSync(world.configPath).mode & 0o777
  assert.deepEqual(writeViewPlan(planViewAdd(project, { scope: DEFAULT_VIEW })).written, [world.configPath])
  assert.equal(world.text(), `${JSON.stringify({ ...JSON.parse(before), ext: { [EXT]: plan.settings } }, null, 2)}\n`)
  assert.equal(fs.statSync(world.configPath).mode & 0o777, mode, 'the file keeps its mode')
  assert.deepEqual(fs.readdirSync(world.projectDir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left')

  // A second view keeps the first and the default, and is the default only when asked.
  const later = world.loadProject()
  const north = viewFromRequest({ scopeId: 'north', folders: ['notes'], repositories: ['harbor'] })
  assert.equal(planViewAdd(later, { scope: north }).settings.defaultScopeId, 'everything')
  assert.equal(planViewAdd(later, { scope: north, makeDefault: true }).settings.defaultScopeId, 'north')
  assert.throws(() => planViewAdd(later, { scope: DEFAULT_VIEW }), (error) => error.code === 'view-exists' && error.detail.scopeId === 'everything')
  writeViewPlan(planViewAdd(later, { scope: north }))
  assert.deepEqual(world.loadProject().config.ext[EXT].scopes.map((scope) => scope.scopeId), ['everything', 'north'])
})

test('a project file in another form is never rewritten: its view is named for the person to add by hand', (t) => {
  const world = makeWorld(t)
  const document = JSON.parse(world.text())
  for (const [label, text] of [
    ['four spaces', `${JSON.stringify(document, null, 4)}\n`],
    ['one line', `${JSON.stringify(document)}\n`],
    ['tabs', `${JSON.stringify(document, null, '\t')}\n`],
    ['a space before a colon', `${JSON.stringify(document, null, 2).replace('"name":', '"name" :')}\n`],
    ['two final newlines', `${JSON.stringify(document, null, 2)}\n\n`],
  ]) {
    fs.writeFileSync(world.configPath, text)
    assert.throws(() => planViewAdd(world.loadProject(), { scope: DEFAULT_VIEW }), (error) => error.code === 'project-config-format-unknown' && error.detail.member[EXT].scopes[0].scopeId === 'everything', label)
    assert.equal(world.text(), text, `${label}: unchanged`)
  }
  // The forms Atelier writes itself, with either line end and with or without a final one, stay the form they are in.
  const inForm = (value, eol, final) => `${JSON.stringify(value, null, 2).replaceAll('\n', eol)}${final ? eol : ''}`
  const enabled = { ...document, ext: { [EXT]: { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, defaultScopeId: 'everything', scopes: [DEFAULT_VIEW] } } }
  for (const [label, eol, final] of [['CRLF', '\r\n', true], ['no final newline', '\n', false], ['CRLF, no final newline', '\r\n', false]]) {
    fs.writeFileSync(world.configPath, inForm(document, eol, final))
    writeViewPlan(planViewAdd(world.loadProject(), { scope: DEFAULT_VIEW }))
    assert.equal(world.text(), inForm(enabled, eol, final), label)
  }
})

test('the change is written only over the bytes it was made from, and only when every file it changes still holds them', (t) => {
  const world = makeWorld(t, { git: true })
  const project = world.loadProject()
  assert.equal(project.localState.ignored, false)
  const plan = planViewAdd(project, { scope: DEFAULT_VIEW })
  fs.writeFileSync(world.configPath, world.text().replace('"harbor-notes"', '"harbor-notes-renamed"'))
  const changed = world.text()
  assert.throws(() => writeViewPlan(plan), (error) => error.code === 'project-config-changed')
  assert.equal(world.text(), changed)
  assert.equal(fs.existsSync(path.join(world.projectDir, '.gitignore')), false, 'the ignore line is not written either')
  // A .gitignore that appears after the plan is a change too.
  const again = planViewAdd(world.loadProject(), { scope: DEFAULT_VIEW })
  fs.writeFileSync(path.join(world.projectDir, '.gitignore'), 'node_modules/\n')
  assert.throws(() => writeViewPlan(again), (error) => error.code === 'project-config-changed' && error.detail.file === '.gitignore')
  assert.equal(world.text(), changed)
  if (POSIX) {
    const linked = makeWorld(t)
    const elsewhere = path.join(linked.dir, 'elsewhere.json')
    fs.renameSync(linked.configPath, elsewhere)
    fs.symlinkSync(elsewhere, linked.configPath)
    assert.throws(() => planViewAdd(linked.loadProject(), { scope: DEFAULT_VIEW }), (error) => error.code === 'project-file-not-regular')
  }
})

test('a project where `.atelier-local/` is not ignored gets the ignore line in the same change, and then is ignored', (t) => {
  for (const [label, existing, expected] of [
    ['no .gitignore', null, '.atelier-local/\n'],
    ['one without a final newline', 'node_modules/', 'node_modules/\n.atelier-local/\n'],
    ['one with CRLF', 'node_modules/\r\n', 'node_modules/\r\n.atelier-local/\r\n'],
  ]) {
    const world = makeWorld(t, { git: true })
    if (existing !== null) fs.writeFileSync(path.join(world.projectDir, '.gitignore'), existing)
    const plan = planViewAdd(world.loadProject(), { scope: DEFAULT_VIEW })
    assert.equal(plan.ignore.needed, true, label)
    assert.match(plan.diff, /^--- \.gitignore\n\+\+\+ \.gitignore\n@@ [^\n]+ @@\n(?: [^\n]*\n)*\+\.atelier-local\/\n$/m, `${label}: the ignore line is in the diff`)
    assert.deepEqual(writeViewPlan(plan).written, [path.join(world.projectDir, '.gitignore'), world.configPath], `${label}: the ignore line first`)
    assert.equal(world.gitignore(), expected, label)
    assert.equal(world.loadProject().localState.ignored, true, `${label}: git ignores the folder now`)
    assert.equal(planViewAdd(world.loadProject(), { scope: { ...DEFAULT_VIEW, scopeId: 'second' } }).ignore.needed, false, `${label}: and says so after`)
  }
})

test('a file that is not UTF-8 is never rewritten: a byte the diff would not show is never replaced', (t) => {
  // A .gitignore with a Latin-1 comment (0xE9 is "é" there, and no UTF-8).
  const world = makeWorld(t, { git: true })
  const latin1 = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\nnode_modules/\n')])
  fs.writeFileSync(path.join(world.projectDir, '.gitignore'), latin1)
  assert.throws(() => planViewAdd(world.loadProject(), { scope: DEFAULT_VIEW }), (error) => error.code === 'gitignore-not-utf8' && error.detail.line === '.atelier-local/')
  assert.ok(fs.readFileSync(path.join(world.projectDir, '.gitignore')).equals(latin1), 'unchanged, byte for byte')
  // A project file with a byte that is not UTF-8 inside a string: in no form Atelier writes, and the member is named.
  const other = makeWorld(t)
  const bytes = Buffer.from(other.text().replace('"harbor-notes"', '"harbor-notes-X"'), 'utf8')
  const at = bytes.indexOf(Buffer.from('-X"')) + 1
  bytes[at] = 0xff
  fs.writeFileSync(other.configPath, bytes)
  assert.throws(() => planViewAdd(other.loadProject(), { scope: DEFAULT_VIEW }), (error) => error.code === 'project-config-format-unknown' && error.detail.member[EXT].scopes[0].scopeId === 'everything')
  assert.ok(fs.readFileSync(other.configPath).equals(bytes), 'unchanged, byte for byte')
})

test('a change is written whole or says what changed: every new text is on the disk before any file is replaced, and no temporary file is left', (t) => {
  const leftovers = (world) => fs.readdirSync(world.projectDir).filter((name) => name.endsWith('.atelier.tmp'))
  const failing = (name) => (from, to) => { if (path.basename(to) === name) throw Object.assign(new Error('refused'), { code: 'EACCES' }); fs.renameSync(from, to) }
  // The project file cannot be replaced after .gitignore was: typed, naming both.
  const partly = makeWorld(t, { git: true })
  const before = partly.text()
  assert.throws(() => writeViewPlan(planViewAdd(partly.loadProject(), { scope: DEFAULT_VIEW }), { rename: failing('atelier.project.json') }),
    (error) => error.code === 'project-files-partly-written' && JSON.stringify([error.detail.written, error.detail.notWritten, error.detail.cause]) === JSON.stringify([['.gitignore'], ['atelier.project.json'], 'EACCES']))
  assert.equal(partly.text(), before)
  assert.equal(partly.gitignore(), '.atelier-local/\n')
  assert.deepEqual(leftovers(partly), [])
  // The first file cannot be replaced: nothing changed, and it says so.
  const none = makeWorld(t, { git: true })
  assert.throws(() => writeViewPlan(planViewAdd(none.loadProject(), { scope: DEFAULT_VIEW }), { rename: failing('.gitignore') }), (error) => error.code === 'project-files-not-written' && error.detail.cause === 'EACCES')
  assert.equal(fs.existsSync(path.join(none.projectDir, '.gitignore')), false)
  assert.equal(none.text(), before)
  assert.deepEqual(leftovers(none), [])
  // A temporary file a crashed run left beside a planned file is removed by the next write.
  const crashed = makeWorld(t)
  const stale = path.join(crashed.projectDir, '.atelier.project.json.99999999.1.atelier.tmp')
  fs.writeFileSync(stale, 'half')
  writeViewPlan(planViewAdd(crashed.loadProject(), { scope: DEFAULT_VIEW }))
  assert.deepEqual(leftovers(crashed), [])
})

test('a diff is one hunk with three lines of context', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', ''].join('\n')
  const after = ['a', 'b', 'c', 'd', 'X', 'Y', 'f', 'g', ''].join('\n')
  assert.equal(unifiedDiff(before, after, { label: 'f.txt' }), ['--- f.txt', '+++ f.txt', '@@ -2,6 +2,7 @@', ' b', ' c', ' d', '-e', '+X', '+Y', ' f', ' g', ''].join('\n'))
  assert.equal(unifiedDiff('', 'x\n', { label: 'new' }), ['--- new', '+++ new', '@@ -0,0 +1,1 @@', '+x', ''].join('\n'), 'a new file')
  assert.equal(unifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n', { label: 'crlf' }), ['--- crlf', '+++ crlf', '@@ -1,2 +1,2 @@', ' a', '-b', '+c', ''].join('\n'), 'line ends are not part of a line')
  assert.equal(unifiedDiff('same\n', 'same\n', { label: 'same' }), '')
})

test('a question at a terminal takes the line typed, and never waits forever', { timeout: 20000 }, async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const shown = []
  output.on('data', (chunk) => shown.push(String(chunk)))
  const questioner = createQuestioner({ input, output, timeoutMs: 200 })
  input.write('  first answer  \nsecond\n')
  assert.equal(await questioner.ask('One? '), 'first answer', 'typed before it was asked, and trimmed')
  assert.equal(await questioner.ask('Two? '), 'second')
  const started = Date.now()
  assert.equal(await questioner.ask('Three? '), null, 'no line within the timeout is no answer')
  assert.equal(Date.now() - started >= 150, true)
  const later = questioner.ask('Four? ')
  input.write('fourth\n')
  assert.equal(await later, 'fourth')
  input.end()
  assert.equal(await questioner.ask('Five? '), null, 'the end of the input is no answer')
  questioner.close()
  assert.equal(shown.join(''), 'One? Two? Three? \nFour? Five? ')

  const goAhead = async (...lines) => {
    const typed = new PassThrough()
    typed.end(lines.map((line) => `${line}\n`).join(''))
    const asker = createQuestioner({ input: typed, output: new PassThrough(), timeoutMs: 200 })
    try { return await askGoAhead(asker, 'Go ahead? [Y/n] ') } finally { asker.close() }
  }
  assert.equal(await goAhead(''), true, 'Enter is yes')
  assert.equal(await goAhead('Y'), true)
  assert.equal(await goAhead('yes'), true)
  assert.equal(await goAhead('n'), false)
  assert.equal(await goAhead('No'), false)
  assert.equal(await goAhead('maybe', 'y'), true, 'another answer is asked again')
  assert.equal(await goAhead('maybe', 'later', 'perhaps'), null, 'three times in all')
  assert.equal(await goAhead(), null)
})

test('a view\'s counts are the notes it would show here, and why the others it names are withheld', (t) => {
  const world = makeWorld(t)
  const project = world.loadProject()
  const counts = (scope, audienceAllow = ONLY_YOU_AUDIENCES) => viewCounts({ project, audienceAllow, scope })
  assert.deepEqual(counts(DEFAULT_VIEW), { corpus: 7, named: 7, shown: 4, withheld: { unclassified: 2, audience: 1 }, truncated: false }, 'only you: every audience but sensitive')
  assert.deepEqual(counts(DEFAULT_VIEW, ['team']).withheld, { unclassified: 2, audience: 2 })
  assert.deepEqual(counts(DEFAULT_VIEW, []), { corpus: 7, named: 7, shown: 0, withheld: { unclassified: 2, audience: 5 }, truncated: false }, 'no audience admitted: nothing to show')
  const repositories = ['harbor']
  assert.deepEqual(counts(viewFromRequest({ scopeId: 'drafts', folders: ['drafts'], repositories })), { corpus: 7, named: 2, shown: 0, withheld: { unclassified: 2, audience: 0 }, truncated: false })
  assert.equal(counts(viewFromRequest({ scopeId: 'ghosts', folders: ['nowhere'], repositories })).named, 0)
  assert.equal(counts(viewFromRequest({ scopeId: 'north', folders: ['notes'], repositories })).shown, 3)
  assert.equal(counts(viewFromRequest({ scopeId: 'north', folders: ['notes'], expand: '1:10', repositories })).shown, 4, 'with the notes they link to')
  assert.equal(counts(viewFromRequest({ scopeId: 'north', folders: ['notes'], expand: '1:3', repositories })).truncated, true)
  assert.equal(counts(viewFromRequest({ scopeId: 'beacons', tag: 'lighthouse', repositories })).shown, 1)
  // A vault that is only yours shows the notes without a classification that read as notes, as the engine would.
  const mine = (scope) => viewCounts({ project, audienceAllow: ONLY_YOU_AUDIENCES, scope, eligibility: onlyYouEligibility({ project }) })
  assert.deepEqual(mine(DEFAULT_VIEW), { corpus: 7, named: 7, shown: 6, withheld: { unclassified: 0, audience: 1 }, truncated: false })
  assert.equal(mine(viewFromRequest({ scopeId: 'drafts', folders: ['drafts'], repositories })).shown, 2)
})

test('an agent adds a view with one command, which is its consent: the change is made and shown, and nothing is asked', async (t) => {
  const world = makeWorld(t)
  const before = world.text()
  const result = await world.run(['view', 'add', 'north', '--folder', 'notes', '--folder', 'logs', '--json'])
  assert.equal(result.exit, EXIT.ok, result.stdout)
  const expected = { scopeId: 'north', mode: 'scoped', selector: { union: [{ repo: 'harbor', pathPrefix: 'notes' }, { repo: 'harbor', pathPrefix: 'logs' }] } }
  assert.deepEqual(result.json.scope, expected)
  assert.equal(result.json.defaultScopeId, 'north', 'the first view is the default')
  assert.deepEqual(result.json.written, ['atelier.project.json'])
  // The change is the member and the comma before it, computed here from the documented form.
  const changed = (prefix) => result.json.diff.split('\n').filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).map((line) => line.slice(1))
  assert.deepEqual(changed('-'), ['  ]'])
  assert.deepEqual(changed('+'), ['  ],', ...JSON.stringify({ ext: { [EXT]: { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, defaultScopeId: 'north', scopes: [expected] } } }, null, 2).split('\n').slice(1, -1)])
  assert.equal(world.text(), `${JSON.stringify({ ...JSON.parse(before), ext: { [EXT]: { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, defaultScopeId: 'north', scopes: [expected] } } }, null, 2)}\n`)
  assert.deepEqual(result.json.counts, { corpus: 7, named: 5, shown: 4, withheld: { unclassified: 0, audience: 1 }, truncated: false })
  assert.deepEqual(result.json.audience, { allow: ONLY_YOU_AUDIENCES, decided: false })
  assert.deepEqual(world.loadProject().config.ext[EXT], { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, defaultScopeId: 'north', scopes: [expected] })
  assert.equal(result.asked, '', 'nothing was asked')

  const human = await world.run(['view', 'add', 'beacons', '--tag', 'lighthouse'])
  assert.equal(human.exit, EXIT.ok, human.stderr)
  assert.match(human.stdout, /^Atelier will add the view "beacons" to atelier\.project\.json \(you commit it\):$/m)
  assert.match(human.stdout, /^ {2}\+ {10}"scopeId": "beacons",$/m, 'the diff is shown')
  assert.match(human.stdout, /^view beacons would show 1 note\(s\) \(who may see: only you, until you decide\)$/m)
  assert.match(human.stdout, /^Added the view beacons\. Commit atelier\.project\.json when you are ready; Atelier commits nothing\.$/m)
  assert.match(human.stdout, /^Next: `atelier obsidian open --scope beacons` shows it in Obsidian$/m)
  assert.deepEqual((await world.run(['view', 'list', '--json'])).json.scopes.map((scope) => scope.scopeId), ['north', 'beacons'], '`view list` is `scope list`')

  // Counted for the audiences this machine admits, once someone decided them.
  world.decideAudience(['team'], 'custom')
  const decided = await world.run(['view', 'add', 'logs', '--folder', 'logs', '--allow-empty', '--json'])
  assert.deepEqual([decided.json.counts.shown, decided.json.counts.withheld, decided.json.audience], [0, { unclassified: 0, audience: 2 }, { allow: ['team'], decided: true }])
})

test('a person at a terminal sees the change and what the view would show, and is asked before anything is written', async (t) => {
  const world = makeWorld(t, { git: true })
  const before = world.text()
  const declined = await world.run(['view', 'add', 'everything', '--all'], { person: true, answers: ['n\n'] })
  assert.equal(declined.exit, EXIT.notSuccess)
  assert.equal(world.text(), before, 'declined: nothing was written')
  assert.equal(fs.existsSync(path.join(world.projectDir, '.gitignore')), false)
  assert.equal(declined.asked, 'Write this change? [Y/n] ')
  assert.match(declined.stdout, /^Atelier will add the view "everything" to atelier\.project\.json, and \.atelier-local\/ to \.gitignore \(you commit it\):$/m)
  assert.match(declined.stdout, /^ {2}\+\.atelier-local\/$/m)
  assert.match(declined.stdout, /^view everything would show 6 note\(s\) \(who may see: only you, until you decide\); of the 7 note\(s\) it names, 1 an audience not admitted$/m, 'counted as "only you" shows them: with the notes without a classification')
  assert.match(declined.stderr, /^Nothing was written\.$/m, 'an answer that is not success is told on stderr')

  const unanswered = await world.run(['view', 'add', 'everything', '--all'], { person: true, answers: [] })
  assert.equal(unanswered.exit, EXIT.refused)
  assert.match(unanswered.stderr, /^\[unanswered\] no answer came; nothing was written$/m)
  assert.equal(world.text(), before)

  const accepted = await world.run(['view', 'add', 'everything', '--all'], { person: true, answers: ['\n'] })
  assert.equal(accepted.exit, EXIT.ok, accepted.stderr)
  assert.equal(world.gitignore(), '.atelier-local/\n')
  assert.equal(world.loadProject().config.ext[EXT].defaultScopeId, 'everything')
  assert.match(accepted.stdout, /^Added the view everything, the default\. Commit \.gitignore and atelier\.project\.json when you are ready; Atelier commits nothing\.$/m)
  assert.match(accepted.stdout, /^Next: `atelier obsidian open` shows it in Obsidian$/m)
  assert.equal(accepted.stdout.match(/^Atelier will add/gm).length, 1, 'the change is shown once, before the question')

  const answeredBefore = await world.run(['view', 'add', 'north', '--folder', 'notes', '--yes'], { person: true, answers: [] })
  assert.equal(answeredBefore.exit, EXIT.ok, answeredBefore.stderr)
  assert.equal(answeredBefore.asked, '', '--yes answers beforehand')
})

test('`view add` refuses, and writes nothing, for a view that would be empty, a name taken, or a file it cannot rewrite', async (t) => {
  const world = makeWorld(t, { ext: settingsOf([{ scopeId: 'north', mode: 'scoped', selector: { repo: 'harbor', pathPrefix: 'notes' } }]) })
  // A list of audiences: the notes without a classification are withheld, so a folder of them would show nothing.
  world.decideAudience(['team'], 'custom')
  const before = world.text()
  const cases = [
    [['view', 'add', 'drafts', '--folder', 'drafts'], 'view-would-be-empty', (detail) => detail.counts.named === 2 && detail.counts.withheld.unclassified === 2],
    [['view', 'add', 'ghosts', '--folder', 'nowhere'], 'view-would-be-empty', (detail) => detail.counts.named === 0],
    [['view', 'add', 'north', '--all'], 'view-exists', (detail) => detail.scopeId === 'north'],
    [['view', 'add', 'x', '--all', '--tag', 'y'], 'usage', () => true],
    [['view', 'add', 'x', '--folder', '../elsewhere'], 'invalid-view', () => true],
    [['view', 'add'], 'usage', () => true],
    [['view', 'remove', 'north'], 'usage', () => true],
  ]
  for (const [argv, code, detailHolds] of cases) {
    const result = await world.run([...argv, '--json'])
    assert.equal(result.exit, EXIT.refused, `${argv.join(' ')}: ${result.stdout}`)
    assert.equal(result.json.error.code, code, argv.join(' '))
    assert.equal(detailHolds(result.json.error.detail), true, argv.join(' '))
    assert.equal(world.text(), before, `${argv.join(' ')}: nothing was written`)
  }
  const empty = await world.run(['view', 'add', 'drafts', '--folder', 'drafts'])
  assert.match(empty.stderr, /^\[view-would-be-empty\] view drafts would show no note \(who may see: team\); of the 2 note\(s\) it names, 2 carry no classification; nothing was written$/m)
  const declared = await world.run(['view', 'add', 'drafts', '--folder', 'drafts', '--allow-empty', '--json'])
  assert.equal(declared.exit, EXIT.ok, '--allow-empty declares it anyway')
  assert.equal(world.loadProject().config.ext[EXT].defaultScopeId, undefined, 'a later view is not the default unless asked')

  fs.writeFileSync(world.configPath, `${JSON.stringify(JSON.parse(world.text()), null, 4)}\n`)
  const handWritten = world.text()
  const refused = await world.run(['view', 'add', 'beacons', '--tag', 'lighthouse', '--json'])
  assert.equal(refused.json.error.code, 'project-config-format-unknown')
  assert.deepEqual(refused.json.error.detail.member[EXT].scopes.map((scope) => scope.scopeId), ['north', 'drafts', 'beacons'], 'the member to add by hand, whole')
  assert.equal(world.text(), handWritten)

  // Notes the graph cannot be built from are named before anything is written.
  const broken = makeWorld(t)
  fs.writeFileSync(path.join(broken.projectDir, 'harbor', 'logs', 'copy.md'), note({ id: 'harbor:lantern', title: 'Another lantern' }))
  const unbuilt = broken.text()
  const graphRefusal = await broken.run(['view', 'add', 'everything', '--all', '--json'])
  assert.equal(graphRefusal.json.error.code, 'canonical-graph-invalid', graphRefusal.stdout)
  assert.match(graphRefusal.json.error.next, /atelier graph --check/)
  assert.equal(broken.text(), unbuilt)
})

test('a view added to a project that turned the projection off stays off, and says so', async (t) => {
  const world = makeWorld(t, { ext: settingsOf([], { enabled: false }) })
  const result = await world.run(['view', 'add', 'everything', '--all'])
  assert.equal(result.exit, EXIT.ok, result.stderr)
  assert.match(result.stdout, /^The projection is turned off in this project \("enabled": false\), so nothing is published until it is turned on\.$/m)
  assert.deepEqual(world.loadProject().config.ext[EXT], { schema: 'atelier-obsidian-ext-settings/v1', enabled: false, scopes: [DEFAULT_VIEW], defaultScopeId: 'everything' }, 'the first view is the default; the member keeps its own order')
})
