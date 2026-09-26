import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildCommandHelpText, buildHelpText } from '../src/cli/run.mjs'
import { censusScopeFilter, validateSourceSidecar } from '../src/graph/knowledge-graph.mjs'
import { validateProjectConfigDoc } from '../src/project/config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(root, 'bin/atelier.mjs')

// Git in a child process must see only the throwaway repository, never a
// GIT_DIR or GIT_INDEX_FILE inherited from a hook running this suite.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  delete env.ATELIER_DEBUG
  return env
}

function run(cwd, args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: cleanEnv({ MNSTRY_ATELIER_ACTOR: 'ada', ...extra }) })
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
  })
}

// An invented repository with the given files, all committed.
function repository(t, name, files) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-enroll-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const dir = path.join(parent, name)
  fs.mkdirSync(dir)
  git(dir, ['init', '-q'])
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'initial content'])
  return dir
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel))
const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'))
const digest = (dir, rel) => createHash('sha256').update(read(dir, rel)).digest('hex')

function adopt(dir, name, extra = []) {
  const adopted = run(dir, ['adopt', '--profile', 'single-repo', '--actor', 'ada', '--name', name, '--yes', ...extra])
  assert.equal(adopted.status, 0, adopted.stderr)
  return adopted
}

function assertGraphPasses(dir) {
  const built = run(dir, ['graph'])
  assert.equal(built.status, 0, built.stderr)
  const checked = run(dir, ['graph', '--check'])
  assert.equal(checked.status, 0, checked.stderr)
  return built
}

const PDF = '%PDF-1.4\n% invented attachment\n'

