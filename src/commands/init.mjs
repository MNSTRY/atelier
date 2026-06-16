#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, writeJson } from '../project/config.mjs'

const packageRoot = path.resolve(new URL('../..', import.meta.url).pathname)

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const ent of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, ent.name)
    const to = path.join(target, ent.name)
    if (ent.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

const args = parseArgs(process.argv.slice(2))
const target = path.resolve(args.target || process.cwd())
if (args.fixture === 'sample-workspace') {
  copyDir(path.join(packageRoot, 'fixtures/projects/sample-workspace'), target)
  console.log(`created sample Atelier workspace at ${target}`)
} else {
  fs.mkdirSync(target, { recursive: true })
  fs.mkdirSync(path.join(target, 'content'), { recursive: true })
  writeJson(path.join(target, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: path.basename(target),
    roots: { workspace: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: [{ name: 'content', path: 'content', readBoundary: 'private' }],
  })
  writeJson(path.join(target, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'private',
    repos: { content: { readBoundary: 'private' } },
  })
  console.log(`created Atelier project scaffold at ${target}`)
}
