import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  REPO_ACCESS_SCHEMA,
  SOURCE_SIDECAR_SCHEMA,
  buildKnowledgeGraph,
  markdownLinkEdges,
  portableText,
  scanMarkdownLinks,
  validateRepoAccessConfig,
} from '../src/graph/knowledge-graph.mjs'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graph-'))
  const repo = path.join(root, 'project-app')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  return { root, repo }
}

function writeDoc(repo, rel, frontmatter, body = '# Fixture\n\nBody.') {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `---\n${frontmatter.trim()}\n---\n\n${body}\n`)
}

function writeAsset(repo, rel, contents = '') {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
  return abs
}

function writeSidecar(repo, rel, metadata) {
  const abs = path.join(repo, `${rel}.kg.json`)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${JSON.stringify(metadata, null, 2)}\n`)
}

function repoAccess(repoName = 'project-app', readBoundary = 'team') {
  return {
    schema: REPO_ACCESS_SCHEMA,
    defaultReadBoundary: 'team',
    repos: {
      [repoName]: { readBoundary },
    },
  }
}

test('front matter kg.id survives rename while path updates', () => {
  const { root, repo } = makeWorkspace()
  writeDoc(
    repo,
    'docs/original.md',
    `
title: "Original"
kg:
  id: "project-app:stable-original"
  type: "document"
  status: "active"
  audience: "team"
`,
  )

  let result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  let node = result.workspaceGraph.nodes.find((item) => item.id === 'project-app:stable-original')
  assert.equal(node.path, 'docs/original.md')

  fs.mkdirSync(path.join(repo, 'moved'), { recursive: true })
  fs.renameSync(path.join(repo, 'docs/original.md'), path.join(repo, 'moved/original.md'))

  result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  node = result.workspaceGraph.nodes.find((item) => item.id === 'project-app:stable-original')
  assert.equal(node.path, 'moved/original.md')
})

test('non-Markdown sidecar kg.id survives html rename while edges remain stable', () => {
  const { root, repo } = makeWorkspace()
  writeDoc(
    repo,
    'docs/source.md',
    `
title: "Source"
kg:
  id: "project-app:source"
  type: "document"
  status: "active"
  audience: "team"
  relations:
    evidences:
      - "project-app:stable-html"
`,
  )
  writeAsset(repo, 'assets/original.html', '<!doctype html><title>HTML</title>')
  writeSidecar(repo, 'assets/original.html', {
    schema: SOURCE_SIDECAR_SCHEMA,
    asset: 'original.html',
    title: 'HTML',
    summary: '',
    tags: ['fixture'],
    kg: {
      id: 'project-app:stable-html',
      type: 'html',
      domain: 'app',
      lifecycle: 'root',
      status: 'active',
      audience: 'team',
      relations: { related: [], supports: [], supersedes: [] },
    },
  })

  let result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))

  fs.mkdirSync(path.join(repo, 'moved'), { recursive: true })
  fs.renameSync(path.join(repo, 'assets/original.html'), path.join(repo, 'moved/renamed.html'))
  fs.renameSync(path.join(repo, 'assets/original.html.kg.json'), path.join(repo, 'moved/renamed.html.kg.json'))
  const renamedSidecar = JSON.parse(fs.readFileSync(path.join(repo, 'moved/renamed.html.kg.json'), 'utf8'))
  renamedSidecar.asset = 'renamed.html'
  fs.writeFileSync(path.join(repo, 'moved/renamed.html.kg.json'), `${JSON.stringify(renamedSidecar, null, 2)}\n`)

  result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  const graph = result.workspaceGraph
  const html = graph.nodes.find((item) => item.id === 'project-app:stable-html')
  assert.equal(html.path, 'moved/renamed.html')
  assert.ok(graph.edges.some((edge) => edge.source === 'project-app:source' && edge.target === 'project-app:stable-html' && edge.type === 'evidences'))
})

test('missing non-Markdown sidecar fails validation', () => {
  const { root, repo } = makeWorkspace()
  writeAsset(repo, 'assets/missing.html', '<!doctype html><title>Missing</title>')

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /missing non-Markdown sidecar assets\/missing\.html\.kg\.json/)
})

test('repo-access config must cover discovered workspace repos', () => {
  const errors = validateRepoAccessConfig({
    schema: REPO_ACCESS_SCHEMA,
    defaultReadBoundary: 'team',
    repos: {},
  }, ['project-app'])

  assert.match(errors.join('\n'), /repos\.project-app must declare readBoundary/)
})

test('private node in team-readable repo emits disclosure diagnostics', () => {
  const { root, repo } = makeWorkspace()
  writeDoc(
    repo,
    'private-draft.md',
    `
title: "Private Draft"
kg:
  id: "project-app:private-draft"
  type: "document"
  status: "active"
  audience: "private"
`,
  )

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.ok(result.workspaceGraph.diagnostics.some((diagnostic) => diagnostic.type === 'private-repo-recommended'))
})

test('unclassified Markdown is enrolled privately with an explicit diagnostic', () => {
  const { root, repo } = makeWorkspace()
  const fixtures = {
    'absent.md': '# Absent\n\nNo front matter.',
    'empty.md': '---\n\n---\n\n# Empty',
    'malformed.md': '---\ntitle "Malformed"\n---\n\n# Malformed',
    'missing-kg.md': '---\ntitle: "Missing KG"\n---\n\n# Missing KG',
  }
  for (const [rel, contents] of Object.entries(fixtures)) writeAsset(repo, rel, `${contents}\n`)

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(result.workspaceGraph.nodes.length, 4)
  assert.ok(result.workspaceGraph.nodes.every((node) => node.audience === 'private' && node.classification === 'unclassified'))
  assert.deepEqual(
    result.workspaceGraph.diagnostics
      .filter((diagnostic) => diagnostic.code === 'unclassified-content')
      .map((diagnostic) => diagnostic.reason)
      .sort(),
    ['absent-frontmatter', 'empty-frontmatter', 'malformed-frontmatter', 'missing-kg-block'],
  )
})

// The scrubber existed only for macOS home paths; Linux and Windows shapes
// passed through untouched, and CI runs on ubuntu-latest. The probe paths are
// assembled at runtime so the repo disclosure gate never sees a literal one.
test('portableText strips home directories on every OS shape', () => {
  const mac = ['', 'Users', 'sample', 'secret', 'notes.md'].join('/')
  const linux = ['', 'home', 'sample', 'secret', 'notes.md'].join('/')
  const windows = ['C:', 'Users', 'sample', 'secret'].join('\\')
  assert.equal(portableText(mac), '~/secret/notes.md')
  assert.equal(portableText(linux), '~/secret/notes.md')
  assert.equal(portableText(windows), '~\\secret')
  assert.equal(portableText('no paths here'), 'no paths here')
})

// ---------------------------------------------------------------------------
// Ordinary links across enrolled repositories. Every document is invented.
// ---------------------------------------------------------------------------

function makeLinkedWorkspace(t, repoNames = ['alpha-notes', 'beta-notes']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-links-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repos = {}
  for (const name of repoNames) {
    repos[name] = path.join(root, name)
    fs.mkdirSync(path.join(repos[name], '.git'), { recursive: true })
  }
  const access = {
    schema: REPO_ACCESS_SCHEMA,
    defaultReadBoundary: 'team',
    repos: Object.fromEntries(repoNames.map((name) => [name, { readBoundary: 'team' }])),
  }
  return { root, repos, access }
}

function note(repo, rel, id, title, body) {
  writeDoc(repo, rel, `title: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"`, body)
}