test('a vault with a PDF attachment: adopt, enroll, then graph --check exits 0', (t) => {
  const dir = repository(t, 'field-notes', {
    '.obsidian/app.json': '{}\n',
    'Daily/2026-09-01.md': '# Morning pages\n\nSee ![[scan.pdf]] for the sketch.\n',
    'Ideas/Loom.md': '---\ntitle: Loom\n---\n\nA note about looms.\n',
    'attachments/scan.pdf': PDF,
  })
  adopt(dir, 'field-notes')

  const refused = run(dir, ['graph'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /field-notes\/attachments\/scan\.pdf: non-Markdown source requires sidecar attachments\/scan\.pdf\.kg\.json/)
  assert.match(refused.stderr, /^Next: run atelier enroll documents with the same --project path/m)

  const sourceDigest = digest(dir, 'attachments/scan.pdf')
  const enrolled = run(dir, ['enroll', 'documents'])
  assert.equal(enrolled.status, 0, enrolled.stderr)
  assert.match(enrolled.stdout, /^Enrolled 1 document with private sidecars:\n {2}field-notes\/attachments\/scan\.pdf\.kg\.json$/m)
  assert.doesNotMatch(enrolled.stdout, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  assert.deepEqual(readJson(dir, 'attachments/scan.pdf.kg.json'), {
    schema: 'mnstry.source-sidecar@v1',
    asset: 'scan.pdf',
    title: 'Scan',
    summary: '',
    tags: [],
    kg: {
      id: 'field-notes:asset:attachments/scan.pdf',
      type: 'pdf',
      domain: 'workstream',
      lifecycle: 'root',
      status: 'active',
      audience: 'private',
      relations: {},
    },
  })
  assert.equal(digest(dir, 'attachments/scan.pdf'), sourceDigest, 'the source is never changed')

  const built = assertGraphPasses(dir)
  assert.match(built.stdout, /knowledge graph: 3 nodes/)

  // Enrolling again finds nothing to do and changes nothing.
  const sidecar = read(dir, 'attachments/scan.pdf.kg.json')
  const again = run(dir, ['enroll', 'documents'])
  assert.equal(again.status, 0, again.stderr)
  assert.equal(again.stdout.trim(), 'No document needs a sidecar.')
  assert.deepEqual(read(dir, 'attachments/scan.pdf.kg.json'), sidecar)

  // The enrolled sidecar passes the boundary policy adoption wrote.
  const boundary = run(dir, ['boundary', 'check'])
  assert.equal(boundary.status, 0, boundary.stderr + boundary.stdout)
})

test('a static site: adopt --enroll-documents in one step, then graph --check exits 0', (t) => {
  const dir = repository(t, 'harbor-site', {
    'index.html': '<!doctype html><html><head><title>Harbor Lantern Co.</title></head><body>Home</body></html>\n',
    'about/index.html': '<html><head><title>About the harbor</title></head></html>\n',
    'Contact Us.html': '<html><body>Write to us</body></html>\n',
    'contact-us.html': '<html><body>Old contact page</body></html>\n',
    'press/kit.pdf': PDF,
    'assets/site.css': 'body { margin: 0 }\n',
    'assets/logo.png': 'not really a png\n',
  })
  const adopted = adopt(dir, 'harbor-site', ['--enroll-documents'])
  const report = JSON.parse(adopted.stdout)
  assert.equal(report.enrollment.audience, 'private')
  assert.deepEqual(report.enrollment.enrolled.map((item) => item.sidecar), [
    'Contact Us.html.kg.json',
    'about/index.html.kg.json',
    'contact-us.html.kg.json',
    'index.html.kg.json',
    'press/kit.pdf.kg.json',
  ])
  assert.deepEqual(report.enrollment.skipped, [])

  // An HTML page keeps the title the graph reads from it.
  assert.equal(readJson(dir, 'index.html.kg.json').title, 'Harbor Lantern Co.')
  assert.equal(readJson(dir, 'index.html.kg.json').kg.id, 'harbor-site:asset:index.html')
  // Two pages whose paths fold to one id each get a digest of their exact path.
  const folded = ['Contact Us.html.kg.json', 'contact-us.html.kg.json'].map((rel) => readJson(dir, rel).kg.id)
  for (const id of folded) assert.match(id, /^harbor-site:asset:contact-us\.html-[0-9a-f]{8}$/)
  assert.notEqual(folded[0], folded[1])
  // Assets that are not documents are left alone.
  assert.equal(fs.existsSync(path.join(dir, 'assets/logo.png.kg.json')), false)
  assert.equal(fs.existsSync(path.join(dir, 'assets/site.css.kg.json')), false)

  const built = assertGraphPasses(dir)
  assert.match(built.stdout, /knowledge graph: 5 nodes/)
})

test('a documents folder: dry run writes nothing, enroll keeps existing sidecars, graph --check exits 0', (t) => {
  const handWritten = `${JSON.stringify({
    schema: 'mnstry.source-sidecar@v1',
    asset: 'q1.pdf',
    title: 'First quarter review',
    summary: 'Written by hand.',
    tags: ['review'],
    kg: { id: 'paperwork:q1-review', type: 'report', domain: 'finance', lifecycle: 'reference', status: 'active', audience: 'team', relations: {} },
  }, null, 2)}\n`
  const dir = repository(t, 'paperwork', {
    'contracts/Studio Lease 2026.docx': 'PK invented docx bytes\n',
    'reports/q1.pdf': PDF,
    'reports/q1.pdf.kg.json': handWritten,
    'reports/summary.html': '<html><head><meta name="atelier:title" content="Summary sheet"></head></html>\n',
    'README.md': '# Paperwork\n',
  })
  adopt(dir, 'paperwork')

  const status = () => git(dir, ['status', '--porcelain', '--untracked-files=all'])
  const before = status()
  const dry = run(dir, ['enroll', 'documents', '--dry-run'])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /^Would enroll 2 documents with private sidecars:$/m)
  assert.match(dry.stdout, /paperwork\/contracts\/Studio Lease 2026\.docx\.kg\.json/)
  assert.match(dry.stdout, /paperwork\/reports\/summary\.html\.kg\.json/)
  assert.equal(status(), before, 'a dry run writes nothing')

  const enrolled = run(dir, ['enroll', 'documents', '--json'])
  assert.equal(enrolled.status, 0, enrolled.stderr)
  const report = JSON.parse(enrolled.stdout)
  assert.deepEqual(report.enrolled.map((item) => [item.sidecar, item.id]), [
    ['contracts/Studio Lease 2026.docx.kg.json', 'paperwork:asset:contracts/studio-lease-2026.docx'],
    ['reports/summary.html.kg.json', 'paperwork:asset:reports/summary.html'],
  ])
  assert.equal(fs.readFileSync(path.join(dir, 'reports/q1.pdf.kg.json'), 'utf8'), handWritten, 'an existing sidecar is never changed')
  assert.equal(readJson(dir, 'reports/summary.html.kg.json').title, 'Summary sheet')
  assert.equal(readJson(dir, 'contracts/Studio Lease 2026.docx.kg.json').kg.type, 'docx')

  assertGraphPasses(dir)
})

test('enroll never replaces a sidecar Git ignores and never follows a link at the sidecar path', (t) => {
  const dir = repository(t, 'archive-box', {
    '.gitignore': 'drafts/*.kg.json\n',
    'drafts/outline.pdf': PDF,
    'linked/brief.pdf': PDF,
    'plain/letter.pdf': PDF,
  })
  adopt(dir, 'archive-box')
  const ignored = '{"machine-local": true}\n'
  fs.writeFileSync(path.join(dir, 'drafts/outline.pdf.kg.json'), ignored)
  const outside = path.join(path.dirname(dir), 'outside-target.json')
  fs.symlinkSync(outside, path.join(dir, 'linked/brief.pdf.kg.json'))

  const enrolled = run(dir, ['enroll', 'documents', '--json'])
  assert.equal(enrolled.status, 0, enrolled.stderr)
  const report = JSON.parse(enrolled.stdout)
  assert.deepEqual(report.enrolled.map((item) => item.sidecar), ['plain/letter.pdf.kg.json'])
  assert.deepEqual(report.skipped, [
    { repo: 'archive-box', path: 'drafts/outline.pdf', sidecar: 'drafts/outline.pdf.kg.json', reason: 'sidecar-ignored' },
    { repo: 'archive-box', path: 'linked/brief.pdf', sidecar: 'linked/brief.pdf.kg.json', reason: 'sidecar-not-a-file' },
  ])
  assert.equal(fs.readFileSync(path.join(dir, 'drafts/outline.pdf.kg.json'), 'utf8'), ignored)
  assert.equal(fs.existsSync(outside), false, 'the link target is never created')

  const text = run(dir, ['enroll', 'documents'])
  assert.match(text.stdout, /^Left 2 unchanged; the graph still needs a sidecar for each:$/m)
  assert.match(text.stdout, /archive-box\/drafts\/outline\.pdf: a sidecar exists but Git ignores it/)
})

test('enroll refuses an audience the boundary policy forbids before writing anything', (t) => {
  const dir = repository(t, 'guild-shared', { 'handbook.pdf': PDF })

  const refusedAdopt = run(dir, ['adopt', '--profile', 'shared-project', '--actor', 'ada', '--name', 'guild-shared', '--enroll-documents', '--yes'])
  assert.equal(refusedAdopt.status, 1)
  assert.match(refusedAdopt.stderr, /does not allow audience private in shared repository guild-shared; it allows staff, operator, team, public/)
  assert.equal(fs.existsSync(path.join(dir, 'atelier.project.json')), false, 'adopt refuses before any scaffold write')

  assert.equal(run(dir, ['adopt', '--profile', 'shared-project', '--actor', 'ada', '--name', 'guild-shared', '--yes']).status, 0)
  const refused = run(dir, ['enroll', 'documents'])
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /^\[enroll-audience-not-allowed\] the boundary policy does not allow audience private in shared repository guild-shared; it allows staff, operator, team, public$/m)
  assert.match(refused.stderr, /^Next: Pass --audience with one of the audiences it allows\.$/m)
  assert.equal(fs.existsSync(path.join(dir, 'handbook.pdf.kg.json')), false)

  const enrolled = run(dir, ['enroll', 'documents', '--audience', 'team'])
  assert.equal(enrolled.status, 0, enrolled.stderr)
  assert.equal(readJson(dir, 'handbook.pdf.kg.json').kg.audience, 'team')
  assertGraphPasses(dir)
})

