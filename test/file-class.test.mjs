import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  DISPOSABLE_STAGING,
  DISTRIBUTED_RUNTIME_COPY,
  EDITABLE_VAULT,
  FILE_CLASSES,
  GENERATED_PROJECTION,
  IGNORED_LOCAL,
  KIT_FILE_CLASSES,
  MANAGED_AREA_HANDLING,
  OBSIDIAN_LOCAL_POINTER,
  RECOVERY_RECORD,
  SOURCE,
  TRUSTED_STATE,
  UNKNOWN_MANAGED,
  checkManagedRoots,
  checkRepositoryEnrollment,
  classifyManagedPath,
  classifyPath,
  createPathClassifier,
  generatedProjectionBasenames,
  generatedProjectionDirectoryBasenames,
  validateFileClasses,
} from '../src/project/file-class.mjs'
import { matchesPathPattern } from '../src/project/path-match.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))

// The classification that burned client zero: the builder script is canonical in the ops
// repo and a rederivable copy in every consumer. A list keyed on filename alone
// cannot express that, and folding it into a plain "generated" list makes the sync
// loop discard canonical source in the repo that owns it.
const RUNTIME_COPY_CLASSES = [
  ...KIT_FILE_CLASSES,
  { pattern: 'scripts/build-atelier.mjs', class: DISTRIBUTED_RUNTIME_COPY, canonicalRepoRole: 'repo-ops' },
]

test('a distributed runtime copy is source in its canonical repo and a copy elsewhere', () => {
  const inOps = classifyPath('scripts/build-atelier.mjs', { repoRole: 'repo-ops', fileClasses: RUNTIME_COPY_CLASSES })
  assert.equal(inOps.class, SOURCE)
  assert.equal(inOps.canonicalHere, true)
  assert.equal(inOps.handling.discardable, false, 'a sync loop must never discard the canonical copy')
  assert.equal(inOps.handling.conflictsNeedHuman, true)

  const inConsumer = classifyPath('scripts/build-atelier.mjs', { repoRole: 'website', fileClasses: RUNTIME_COPY_CLASSES })
  assert.equal(inConsumer.class, DISTRIBUTED_RUNTIME_COPY)
  assert.equal(inConsumer.canonicalHere, false)
  assert.equal(inConsumer.handling.rederivable, true, 'self-repair must be allowed to rederive the consumer copy')
})

test('unclassified paths default to source', () => {
  const verdict = classifyPath('docs/notes.md', { repoRole: 'website' })
  assert.equal(verdict.class, SOURCE)
  assert.equal(verdict.declared, false)
  assert.equal(verdict.handling.discardable, false, 'an undeclared path must never be discardable')
})

test('generated projections are discardable in every repo role', () => {
  for (const repoRole of ['repo-ops', 'website', null]) {
    const classify = createPathClassifier({ repoRole })
    assert.equal(classify('atelier-output/index.html').class, GENERATED_PROJECTION)
    assert.equal(classify('some/nested/knowledge.graph.json').handling.discardable, true)
  }
})

test('later entries win, so an adopter can narrow a kit default', () => {
  const classes = [
    { pattern: 'atelier-output/**', class: GENERATED_PROJECTION },
    { pattern: 'atelier-output/AUTHORED.md', class: SOURCE },
  ]
  assert.equal(classifyPath('atelier-output/index.html', { fileClasses: classes }).class, GENERATED_PROJECTION)
  assert.equal(classifyPath('atelier-output/AUTHORED.md', { fileClasses: classes }).class, SOURCE)
})

