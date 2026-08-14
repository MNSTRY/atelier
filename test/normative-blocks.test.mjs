// The normative blocks under docs/blocks/ are the canonical text of the
// package's promises: the checkable claims, the will-not-do list, the
// conformance/admission separation, and the audience/visibility rule. The
// README embeds each one verbatim between HTML-comment markers, and other
// surfaces (the published documentation page) embed the same blocks with
// their own framing around them. Promises converge by machinery; framing
// diverges by audience. This test is the machinery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const blocksDir = path.join(root, 'docs', 'blocks')

const blockNames = fs
  .readdirSync(blocksDir)
  .filter((name) => name.endsWith('.md'))
  .map((name) => name.replace(/\.md$/, ''))
  .sort()

test('the canonical block set exists', () => {
  assert.deepEqual(blockNames, [
    'audience-visibility',
    'claims',
    'conformance-admission',
    'will-not-do',
  ])
})

test('every normative block is embedded in the README verbatim', () => {
  for (const name of blockNames) {
    const canonical = fs
      .readFileSync(path.join(blocksDir, `${name}.md`), 'utf8')
      .trim()
    const start = `<!-- atelier:block:${name}:start -->`
    const end = `<!-- atelier:block:${name}:end -->`
    const startIndex = readme.indexOf(start)
    const endIndex = readme.indexOf(end)
    assert.notEqual(startIndex, -1, `README is missing the ${start} marker`)
    assert.notEqual(endIndex, -1, `README is missing the ${end} marker`)
    assert.ok(endIndex > startIndex, `README markers for "${name}" are out of order`)
    const embedded = readme.slice(startIndex + start.length, endIndex).trim()
    assert.equal(
      embedded,
      canonical,
      `README block "${name}" must match docs/blocks/${name}.md byte for byte — edit the block file, then re-embed it`
    )
  }
})

test('every block marker in the README names a real block', () => {
  const markerPattern = /<!-- atelier:block:([a-z0-9-]+):(start|end) -->/g
  for (const match of readme.matchAll(markerPattern)) {
    assert.ok(
      blockNames.includes(match[1]),
      `README marker references unknown block "${match[1]}" — add docs/blocks/${match[1]}.md or remove the marker`
    )
  }
})