test('enroll refuses unknown subcommands, flags and audiences as usage', (t) => {
  const dir = repository(t, 'tiny', { 'one.pdf': PDF })
  adopt(dir, 'tiny')
  for (const args of [['enroll'], ['enroll', 'notes'], ['enroll', 'documents', '--audiance', 'team'], ['enroll', 'documents', 'extra']]) {
    const result = run(dir, args)
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.stderr, /^\[usage\] enroll has one subcommand, documents$/m)
  }
  const audience = run(dir, ['enroll', 'documents', '--audience=everyone'])
  assert.equal(audience.status, 2)
  assert.match(audience.stderr, /^\[enroll-audience-invalid\] --audience must be one of private, sensitive, staff, operator, team, public$/m)
  assert.equal(fs.existsSync(path.join(dir, 'one.pdf.kg.json')), false)
  assert.equal(run(dir, ['adopt', '--profile', 'single-repo', '--actor', 'ada', '--audience', 'team', '--yes']).status, 1)
})

test('enroll refuses, writing nothing and naming no path, when the census cannot run', (t) => {
  const dir = repository(t, 'broken-access', { 'one.pdf': PDF })
  adopt(dir, 'broken-access')
  const access = readJson(dir, 'repo-access.v1.json')
  access.defaultReadBoundary = 'everyone'
  fs.writeFileSync(path.join(dir, 'repo-access.v1.json'), `${JSON.stringify(access, null, 2)}\n`)
  const refused = run(dir, ['enroll', 'documents'])
  assert.equal(refused.status, 2)
  assert.ok(refused.stderr.startsWith('[enroll-census-unavailable] the knowledge graph census could not run, so no document was enrolled\n'), refused.stderr)
  assert.match(refused.stderr, /^Next: Run atelier graph with the same --project path to see why, fix that, then retry\.$/m)
  assert.equal(refused.stderr.includes(dir), false)
  assert.equal(fs.existsSync(path.join(dir, 'one.pdf.kg.json')), false)
})