test('a runtime copy must declare where it is canonical', () => {
  assert.match(
    validateFileClasses([{ pattern: 'scripts/x.mjs', class: DISTRIBUTED_RUNTIME_COPY }]).join('\n'),
    /canonicalRepoRole is required for distributed-runtime-copy/,
  )
  assert.deepEqual(validateFileClasses([{ pattern: 'scripts/x.mjs', class: DISTRIBUTED_RUNTIME_COPY, canonicalRepoRole: 'repo-ops' }]), [])
  assert.match(
    validateFileClasses([{ pattern: 'a.md', class: SOURCE, canonicalRepoRole: 'repo-ops' }]).join('\n'),
    /canonicalRepoRole is only meaningful/,
  )
  assert.match(validateFileClasses([{ pattern: 'a.md', class: 'made-up' }]).join('\n'), /class must be one of/)
  assert.match(
    validateFileClasses([{ pattern: 'a.md', class: SOURCE }, { pattern: 'a.md', class: GENERATED_PROJECTION }]).join('\n'),
    /duplicates an earlier entry/,
  )
  assert.deepEqual(validateFileClasses(KIT_FILE_CLASSES), [])
})

test('the kit keeps no second copy of the classification', () => {
  // The graph walker used to restate the generated filenames inline. Whatever it
  // skips must come from the declaration, or the two drift and a sync wedge follows.
  const walkerSource = fs.readFileSync(path.join(ROOT, 'src/graph/knowledge-graph.mjs'), 'utf8')
  const generatedFilesLine = walkerSource.match(/const GENERATED_FILES = .*/)[0]
  assert.match(generatedFilesLine, /generatedProjectionBasenames\(\)/)

  const derived = generatedProjectionBasenames()
  for (const name of ['atelier.manifest.json', 'atelier-ledger.html', 'atelier-shell.js', 'knowledge.graph.json']) {
    assert.ok(derived.has(name), `${name} must be reachable from the declaration, not a shadow list`)
  }
  assert.deepEqual([...generatedProjectionDirectoryBasenames()].sort(), ['atelier-output', 'atelier-readers'])

  // The glob dialect lives in one place too.
  const policySource = fs.readFileSync(path.join(ROOT, 'src/boundary/policy.mjs'), 'utf8')
  assert.doesNotMatch(policySource, /function patternMatches\(/, 'boundary policy must consume the shared matcher')
  assert.ok(matchesPathPattern('atelier-output/**', 'atelier-output/index.html'))
})

test('the shared matcher is segment-aware, case-stable, and portable', () => {
  assert.equal(matchesPathPattern('private/*.md', 'private/note.md'), true)
  assert.equal(matchesPathPattern('private/*.md', 'private/nested/note.md'), false, '`*` must not cross a segment')
  assert.equal(matchesPathPattern('private/**/*.md', 'private/nested/note.md'), true)
  assert.equal(matchesPathPattern('private/**/*.md', 'private/note.md'), true, '`**/` may match zero segments')
  assert.equal(matchesPathPattern('*.md', 'deeply/nested/note.md'), true, 'slashless patterns retain match-base behavior')
  assert.equal(matchesPathPattern('ATELIER-OUTPUT/**', 'atelier-output/index.html'), true, 'case behavior must not vary by filesystem')
  assert.equal(matchesPathPattern('private/**', 'PRIVATE\\nested\\note.md'), true, 'Windows separators use the same dialect')
})

test('kit manifest fixtures agree with the file-class contract', () => {
  const schema = readJson('contracts/atelier-kit-manifest.v1.schema.json')
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)

  const valid = readJson('fixtures/atelier-kit-manifest/valid/mnstry-atelier.valid.v1.json')
  assert.equal(validate(valid), true, JSON.stringify(validate.errors, null, 2))
  assert.deepEqual(validateFileClasses(valid.fileClasses), [], 'schema and resolver must agree on the same fixture')

  const invalid = readJson('fixtures/atelier-kit-manifest/invalid/runtime-copy-without-canonical-role.v1.json')
  assert.equal(validate(invalid), false, 'a runtime copy with no canonical role must fail the schema')
  assert.match(validateFileClasses(invalid.fileClasses).join('\n'), /canonicalRepoRole is required/)

  const { fileClasses, ...withoutClasses } = valid
  assert.equal(validate(withoutClasses), false, 'fileClasses is required: an unclassified kit fails validation')
})