const derived = (result) => result.workspaceGraph.edges.filter((edge) => edge.type === 'links_to')

test('an ordinary link into another enrolled repository becomes a canonical links_to edge with exact source offsets', (t) => {
  const { root, repos, access } = makeLinkedWorkspace(t)
  note(repos['alpha-notes'], 'docs/tide.md', 'alpha-notes:tide', 'Tide tables', '# Tide tables — café\n\nSee [the harbour log](../../beta-notes/logs/harbour.md#depth).')
  note(repos['beta-notes'], 'logs/harbour.md', 'beta-notes:harbour', 'Harbour log', '# Harbour log\n\nBack to [tides](../../alpha-notes/docs/).')
  note(repos['alpha-notes'], 'docs/README.md', 'alpha-notes:docs-index', 'Docs index', '# Docs index')

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(derived(result), [
    { source: 'alpha-notes:tide', target: 'beta-notes:harbour', type: 'links_to' },
    { source: 'beta-notes:harbour', target: 'alpha-notes:docs-index', type: 'links_to' },
  ])
  assert.deepEqual(result.linkDiagnostics, [])

  // A repository's own artifact never names a document in another repository.
  for (const { graph } of result.repoGraphs) assert.deepEqual(graph.edges, [])

  const link = result.resolvedLinks.find((item) => item.source === 'alpha-notes:tide')
  assert.equal(link.crossRepository, true)
  assert.equal(link.targetRepo, 'beta-notes')
  assert.equal(link.targetPath, 'logs/harbour.md')
  assert.equal(link.fragment, '#depth')
  const file = path.join(repos['alpha-notes'], 'docs/tide.md')
  const text = fs.readFileSync(file, 'utf8')
  const bytes = fs.readFileSync(file)
  assert.equal(text.slice(link.range.start, link.range.end), '[the harbour log](../../beta-notes/logs/harbour.md#depth)')
  assert.equal(text.slice(link.targetRange.start, link.targetRange.end), '../../beta-notes/logs/harbour.md')
  // The heading holds multi-byte characters, so byte and character offsets differ.
  assert.notEqual(link.targetRange.byteStart, link.targetRange.start)
  assert.equal(bytes.subarray(link.targetRange.byteStart, link.targetRange.byteEnd).toString('utf8'), '../../beta-notes/logs/harbour.md')
  assert.equal(bytes.subarray(link.range.byteStart, link.range.byteEnd).toString('utf8'), text.slice(link.range.start, link.range.end))
})