test('setup.exclude keeps a committed build folder out of the census', (t) => {
  const dir = repository(t, 'lantern-docs', {
    'guide/start.md': '# Start here\n',
    'guide/printable.pdf': PDF,
    '_site/index.html': '<html><head><title>Built</title></head></html>\n',
    '_site/guide/start/index.html': '<html></html>\n',
    '_site/stale.pdf.kg.json': '{"kg": {"status": "active"}}\n',
  })
  adopt(dir, 'lantern-docs', ['--exclude', '_site'])
  assert.equal(readJson(dir, 'atelier.project.json').setup.exclude, '_site')

  const enrolled = run(dir, ['enroll', 'documents', '--json'])
  assert.equal(enrolled.status, 0, enrolled.stderr)
  assert.deepEqual(JSON.parse(enrolled.stdout).enrolled.map((item) => item.sidecar), ['guide/printable.pdf.kg.json'])
  assert.equal(fs.existsSync(path.join(dir, '_site/index.html.kg.json')), false)

  // The orphan sidecar inside the excluded folder is outside the census too.
  const built = assertGraphPasses(dir)
  assert.match(built.stdout, /knowledge graph: 2 nodes/)
  const graph = readJson(dir, 'atelier-output/knowledge.graph.json')
  assert.deepEqual(graph.nodes.map((node) => node.path).sort(), ['guide/printable.pdf', 'guide/start.md'])
})

test('setup.include scopes a monorepo to its documents folder', (t) => {
  const dir = repository(t, 'kiln-mono', {
    'README.md': '# Monorepo\n',
    'packages/app/page.html': '<html></html>\n',
    'packages/app/notes.md': '# App notes\n',
    'docs/guide.md': '# Guide\n',
    'docs/specs/format.pdf': PDF,
  })
  const adopted = run(dir, ['adopt', '--profile', 'monorepo', '--actor', 'ada', '--name', 'kiln-mono', '--include', 'docs/**', '--enroll-documents', '--yes'])
  assert.equal(adopted.status, 0, adopted.stderr)
  assert.deepEqual(JSON.parse(adopted.stdout).enrollment.enrolled.map((item) => item.sidecar), ['docs/specs/format.pdf.kg.json'])
  assert.equal(fs.existsSync(path.join(dir, 'packages/app/page.html.kg.json')), false)

  assertGraphPasses(dir)
  const graph = readJson(dir, 'atelier-output/knowledge.graph.json')
  assert.deepEqual(graph.nodes.map((node) => node.path).sort(), ['docs/guide.md', 'docs/specs/format.pdf'])
})

