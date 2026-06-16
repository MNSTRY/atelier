import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const fixture = path.join(root, 'fixtures/projects/sample-workspace')

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const ent of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, ent.name)
    const to = path.join(target, ent.name)
    if (ent.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

export function makeSampleProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-sample-'))
  copyDir(fixture, dir)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    config: path.join(dir, 'atelier.project.json'),
  }
}
