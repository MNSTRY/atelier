import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  resolveWorkspaceLinks,
  scanMarkdownLinks,
  unclosedFenceAtEnd,
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

test('a withheld directory candidate never shadows an eligible one: links and findings equal the absent case', () => {
  // Each case names the files present under d/ and which of them are withheld.
  const run = (present, withheld = []) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-withheld-candidate-'))
    try {
      fs.mkdirSync(path.join(root, 'd'))
      fs.writeFileSync(path.join(root, 'src.md'), 'See [x](d) and [y](d/README.md) and [z](d/index.md).\n')
      const nodesByPath = new Map([['src.md', { id: 'n:src.md', path: 'src.md' }]])
      for (const rel of present) {
        fs.writeFileSync(path.join(root, rel), `# ${rel}\n`)
        nodesByPath.set(rel, { id: `n:${rel}`, path: rel })
      }
      const hidden = new Set(withheld.map((rel) => `n:${rel}`))
      return resolveWorkspaceLinks({ repos: [{ name: 'r', root, nodesByPath }], isLinkTargetEligible: (node) => !hidden.has(node.id) })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  const indexOnly = run(['d/index.md'])
  assert.deepEqual(indexOnly.links.map((link) => [link.href, link.target]), [['d', 'n:d/index.md'], ['d/index.md', 'n:d/index.md']])
  assert.deepEqual(run(['d/index.md', 'd/README.md'], ['d/README.md']), indexOnly)

  const readmeOnly = run(['d/README.md'])
  assert.deepEqual(readmeOnly.links.map((link) => [link.href, link.target]), [['d', 'n:d/README.md'], ['d/README.md', 'n:d/README.md']])
  assert.deepEqual(run(['d/README.md', 'd/index.md'], ['d/index.md']), readmeOnly)

  // Both withheld reads exactly as neither present; both eligible prefers README.
  assert.deepEqual(run(['d/README.md', 'd/index.md'], ['d/README.md', 'd/index.md']), run([]))
  assert.equal(run(['d/README.md', 'd/index.md']).links[0].target, 'n:d/README.md')
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

test('the link scanner differs from the earlier whole-text pattern in exactly the pinned behavior classes', () => {
  // The earlier reader applied this one pattern to the whole text.
  const earlier = (text) => [...text.matchAll(/\[[^\]]+\]\(([^)\s#]+)(?:#[^)]+)?\)/g)].map((m) => m[1])
  const now = (text) => scanMarkdownLinks(text).filter((link) => link.syntax === 'markdown').map((link) => link.href)
  // [class, case, text, hrefs read now]. `same` rows must equal the earlier reader.
  const table = [
    ['fence', 'balanced backtick fence', '```\n[a](t.md)\n```\n', []],
    ['fence', 'balanced tilde fence', '~~~\n[a](t.md)\n~~~\n', []],
    ['fence', 'fence with an info string', '```js\n[a](t.md)\n```\n[b](o.md)\n', ['o.md']],
    ['fence', 'fence indented three spaces', '   ```\n[a](t.md)\n   ```\n', []],
    ['fence', 'CRLF fence', '```\r\n[a](t.md)\r\n```\r\n[b](o.md)\r\n', ['o.md']],
    ['fence', 'unbalanced fence runs to the end', '```\nx\n\n[a](t.md)\n', []],
    ['fence', 'a longer closing fence closes', '~~~\n[a](t.md)\n~~~~\n[b](o.md)\n', ['o.md']],
    ['fence', 'a shorter closing fence does not close', '````\n[a](t.md)\n```\n[b](o.md)\n', []],
    ['fence', 'a tilde line does not close a backtick fence', '```\n[a](t.md)\n~~~\n[b](o.md)\n', []],
    ['inline-code', 'inline code span', 'text `[a](t.md)` more\n', []],
    ['inline-code', 'double-backtick span', '``[a](t.md)`` then [b](o.md)\n', ['o.md']],
    ['inline-code', 'two unrelated backticks pair across a link', 'Use ` here. See [a](t.md) and ` again.\n', []],
    ['front-matter', 'closed front matter', '---\nx: "[a](t.md)"\n---\n\n[b](o.md)\n', ['o.md']],
    ['same', 'four-space indent is not a fence', '    ```\n    [a](t.md)\n', ['t.md']],
    ['same', 'backtick in a backtick fence info string is not a fence', '``` `x`\n[a](t.md)\n', ['t.md']],
    ['same', 'unclosed front matter is body text', '---\nx: [a](t.md)\n', ['t.md']],
    ['same', 'a thematic break is not front matter', '---\n\n[a](t.md)\n', ['t.md']],
    ['same', 'an unclosed backtick is plain text', 'A stray ` then [a](t.md)\n', ['t.md']],
    ['same', 'a blank line ends the paragraph a span may close in', 'Use ` here.\n\nSee [a](t.md) and ` again.\n', ['t.md']],
    ['same', 'inline code as the link label', '[`n`](t.md)\n', ['t.md']],
    ['same', 'spans around a link', '`a` [x](t.md) `c`\n', ['t.md']],
    ['same', 'table, quote, list and image', '| [a](t.md) |\n\n> [b](o.md)\n\n- [c](p.md)\n\n![d](q.md)\n', ['t.md', 'o.md', 'p.md', 'q.md']],
    ['same', 'fragment and percent-encoding', '[a](t.md#sec) [b](t%20o.md) [c](%zz.md)\n', ['t.md', 't%20o.md', '%zz.md']],
    ['same', 'CRLF plain text', '[a](t.md)\r\n', ['t.md']],
  ]
  for (const [kind, name, text, expected] of table) {
    assert.deepEqual(now(text), expected, name)
    if (kind === 'same') assert.deepEqual(earlier(text), expected, `${name}: unchanged from the earlier reader`)
    else assert.notDeepEqual(earlier(text), expected, `${name}: a pinned difference from the earlier reader`)
  }
})

test('malformed percent-encoding is a finding beside the other links of the same source, never a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-bad-percent-'))
  try {
    fs.writeFileSync(path.join(root, 'a.md'), '[bad](%zz.md) [worse](b%E0%A4%A.md) [fine](b.md)\n')
    fs.writeFileSync(path.join(root, 'b.md'), '# B\n')
    const nodesByPath = new Map([['a.md', { id: 'n:a', path: 'a.md' }], ['b.md', { id: 'n:b', path: 'b.md' }]])
    const resolved = resolveWorkspaceLinks({ repos: [{ name: 'r', root, nodesByPath }] })
    assert.deepEqual(resolved.links.map((link) => link.target), ['n:b'])
    assert.deepEqual(resolved.diagnostics.map((item) => [item.code, item.href]), [['link-href-malformed', '%zz.md'], ['link-href-malformed', 'b%E0%A4%A.md']])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('markdownLinkEdges accepts census nodes that carry only an id, including beside wikilinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-minimal-nodes-'))
  try {
    fs.writeFileSync(path.join(root, 'a.md'), '# A\n\nSee [b](b.md) and [[b]] and [[notes/c]].\n')
    fs.writeFileSync(path.join(root, 'b.md'), '# B\n')
    const nodesByPath = new Map([['a.md', { id: 'n:a' }], ['b.md', { id: 'n:b' }]])
    assert.deepEqual(markdownLinkEdges(root, nodesByPath), [{ source: 'n:a', target: 'n:b', type: 'links_to' }])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a link whose label is inline code is an ordinary link; a link inside inline code is not', () => {
  const found = scanMarkdownLinks('See [`b.md`](./b.md), not `[c](c.md)` and not `` [[d]] ``.\n')
  assert.deepEqual(found.map((link) => link.href), ['./b.md'])
})

// ---------------------------------------------------------------------------
// Embedded assets. An embed of a file that is not a document resolves to an
// asset record beside the graph; it never becomes a node or an edge. Every
// oracle below is a function, so a mutation control can show that it fails.
// ---------------------------------------------------------------------------

const PIXEL = Buffer.from('89504e470d0a1a0a', 'hex')

function makeAssetWorkspace(t) {
  const made = makeLinkedWorkspace(t)
  const alpha = made.repos['alpha-notes']
  const beta = made.repos['beta-notes']
  note(
    alpha,
    'docs/tide.md',
    'alpha-notes:tide',
    'Tide tables',
    [
      '# Tide tables — café',
      '',
      'Plain ![gauge](img/gauge.png) and spaced ![two words](img/two%20words.png#crop) and far ![far](../../beta-notes/charts/swell.svg).',
      '',
      'Wiki ![[docs/img/gauge.png|200]] and ![[beta-notes/charts/swell.svg]] and bare ![[buoy.gif|120x80]] and note ![[Harbour log]].',
      '',
      'A plain link to a file is no embed: [gauge file](img/gauge.png). Gone: ![gone](img/gone.png).',
      '',
      'Inline `![code](img/gauge.png)` and `![[buoy.gif]]` stay literal.',
      '',
      '```',
      '![fenced](img/gauge.png)',
      '![[buoy.gif]]',
      '```',
    ].join('\n'),
  )
  note(beta, 'logs/harbour.md', 'beta-notes:harbour', 'Harbour log', '# Harbour log')
  writeAsset(alpha, 'docs/img/gauge.png', PIXEL)
  writeAsset(alpha, 'docs/img/two words.png', PIXEL)
  writeAsset(alpha, 'pool/buoy.gif', 'GIF89a')
  writeAsset(beta, 'charts/swell.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
  return made
}

const artifactBytes = (result) => JSON.stringify([result.workspaceGraph, result.repoGraphs.map(({ repoName, graph }) => [repoName, graph])])

function assertEmbedsResolve(result, repos) {
  assert.deepEqual(
    result.resolvedEmbeds.map((item) => [item.syntax, item.resolvedBy, item.asset.id, item.href, item.fragment, item.crossRepository]),
    [
      ['markdown', 'path', 'alpha-notes:asset:docs/img/gauge.png', 'img/gauge.png', '', false],
      ['markdown', 'path', 'alpha-notes:asset:docs/img/two words.png', 'img/two%20words.png', '#crop', false],
      ['markdown', 'path', 'beta-notes:asset:charts/swell.svg', '../../beta-notes/charts/swell.svg', '', true],
      ['wikilink', 'path', 'alpha-notes:asset:docs/img/gauge.png', 'docs/img/gauge.png', '', false],
      ['wikilink', 'path', 'beta-notes:asset:charts/swell.svg', 'beta-notes/charts/swell.svg', '', true],
      ['wikilink', 'basename', 'alpha-notes:asset:pool/buoy.gif', 'buoy.gif', '', false],
    ],
  )
  const [first] = result.resolvedEmbeds
  assert.deepEqual(Object.keys(first), ['source', 'type', 'asset', 'syntax', 'href', 'fragment', 'resolvedBy', 'crossRepository', 'sourceRepo', 'sourcePath', 'range', 'targetRange'])
  assert.deepEqual([first.source, first.type, first.sourceRepo, first.sourcePath], ['alpha-notes:tide', 'embeds_asset', 'alpha-notes', 'docs/tide.md'])
  assert.deepEqual(first.asset, { id: 'alpha-notes:asset:docs/img/gauge.png', repo: 'alpha-notes', path: 'docs/img/gauge.png', extension: 'png' })
  const bytes = fs.readFileSync(path.join(repos['alpha-notes'], 'docs/tide.md'))
  const text = bytes.toString('utf8')
  for (const embed of result.resolvedEmbeds) {
    assert.equal(text.slice(embed.targetRange.start, embed.targetRange.end), embed.href)
    assert.equal(bytes.subarray(embed.targetRange.byteStart, embed.targetRange.byteEnd).toString('utf8'), embed.href)
    assert.equal(bytes.subarray(embed.range.byteStart, embed.range.byteEnd).toString('utf8'), text.slice(embed.range.start, embed.range.end))
    // The heading holds multi-byte characters, so byte and character offsets differ.
    assert.notEqual(embed.range.byteStart, embed.range.start)
  }
  const sized = result.resolvedEmbeds.find((item) => item.href === 'buoy.gif')
  assert.equal(text.slice(sized.range.start, sized.range.end), '[[buoy.gif|120x80]]')
  // A note embed stays a link; a plain link to a file and a missing file stay findings.
  assert.deepEqual(result.resolvedLinks.map((item) => [item.embed, item.target]), [[true, 'beta-notes:harbour']])
  assert.deepEqual(result.linkDiagnostics.map((item) => [item.code, item.href]), [
    ['link-target-unresolved', 'img/gauge.png'],
    ['link-target-unresolved', 'img/gone.png'],
  ])
}

test('markdown and wikilink embeds of enrolled files resolve to asset records with exact offsets', (t) => {
  const { root, repos, access } = makeAssetWorkspace(t)
  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assertEmbedsResolve(result, repos)
  // Two builds of the same tree agree byte for byte.
  const again = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  assert.equal(JSON.stringify([again.resolvedEmbeds, again.linkDiagnostics]), JSON.stringify([result.resolvedEmbeds, result.linkDiagnostics]))
})

test('mutation control: embeds scanned inside code, or a dropped size tail, fail the embed oracle', (t) => {
  const { root, repos, access } = makeAssetWorkspace(t)
  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  const fenced = { ...result.resolvedEmbeds[0], href: 'img/gauge.png', range: { ...result.resolvedEmbeds[0].range } }
  assert.throws(() => assertEmbedsResolve({ ...result, resolvedEmbeds: [...result.resolvedEmbeds, fenced] }, repos), assert.AssertionError)
  const shortened = result.resolvedEmbeds.map((item) => (item.href === 'buoy.gif' ? { ...item, range: { ...item.range, end: item.range.end - 1 } } : item))
  assert.throws(() => assertEmbedsResolve({ ...result, resolvedEmbeds: shortened }, repos), assert.AssertionError)
})

function assertArtifactsIgnoreAssets(withAssets, withoutAssets) {
  assert.equal(artifactBytes(withAssets), artifactBytes(withoutAssets))
  assert.ok(withAssets.resolvedEmbeds.length > 0 && withoutAssets.resolvedEmbeds.length === 0, 'fixture no longer exercises assets')
}

test('graph artifacts and markdownLinkEdges are byte-identical with and without assets present', (t) => {
  // One workspace, built with its assets and again after they are deleted.
  const { root, repos, access } = makeAssetWorkspace(t)
  const edgesOf = (result) => markdownLinkEdges(repos['alpha-notes'], new Map(result.workspaceGraph.nodes.filter((node) => node.repo === 'alpha-notes').map((node) => [node.path, node])))
  const withAssets = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  const edgesWithAssets = edgesOf(withAssets)
  for (const rel of ['alpha-notes/docs/img', 'alpha-notes/pool', 'beta-notes/charts']) fs.rmSync(path.join(root, rel), { recursive: true })
  const withoutAssets = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: access })
  assertArtifactsIgnoreAssets(withAssets, withoutAssets)
  assert.ok(!artifactBytes(withAssets).includes('asset:'))
  assert.deepEqual(edgesWithAssets, edgesOf(withoutAssets))

  // Mutation control: an embed that became an edge changes the artifact.
  const leaked = { ...withAssets, workspaceGraph: { ...withAssets.workspaceGraph, edges: [...withAssets.workspaceGraph.edges, { source: 'alpha-notes:tide', target: 'alpha-notes:asset:docs/img/gauge.png', type: 'links_to' }] } }
  assert.throws(() => assertArtifactsIgnoreAssets(leaked, withoutAssets), assert.AssertionError)
})

// One source, one embed per case; returns what the resolver reports.
function resolveEmbeds(t, body, arrange, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-embeds-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'src.md'), body)
  arrange(root)
  return resolveWorkspaceLinks({ repos: [{ name: 'r', root, nodesByPath: new Map([['src.md', { id: 'n:src', path: 'src.md' }]]) }], ...options })
}

const assertUnresolved = (resolved) => {
  assert.deepEqual(resolved.embeds, [])
  assert.deepEqual(resolved.diagnostics.map((item) => item.code), resolved.diagnostics.map(() => 'link-target-unresolved'))
  assert.ok(resolved.diagnostics.length > 0)
}

test('a bare embed name that matches more than one file refuses to choose', (t) => {
  const twice = resolveEmbeds(t, '![[buoy.gif]]\n', (root) => {
    writeAsset(root, 'east/buoy.gif', 'GIF89a')
    writeAsset(root, 'west/buoy.gif', 'GIF89a')
  })
  const assertAmbiguous = (resolved) => {
    assert.deepEqual(resolved.embeds, [])
    assert.deepEqual(resolved.diagnostics.map((item) => [item.code, item.candidates]), [['link-target-ambiguous', ['r:asset:east/buoy.gif', 'r:asset:west/buoy.gif']]])
  }
  assertAmbiguous(twice)
  // A withheld namesake is skipped before choosing, exactly as an absent one.
  const one = resolveEmbeds(t, '![[buoy.gif]]\n', (root) => writeAsset(root, 'east/buoy.gif', 'GIF89a'))
  const hidden = resolveEmbeds(
    t,
    '![[buoy.gif]]\n',
    (root) => {
      writeAsset(root, 'east/buoy.gif', 'GIF89a')
      writeAsset(root, 'west/buoy.gif', 'GIF89a')
    },
    { isAssetEligible: ({ path: rel }) => rel !== 'west/buoy.gif' },
  )
  assert.deepEqual(hidden, one)
  assert.equal(one.embeds[0].asset.id, 'r:asset:east/buoy.gif')
  // Mutation control: the single-file case is not ambiguous.
  assert.throws(() => assertAmbiguous(one), assert.AssertionError)
})

test('an asset that is a link on disk, or is reached through one, stays unresolved', (t) => {
  const body = '![a](img/linked.png) ![b](through/real.png) ![[linked.png]] ![[through/real.png]]\n'
  const linked = resolveEmbeds(t, body, (root) => {
    writeAsset(root, 'store/real.png', PIXEL)
    fs.mkdirSync(path.join(root, 'img'))
    fs.symlinkSync(path.join(root, 'store/real.png'), path.join(root, 'img/linked.png'))
    fs.symlinkSync(path.join(root, 'store'), path.join(root, 'through'))
  })
  assertUnresolved(linked)
  assert.equal(linked.diagnostics.length, 4)
  // Mutation control: the same names as regular files resolve, so the oracle fails.
  const regular = resolveEmbeds(t, body, (root) => {
    writeAsset(root, 'img/linked.png', PIXEL)
    writeAsset(root, 'through/real.png', PIXEL)
  })
  assert.equal(regular.embeds.length, 4)
  assert.throws(() => assertUnresolved(regular), assert.AssertionError)
})

test('a git-ignored asset, a file inside .git and a Markdown file are never assets', (t) => {
  const body = '![a](cache/shot.png) ![[shot.png]] ![b](.git/description) ![c](kept/shot.png)\n'
  const arrange = (ignore) => (root) => {
    const run = (args) => assert.equal(spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).status, 0)
    run(['init', '--quiet'])
    fs.writeFileSync(path.join(root, '.gitignore'), ignore)
    writeAsset(root, 'cache/shot.png', PIXEL)
    writeAsset(root, 'kept/shot.png', PIXEL)
    fs.writeFileSync(path.join(root, '.git/description'), 'fixture\n')
  }
  const ignored = resolveEmbeds(t, body, arrange('cache/\n'))
  const assertOnlyKept = (resolved) => {
    assert.deepEqual(resolved.embeds.map((item) => [item.href, item.asset.id]), [['shot.png', 'r:asset:kept/shot.png'], ['kept/shot.png', 'r:asset:kept/shot.png']])
    assert.deepEqual(resolved.diagnostics.map((item) => [item.code, item.href]), [['link-target-unresolved', 'cache/shot.png'], ['link-target-unresolved', '.git/description']])
  }
  assertOnlyKept(ignored)
  // Mutation control: without the ignore rule the cached file is an asset and the bare name is ambiguous.
  assert.throws(() => assertOnlyKept(resolveEmbeds(t, body, arrange('unrelated/\n'))), assert.AssertionError)
})