test('censusScopeFilter: exclude wins, include keeps folders that may lead to a match, sidecars follow their source', () => {
  assert.equal(censusScopeFilter({}), null)
  assert.equal(censusScopeFilter({ include: '  ', exclude: null }), null)

  const exclude = censusScopeFilter({ exclude: '_site' })
  assert.equal(exclude('_site', { directory: true }), true)
  assert.equal(exclude('_site/a/index.html'), true)
  assert.equal(exclude('docs/_site/index.html'), true, 'a slashless pattern matches at any depth')
  assert.equal(exclude('_sites/index.html'), false)
  assert.equal(exclude('guide.pdf.kg.json'), false)

  const nested = censusScopeFilter({ base: 'repos/site', exclude: 'repos/site/build/**' })
  assert.equal(nested('build', { directory: true }), true)
  assert.equal(nested('build/page.html'), true)
  assert.equal(nested('src/page.html'), false)
  assert.equal(censusScopeFilter({ base: 'repos/site', exclude: 'repos/site' })('index.html'), true, 'excluding a repository root excludes all of it')

  const include = censusScopeFilter({ include: 'docs/specs/**', exclude: 'docs/specs/old' })
  assert.equal(include('docs', { directory: true }), false)
  assert.equal(include('docs/specs', { directory: true }), false)
  assert.equal(include('docs/specs/format.pdf'), false)
  assert.equal(include('docs/specs/format.pdf.kg.json'), false, 'a sidecar shares its source scope')
  assert.equal(include('docs/specs/old/v1.pdf'), true, 'exclude wins over include')
  assert.equal(include('docs/guide.md'), true)
  assert.equal(include('packages', { directory: true }), true)
  assert.equal(include('README.md'), true)

  const globbed = censusScopeFilter({ include: 'docs/*/specs/*.pdf' })
  assert.equal(globbed('docs/v2', { directory: true }), false, 'a folder below the literal lead may hold a match')
  assert.equal(globbed('docs/v2/specs/a.pdf'), false)
  assert.equal(globbed('docs/v2/specs/a.html'), true)
  assert.equal(globbed('other', { directory: true }), true)

  const anywhere = censusScopeFilter({ include: '*.pdf' })
  assert.equal(anywhere('deep/folder', { directory: true }), false)
  assert.equal(anywhere('deep/folder/a.pdf'), false)
  assert.equal(anywhere('deep/folder/a.md'), true)

  const folder = censusScopeFilter({ include: './docs/', exclude: 'docs/build/' })
  assert.equal(folder('docs/a.md'), false, 'a trailing slash still names the folder')
  assert.equal(folder('docs/build/a.html'), true)
  assert.equal(folder('notes.md'), true)
})

test('a legacy-warning boundary policy only warns about placement, so enroll does not refuse', (t) => {
  const dir = repository(t, 'guild-legacy', { 'handbook.pdf': PDF })
  assert.equal(run(dir, ['adopt', '--profile', 'shared-project', '--actor', 'ada', '--name', 'guild-legacy', '--yes']).status, 0)
  const policy = readJson(dir, 'boundary-policy.v1.json')
  fs.writeFileSync(path.join(dir, 'boundary-policy.v1.json'), `${JSON.stringify({ ...policy, mode: 'legacy-warning' }, null, 2)}\n`)
  const enrolled = run(dir, ['enroll', 'documents'])
  assert.equal(enrolled.status, 0, enrolled.stderr)
  assert.equal(readJson(dir, 'handbook.pdf.kg.json').kg.audience, 'private')
})

test('setup.include and setup.exclude must be relative path patterns; adopt no longer writes null', (t) => {
  const base = { schema: 'mnstry.atelier-project-config@v1', repos: [{ name: 'x', path: '.' }] }
  assert.deepEqual(validateProjectConfigDoc({ ...base, setup: { include: null, exclude: null } }), [])
  assert.deepEqual(validateProjectConfigDoc({ ...base, setup: { include: 'docs/**', exclude: '_site' } }), [])
  assert.deepEqual(validateProjectConfigDoc({ ...base, setup: { exclude: '/abs/site' } }), ['setup.exclude must be a path pattern relative to the project config folder'])
  assert.deepEqual(validateProjectConfigDoc({ ...base, setup: { include: 'file:docs' } }), ['setup.include must be a path pattern relative to the project config folder'])
  assert.deepEqual(validateProjectConfigDoc({ ...base, setup: { include: 7 } }), ['setup.include must be a non-empty string path'])

  const dir = repository(t, 'plain', { 'a.md': '# A\n' })
  adopt(dir, 'plain')
  assert.deepEqual(readJson(dir, 'atelier.project.json').setup, { profile: 'single-repo' })
})

test('enrolled sidecars satisfy the source-sidecar validator and help names the command', () => {
  assert.match(buildHelpText(), /^ {2}enroll documents {16}Write private sidecars for documents missing one\.$/m)
  const help = buildCommandHelpText('enroll')
  assert.match(help, /^Usage: atelier enroll documents \[--audience private\] \[--dry-run\] \[--json\] \[--project \.\/atelier\.project\.json\]$/m)
  assert.match(buildCommandHelpText('adopt'), /--enroll-documents/)
  assert.deepEqual(
    validateSourceSidecar({
      schema: 'mnstry.source-sidecar@v1',
      asset: 'a.pdf',
      title: 'A',
      summary: '',
      tags: [],
      kg: { id: 'repo:asset:a.pdf', type: 'pdf', domain: 'workstream', lifecycle: 'root', status: 'active', audience: 'private', relations: {} },
    }, 'a.pdf'),
    [],
  )
})
