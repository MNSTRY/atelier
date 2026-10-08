import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { resolveProjectConfig } from '../project/config.mjs'
import { assessKnowledgeHealth } from './owner-join.mjs'
import { assessmentDigest } from './assessment.mjs'
import { evaluateIngestionTrial } from '../ingestion/evaluation.mjs'

/** The caller explicitly creates a disposable example. No existing directory
 * is overwritten, and the assessment operation itself never writes sources. */
export function initializeExample(destination) {
  const root = path.resolve(destination)
  fs.mkdirSync(root, { recursive: false })
  fs.cpSync(fileURLToPath(new URL('../../fixtures/knowledge-health/workspace/', import.meta.url)), root, { recursive: true, force: false })
  const git = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } })
  if (git.status !== 0) throw new Error('Example requires Git on PATH; remove the disposable example and retry after installing Git')
  return root
}

export function assessExample(root) {
  const project = resolveProjectConfig({ cwd: root, argv: ['--project', path.join(root, 'atelier.project.json')],
    env: {}, writeLocalState: false })
  const records = path.join(root, 'records'), sourceBytes = fs.readFileSync(path.join(records, 'checklist.md'))
  const match = sourceBytes.toString('utf8').match(/^    supports: (\[[^\r\n]*\])$/m)
  if (!match) throw new Error('Example declaration must remain an inline typed supports array')
  const prefix = '    supports: ', needle = Buffer.from(match[0]), start = sourceBytes.indexOf(needle) + Buffer.byteLength(prefix)
  const sourceRevisions = ['checklist.md', 'pilot.md'].map(sourcePath => ({ repo: 'records', path: sourcePath,
    revision: `content-sha256:${assessmentDigest(fs.readFileSync(path.join(records, sourcePath)))}` }))
  const revision = sourceRevisions.find(r => r.path === 'checklist.md').revision
  const binding = { source: { id: 'demo:checklist', repo: 'records', path: 'checklist.md',
    sha256: assessmentDigest(sourceBytes), revision },
    field: { id: 'kg.relations.supports', pointer: '/kg/relations/supports', format: 'markdown-inline-array',
      start, end: start + Buffer.byteLength(match[1]), quote: match[1] },
    authoring: { storeId: 'invented-example-store', sourceId: 'demo:checklist', artifactId: 'invented-checklist',
      fieldId: 'kg.relations.supports', actorBindingId: 'invented-example-owner' } }
  return assessKnowledgeHealth({ project, relationId: 'checklist-pilot', questionId: 'readiness',
    sourceRevisions, binding, currentSourceBytes: sourceBytes })
}

/** Recorded invented calibration only. Runs no processor, provider or held-out
 * suite, and keeps the native evaluator's unknown semantic and cost states. */
export function evaluateKnowledgeHealthCalibration() {
  const read = name => JSON.parse(fs.readFileSync(new URL(`../../fixtures/knowledge-health/${name}.json`, import.meta.url), 'utf8'))
  return evaluateIngestionTrial({ suite: read('calibration-suite'), trial: read('calibration-trial') })
}