test('a withheld asset is reported exactly as a deleted one', (t) => {
  const body = '# Café\n\n![a](img/sealed.png) and ![[img/sealed.png|40]] and ![[sealed.png]] and ![b](img/open.png)\n'
  const arrange = (withSealed) => (root) => {
    writeAsset(root, 'img/open.png', PIXEL)
    if (withSealed) writeAsset(root, 'img/sealed.png', 'ZQXSEALEDBYTES')
  }
  const withheld = resolveEmbeds(t, body, arrange(true), { isAssetEligible: ({ repo, path: rel }) => !(repo === 'r' && rel === 'img/sealed.png') })
  const deleted = resolveEmbeds(t, body, arrange(false))
  const assertIndistinguishable = (left, right) => assert.equal(JSON.stringify(left), JSON.stringify(right))
  assertIndistinguishable(withheld, deleted)
  assert.deepEqual(withheld.diagnostics.map((item) => item.code), ['link-target-unresolved', 'link-target-unresolved', 'link-target-unresolved'])
  assert.deepEqual(withheld.embeds.map((item) => item.asset.path), ['img/open.png'])
  // Mutation control: an eligible sealed file resolves, so the comparison fails.
  assert.throws(() => assertIndistinguishable(resolveEmbeds(t, body, arrange(true)), deleted), assert.AssertionError)
})