test('the repo-local Obsidian pointer is ignored-local and no declaration can make it discardable', () => {
  for (const rel of [OBSIDIAN_LOCAL_POINTER, `nested-repo/${OBSIDIAN_LOCAL_POINTER}`]) {
    const result = classifyPath(rel)
    assert.equal(result.class, IGNORED_LOCAL)
    assert.equal(result.handling.discardable, false)
    assert.equal(result.handling.conflictsNeedHuman, false)
  }
  const hostile = [...KIT_FILE_CLASSES, { pattern: '.atelier-local/**', class: GENERATED_PROJECTION }]
  assert.equal(classifyPath(OBSIDIAN_LOCAL_POINTER, { fileClasses: hostile }).class, IGNORED_LOCAL)
  assert.equal(classifyPath('.atelier-local/other.json').class, SOURCE, 'only the named pointer is reclassified')

  // ignored-local is never declarable for a tracked path, so the kit manifest contract is unchanged.
  assert.deepEqual(FILE_CLASSES, [SOURCE, GENERATED_PROJECTION, DISTRIBUTED_RUNTIME_COPY])
  assert.match(validateFileClasses([{ pattern: 'x', class: IGNORED_LOCAL }]).join('\n'), /class must be one of/)
})

test('inside a managed data root only staging is discardable', () => {
  const expected = {
    'vaults/scope-a/notes/Shared concept--7a91f803c2.md': EDITABLE_VAULT,
    'vaults/scope-a/.obsidian/app.json': EDITABLE_VAULT,
    'state/manifests/scope-a/current.json': TRUSTED_STATE,
    'state/objects/repo-a/node-a/edit.json': TRUSTED_STATE,
    'recovery/edit-0001/observed.bin': RECOVERY_RECORD,
    'staging/generation-0001/notes/a.md': DISPOSABLE_STAGING,
  }
  for (const [rel, managedClass] of Object.entries(expected)) {
    const result = classifyManagedPath(rel)
    assert.equal(result.class, managedClass, rel)
    assert.equal(result.handling.discardable, managedClass === DISPOSABLE_STAGING, rel)
  }
  assert.deepEqual(
    Object.entries(MANAGED_AREA_HANDLING).filter(([, handling]) => handling.discardable).map(([name]) => name),
    [DISPOSABLE_STAGING],
  )

  // Anything that is not plainly under staging/ is kept.
  for (const rel of ['', 'staging', 'staging/', 'Staging/generation-0001/a.md', 'staging/../vaults/scope-a/a.md', '../staging/x', '/staging/x', 'C:/staging/x', 'staging-old/x', 'vaults', 'notes/a.md']) {
    const result = classifyManagedPath(rel)
    assert.equal(result.handling.discardable, false, JSON.stringify(rel))
    assert.notEqual(result.class, DISPOSABLE_STAGING, JSON.stringify(rel))
  }
  assert.equal(classifyManagedPath('unplanned/file').class, UNKNOWN_MANAGED)
  assert.equal(classifyManagedPath('staging\\generation-0001\\a.md').class, DISPOSABLE_STAGING, 'Windows separators use the same dialect')

  // An editable vault is never generated output for the tracked-file resolver either.
  assert.equal(classifyPath('vaults/scope-a/notes/a.md').handling.discardable, false)
  assert.equal(classifyPath('recovery/edit-0001/observed.bin').handling.discardable, false)
})

test('a managed root that overlaps an enrolled repository is refused in both directions', (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-managed-root-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const repo = path.join(base, 'workspace', 'alpha-notes')
  const other = path.join(base, 'workspace', 'beta-notes')
  const data = path.join(base, 'data', 'obsidian', 'workspace-0001')
  for (const dir of [repo, other, data]) fs.mkdirSync(dir, { recursive: true })
  const codes = (result) => result.refusals.map((item) => item.code)

  assert.deepEqual(checkManagedRoots({ managedRoots: [data], repositoryRoots: [repo, other] }), { ok: true, refusals: [] })
  assert.deepEqual(checkManagedRoots({ managedRoots: [path.join(base, 'data', 'not-created-yet')], repositoryRoots: [repo] }).ok, true)

  assert.deepEqual(codes(checkManagedRoots({ managedRoots: [path.join(repo, 'atelier-output', 'vault')], repositoryRoots: [repo, other] })), ['managed-root-inside-repository'])
  assert.deepEqual(codes(checkManagedRoots({ managedRoots: [repo], repositoryRoots: [repo] })), ['managed-root-inside-repository'])
  assert.deepEqual(codes(checkManagedRoots({ managedRoots: [path.join(base, 'workspace')], repositoryRoots: [repo, other] })), [
    'repository-inside-managed-root',
    'repository-inside-managed-root',
  ])
  assert.deepEqual(codes(checkManagedRoots({ managedRoots: ['relative/data'], repositoryRoots: [repo] })), ['managed-root-not-absolute'])
  assert.equal(checkManagedRoots({ managedRoots: [`${repo}-data`], repositoryRoots: [repo] }).ok, true, 'a sibling sharing a name prefix is not inside')
})

