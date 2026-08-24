import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('Codex and Claude ship the same portable Atelier skill catalog', () => {
  const codexRoot = path.join(root, 'skills', 'codex')
  const claudeRoot = path.join(root, 'skills', 'claude')
  const codexSkills = skillNames(codexRoot)
  const claudeSkills = skillNames(claudeRoot)
  assert.deepEqual(codexSkills, claudeSkills)

  for (const name of codexSkills) {
    const codex = fs.readFileSync(path.join(codexRoot, name, 'SKILL.md'), 'utf8')
    const claude = fs.readFileSync(path.join(claudeRoot, name, 'SKILL.md'), 'utf8')
    assert.equal(codex, claude, `${name} must remain byte-identical across agent surfaces`)
  }
})

function skillNames(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
}