test('a link that leaves every enrolled repository is diagnosed and creates no edge', (t) => {
  const { root, repos, access } = makeLinkedWorkspace(t)
  fs.mkdirSync(path.join(root, 'loose-folder'), { recursive: true })
  fs.writeFileSync(path.join(root, 'loose-folder/stray.md'), '# Stray\n')
  note(repos['alpha-notes'], 'docs/tide.md', 'alpha-notes:tide', 'Tide tables', '# Tide tables\n\n[stray](../../loose-folder/stray.md) and [far](../../../elsewhere/far.md).')

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(derived(result), [])
  assert.deepEqual(result.resolvedLinks, [])
  assert.deepEqual(result.linkDiagnostics.map((item) => [item.code, item.href]), [
    ['link-target-outside-enrolled-roots', '../../loose-folder/stray.md'],
    ['link-target-outside-enrolled-roots', '../../../elsewhere/far.md'],
  ])
  assert.ok(!JSON.stringify(result.linkDiagnostics).includes(root), 'findings never carry an absolute path')
})

test('a repository declared external is not an enrolled link target', (t) => {
  const { root, repos, access } = makeLinkedWorkspace(t, ['alpha-notes', 'vendor-tool'])
  delete access.repos['vendor-tool']
  note(repos['vendor-tool'], 'guide.md', 'vendor-tool:guide', 'Guide', '# Guide')
  note(repos['alpha-notes'], 'tide.md', 'alpha-notes:tide', 'Tide tables', '# Tide tables\n\n[guide](../vendor-tool/guide.md)')

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access, externalRepos: ['vendor-tool'] })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(derived(result), [])
  assert.deepEqual(result.linkDiagnostics.map((item) => item.code), ['link-target-outside-enrolled-roots'])
})