test('symbolic-link aliases between a managed root and a repository are refused', (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-managed-alias-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const repo = path.join(base, 'workspace', 'alpha-notes')
  const data = path.join(base, 'data')
  for (const dir of [path.join(repo, 'docs'), data]) fs.mkdirSync(dir, { recursive: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  const codes = (result) => result.refusals.map((item) => item.code)

  // A link outside the repository that lands inside it.
  fs.symlinkSync(path.join(repo, 'docs'), path.join(base, 'innocent'), linkType)
  assert.deepEqual(codes(checkManagedRoots({ managedRoots: [path.join(base, 'innocent', 'vault')], repositoryRoots: [repo] })), ['managed-root-symlink-alias'])

  // A repository path that is really a link into the managed root.
  fs.mkdirSync(path.join(data, 'held'), { recursive: true })
  fs.symlinkSync(path.join(data, 'held'), path.join(base, 'workspace', 'linked-repo'), linkType)
  assert.deepEqual(codes(checkManagedRoots({ managedRoots: [data], repositoryRoots: [path.join(base, 'workspace', 'linked-repo')] })), ['managed-root-symlink-alias'])

  // A managed root that is itself a link is refused even when it lands somewhere harmless.
  fs.mkdirSync(path.join(base, 'elsewhere'))
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(base, 'data-link'), linkType)
  assert.deepEqual(codes(checkManagedRoots({ managedRoots: [path.join(base, 'data-link')], repositoryRoots: [repo] })), ['managed-root-symlink-alias'])

  // The filesystem reads are injectable, so the guard is checkable without a disk.
  const mapped = checkManagedRoots({
    managedRoots: [path.resolve('/virtual/data')],
    repositoryRoots: [path.resolve('/virtual/repo')],
    realpath: (target) => (target === path.resolve('/virtual/data') ? path.resolve('/virtual/repo/inner') : target),
    lstat: (target) => ({ isSymbolicLink: () => target === path.resolve('/virtual/data') }),
  })
  assert.deepEqual(codes(mapped), ['managed-root-symlink-alias', 'managed-root-symlink-alias'])
})

test('a real-path overlap with no symbolic link is named as such, not as a link alias', (t) => {
  const codes = (result) => result.refusals.map((item) => item.code)
  const noLinks = () => ({ isSymbolicLink: () => false })
  // Letter case on a folding filesystem, without a disk.
  const folding = checkManagedRoots({
    managedRoots: [path.resolve('/virtual/code/proj/data')],
    repositoryRoots: [path.resolve('/virtual/Code/proj')],
    realpath: (target) => target.replace(`${path.sep}code${path.sep}`, `${path.sep}Code${path.sep}`),
    lstat: noLinks,
  })
  assert.deepEqual(codes(folding), ['managed-root-realpath-overlap'])
  assert.match(folding.refusals[0].message, /letter case/)
  assert.doesNotMatch(folding.refusals[0].message, /^a symbolic link/)

  // Folding explains the overlap even when some ancestor happens to be a link.
  const foldingUnderLink = checkManagedRoots({
    managedRoots: [path.resolve('/virtual/code/proj/data')],
    repositoryRoots: [path.resolve('/virtual/Code/proj')],
    realpath: (target) => target.replace(`${path.sep}code${path.sep}`, `${path.sep}Code${path.sep}`),
    lstat: (target) => ({ isSymbolicLink: () => target === path.resolve('/virtual') }),
  })
  assert.deepEqual(codes(foldingUnderLink), ['managed-root-realpath-overlap'])

  // Neither folding nor a link: still an overlap, still not called a link.
  const mounted = checkManagedRoots({
    managedRoots: [path.resolve('/virtual/data')],
    repositoryRoots: [path.resolve('/virtual/repo')],
    realpath: (target) => (target === path.resolve('/virtual/data') ? path.resolve('/virtual/repo/inner') : target),
    lstat: noLinks,
  })
  assert.deepEqual(codes(mounted), ['managed-root-realpath-overlap'])
  assert.deepEqual(codes(checkRepositoryEnrollment({ repositoryRoot: path.resolve('/virtual/repo'), managedRoots: [path.resolve('/virtual/data')],
    realpath: (target) => (target === path.resolve('/virtual/data') ? path.resolve('/virtual/repo/inner') : target), lstat: noLinks })), ['enrollment-realpath-overlaps-managed-root'])

  // On a real case-folding volume (the macOS default), with no link anywhere below the base.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-managed-case-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  fs.mkdirSync(path.join(base, 'Proj'))
  if (!fs.existsSync(path.join(base, 'proj'))) return t.diagnostic('this volume is case-sensitive; the real-volume case is covered by the injected one')
  assert.deepEqual(codes(checkManagedRoots({ managedRoots: [path.join(base, 'proj', 'data')], repositoryRoots: [path.join(base, 'Proj')] })), ['managed-root-realpath-overlap'])
})

test('a real path that cannot be established refuses; it is never replaced by the lexical path', () => {
  const codes = (result) => result.refusals.map((item) => item.code)
  const denied = (blocked) => (target) => {
    if (target === blocked) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    if (target.startsWith(path.resolve('/virtual/absent'))) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return target
  }
  const lstat = () => ({ isSymbolicLink: () => false })
  const data = path.resolve('/virtual/data')
  const repo = path.resolve('/virtual/repo')
  const managedDenied = checkManagedRoots({ managedRoots: [data], repositoryRoots: [repo], realpath: denied(data), lstat })
  assert.deepEqual(codes(managedDenied), ['managed-root-realpath-failed'])
  assert.match(managedDenied.refusals[0].message, /EACCES/)
  assert.deepEqual(codes(checkManagedRoots({ managedRoots: [data], repositoryRoots: [repo], realpath: denied(repo), lstat })), ['managed-root-realpath-failed'])
  // A root that does not exist yet is still fine: only "does not exist" moves up a level.
  assert.equal(checkManagedRoots({ managedRoots: [path.resolve('/virtual/absent/data')], repositoryRoots: [repo], realpath: denied(null), lstat }).ok, true)
})

test('a later enrollment that would contain a managed root is refused', (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-managed-enroll-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const data = path.join(base, 'home', 'data', 'obsidian', 'workspace-0001')
  fs.mkdirSync(data, { recursive: true })
  fs.mkdirSync(path.join(base, 'projects', 'alpha-notes'), { recursive: true })
  const codes = (result) => result.refusals.map((item) => item.code)

  assert.equal(checkRepositoryEnrollment({ repositoryRoot: path.join(base, 'projects', 'alpha-notes'), managedRoots: [data] }).ok, true)
  assert.deepEqual(codes(checkRepositoryEnrollment({ repositoryRoot: path.join(base, 'home'), managedRoots: [data] })), ['enrollment-contains-managed-root'])
  assert.deepEqual(codes(checkRepositoryEnrollment({ repositoryRoot: path.join(data, 'vaults', 'scope-a'), managedRoots: [data] })), ['enrollment-inside-managed-root'])
  fs.symlinkSync(path.join(base, 'home'), path.join(base, 'projects', 'home-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(codes(checkRepositoryEnrollment({ repositoryRoot: path.join(base, 'projects', 'home-alias'), managedRoots: [data] })), ['enrollment-aliases-managed-root'])
})