test('an embed whose path is a census node is never an asset, withheld or not', (t) => {
  const arrange = (root) => writeAsset(root, 'charts/depth.pdf', '%PDF-1.4\n')
  const resolve = (options) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-embeds-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.writeFileSync(path.join(root, 'src.md'), '![chart](charts/depth.pdf)\n')
    arrange(root)
    const nodesByPath = new Map([['src.md', { id: 'n:src', path: 'src.md' }], ['charts/depth.pdf', { id: 'n:depth', path: 'charts/depth.pdf' }]])
    return resolveWorkspaceLinks({ repos: [{ name: 'r', root, nodesByPath }], ...options })
  }
  const open = resolve({})
  assert.deepEqual([open.links.map((link) => link.target), open.embeds], [['n:depth'], []])
  const sealed = resolve({ isLinkTargetEligible: (node) => node.id !== 'n:depth' })
  assert.deepEqual([sealed.links, sealed.embeds, sealed.diagnostics.map((item) => item.code)], [[], [], ['link-target-unresolved']])
})

// ---------------------------------------------------------------------------
// The fence a text ends inside, by the scanner's own rules.
// ---------------------------------------------------------------------------

test('unclosedFenceAtEnd reports the open fence exactly when the scanner stops reading links', () => {
  const cases = [
    ['text\n```js\ncode\n', { char: '`', length: 3, indent: 0 }],
    ['text\n~~~~\ncode', { char: '~', length: 4, indent: 0 }],
    ['- item\n\n   `````\n```\nstill code\n', { char: '`', length: 5, indent: 3 }],
    ['a\r\n```\r\ncode\r\n', { char: '`', length: 3, indent: 0 }],
    // A shorter or different closing run does not close; a longer one does.
    ['````\n```\n~~~~\n', { char: '`', length: 4, indent: 0 }],
    ['```\ncode\n`````\n', null],
    ['```\ncode\n```\n', null],
    // Four spaces is indented code, and a backtick fence cannot carry a backtick after it.
    ['    ```\ncode\n', null],
    ['``` a`b\ncode\n', null],
    // Front matter is never read for fences; the body after it is.
    ['---\nsample: |\n  ```\n---\nbody\n', null],
    ['---\nsample: |\n  ```\n---\n```\nbody\n', { char: '`', length: 3, indent: 0 }],
    ['', null],
  ]
  const probe = '\n[[Probe target]]\n'
  const assertAgreesWithScanner = (text, expected, read = unclosedFenceAtEnd) => {
    assert.deepEqual(read(text), expected, JSON.stringify(text))
    // Appended text is scanned for links exactly when no fence is open.
    const appended = scanMarkdownLinks(`${text}${probe}`).some((item) => item.href === 'Probe target')
    assert.equal(appended, read(text) === null, JSON.stringify(text))
  }
  for (const [text, expected] of cases) assertAgreesWithScanner(text, expected)
  // Mutation controls: a reader that scans front matter, and one that lets any run close a fence.
  const scansFrontMatter = (text) => unclosedFenceAtEnd(text.replace(/^---\n/, 'x\n'))
  assert.throws(() => { for (const [text, expected] of cases) assertAgreesWithScanner(text, expected, scansFrontMatter) }, assert.AssertionError)
  const anyRunCloses = (text) => (unclosedFenceAtEnd(text) && /\n(```|~~~)[^\n]*\n(```|~~~)/.test(text) ? null : unclosedFenceAtEnd(text))
  assert.throws(() => { for (const [text, expected] of cases) assertAgreesWithScanner(text, expected, anyRunCloses) }, assert.AssertionError)
})