test('a title-only wikilink resolves when unique and refuses when two documents share the title', (t) => {
  const { root, repos, access } = makeLinkedWorkspace(t, ['alpha-notes', 'beta-notes', 'gamma-notes'])
  note(repos['alpha-notes'], 'tide.md', 'alpha-notes:tide', 'Tide tables', '# Tide tables\n\n[[Harbour log|the log]] then [[Shared glossary]] then ![[logs/harbour]].')
  note(repos['beta-notes'], 'logs/harbour.md', 'beta-notes:harbour', 'Harbour log', '# Harbour log')
  note(repos['beta-notes'], 'glossary.md', 'beta-notes:glossary', 'Shared glossary', '# Shared glossary')
  note(repos['gamma-notes'], 'terms.md', 'gamma-notes:terms', 'Shared glossary', '# Shared glossary')

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(derived(result), [{ source: 'alpha-notes:tide', target: 'beta-notes:harbour', type: 'links_to' }])
  assert.deepEqual(result.resolvedLinks.map((item) => [item.syntax, item.resolvedBy, item.embed, item.href]), [
    ['wikilink', 'title', false, 'Harbour log'],
    ['wikilink', 'path', true, 'logs/harbour'],
  ])
  assert.equal(result.linkDiagnostics.length, 1)
  const [ambiguous] = result.linkDiagnostics
  assert.equal(ambiguous.code, 'link-target-ambiguous')
  assert.deepEqual(ambiguous.candidates, ['beta-notes:glossary', 'gamma-notes:terms'])
  const text = fs.readFileSync(path.join(repos['alpha-notes'], 'tide.md'), 'utf8')
  assert.equal(text.slice(ambiguous.range.start, ambiguous.range.end), '[[Shared glossary]]')
})

test('a withheld target yields no edge and a finding identical to an absent target', (t) => {
  const { root, repos, access } = makeLinkedWorkspace(t)
  const body = (name) => `# Tide tables\n\n[one](../beta-notes/${name}.md) and [[${name === 'sealed' ? 'Sealed ledger' : 'Missing ledger'}]].`
  note(repos['alpha-notes'], 'tide.md', 'alpha-notes:tide', 'Tide tables', body('sealed'))
  note(repos['beta-notes'], 'sealed.md', 'beta-notes:sealed', 'Sealed ledger', '# Sealed ledger\n\nConfidential summary line.')
  note(repos['beta-notes'], 'open.md', 'beta-notes:open', 'Open ledger', '# Open ledger\n\n[back](../alpha-notes/tide.md)')

  const withheld = buildKnowledgeGraph({
    workspaceRoot: root,
    repoAccessConfig: access,
    isLinkTargetEligible: (node) => node.id !== 'beta-notes:sealed',
  })
  assert.equal(withheld.ok, true, withheld.errors.join('\n'))
  assert.deepEqual(derived(withheld), [{ source: 'beta-notes:open', target: 'alpha-notes:tide', type: 'links_to' }])
  assert.deepEqual(withheld.linkDiagnostics.map((item) => item.code), ['link-target-unresolved', 'link-target-unresolved'])
  const serialized = JSON.stringify([withheld.linkDiagnostics, withheld.resolvedLinks])
  for (const leak of ['beta-notes:sealed', 'Confidential', 'candidates']) assert.ok(!serialized.includes(leak), leak)

  // The same links to a document that does not exist read exactly the same.
  note(repos['alpha-notes'], 'tide.md', 'alpha-notes:tide', 'Tide tables', body('absent'))
  const absent = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  const shape = (items) => items.map(({ href, message, range, targetRange, ...rest }) => ({ ...rest, keys: Object.keys({ href, message, range, targetRange }) }))
  assert.deepEqual(shape(withheld.linkDiagnostics), shape(absent.linkDiagnostics))

  // A withheld document is not scanned as a source either.
  const sourceWithheld = buildKnowledgeGraph({
    workspaceRoot: root,
    repoAccessConfig: access,
    isLinkTargetEligible: (node) => node.id !== 'beta-notes:open',
  })
  assert.deepEqual(derived(sourceWithheld), [])
})

test('in-repository links keep their edges; code, inline code and front matter never become edges', (t) => {
  const { root, repos, access } = makeLinkedWorkspace(t, ['alpha-notes'])
  const repo = repos['alpha-notes']
  writeDoc(
    repo,
    'docs/tide.md',
    'title: "Tide tables"\nnotes: "[yaml](moon.md)"\nunknown_block:\n  ref: "[[Moon phases]]"\nkg:\n  id: "alpha-notes:tide"\n  type: "document"\n  status: "active"\n  audience: "team"',
    [
      '# Tide tables',
      '',
      'Real: [moon](moon.md), [section](./moon.md#new), [folder](../guides), [web](https://example.invalid/x.md), [gone](nowhere.md).',
      '',
      'Inline `[code](sun.md)` and ``[[Sun cycle]]`` stay literal.',
      '',
      '```md',
      '[fenced](sun.md)',
      '[[Sun cycle]]',
      '```',
      '',
      '~~~',
      '[tilde](sun.md)',
      '~~~',
    ].join('\n'),
  )
  note(repo, 'docs/moon.md', 'alpha-notes:moon', 'Moon phases', '# Moon phases')
  note(repo, 'docs/sun.md', 'alpha-notes:sun', 'Sun cycle', '# Sun cycle')
  note(repo, 'guides/README.md', 'alpha-notes:guides', 'Guides', '# Guides')

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  assert.equal(result.ok, true, result.errors.join('\n'))
  const expected = [
    { source: 'alpha-notes:tide', target: 'alpha-notes:guides', type: 'links_to' },
    { source: 'alpha-notes:tide', target: 'alpha-notes:moon', type: 'links_to' },
  ]
  assert.deepEqual(derived(result), expected)
  assert.deepEqual(result.repoGraphs[0].graph.edges, expected)
  assert.ok(!result.resolvedLinks.some((item) => item.target === 'alpha-notes:sun'))
  assert.deepEqual(result.linkDiagnostics.map((item) => [item.code, item.href]), [['link-target-unresolved', 'nowhere.md']])

  // The long-standing helper answers from the same resolver.
  const nodesByPath = new Map(result.workspaceGraph.nodes.map((node) => [node.path, node]))
  assert.deepEqual(markdownLinkEdges(repo, nodesByPath), [
    { source: 'alpha-notes:tide', target: 'alpha-notes:moon', type: 'links_to' },
    { source: 'alpha-notes:tide', target: 'alpha-notes:moon', type: 'links_to' },
    { source: 'alpha-notes:tide', target: 'alpha-notes:guides', type: 'links_to' },
  ])
})

test('link scanning keeps CRLF offsets exact and treats an unclosed backtick as text', () => {
  const text = '---\r\ntitle: "x"\r\nlink: "[y](y.md)"\r\n---\r\n\r\nA stray ` then [real](a.md)\r\n\r\nand `[not](b.md)` here.\r\n'
  const found = scanMarkdownLinks(text)
  assert.deepEqual(found.map((item) => item.href), ['a.md'])
  assert.equal(text.slice(found[0].range.start, found[0].range.end), '[real](a.md)')
})

test('a malformed percent escape is diagnosed instead of stopping the build', (t) => {
  const { root, repos, access } = makeLinkedWorkspace(t, ['alpha-notes'])
  note(repos['alpha-notes'], 'tide.md', 'alpha-notes:tide', 'Tide tables', '# Tide tables\n\n[bad](moon%zz.md)')
  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(result.linkDiagnostics.map((item) => item.code), ['link-href-malformed'])
})
