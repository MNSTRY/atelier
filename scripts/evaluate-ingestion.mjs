#!/usr/bin/env node
// Synthetic structural benchmark. No providers, credentials or private inputs.
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { extractIngestionEvidence } from '../src/ingestion/processors.mjs'
import { evaluateIngestionTrial, ingestionEvaluationDigest as digest } from '../src/ingestion/evaluation.mjs'

const examples = [
  { id: 'routine-note', stratum: 'text', split: 'calibration', ref: 'routine.md', text: 'Inspect the belt weekly.', expected: [
    { locator: { kind: 'line', value: '1' }, text: 'Inspect the belt weekly.' },
  ] },
  { id: 'rare-exception', stratum: 'text', split: 'held-out', ref: 'exception.txt', text: 'Inspect weekly except during sealed winter storage.\r\nResume checks before use.', expected: [
    { locator: { kind: 'line', value: '1' }, text: 'Inspect weekly except during sealed winter storage.' },
    { locator: { kind: 'line', value: '2' }, text: 'Resume checks before use.' },
  ] },
  { id: 'quoted-cell', stratum: 'csv', split: 'held-out', ref: 'parts.csv', text: 'part,notes\nfilter,"dry, covered"', expected: [
    { locator: { kind: 'csv-cell', value: 'row:1,column:1' }, text: 'part' },
    { locator: { kind: 'csv-cell', value: 'row:1,column:2' }, text: 'notes' },
    { locator: { kind: 'csv-cell', value: 'row:2,column:1' }, text: 'filter' },
    { locator: { kind: 'csv-cell', value: 'row:2,column:2' }, text: 'dry, covered' },
  ] },
  { id: 'pointer-and-number', stratum: 'json', split: 'held-out', ref: 'readings.json', text: '{"a/b":{"~reading":1.20e2},"ready":false}', expected: [
    { locator: { kind: 'json-pointer', value: '/a~1b/~0reading' }, text: '1.20e2' },
    { locator: { kind: 'json-pointer', value: '/ready' }, text: 'false' },
  ] },
]
const limits = { maxOutputBytes: 65536, maxEvidenceItems: 128 }
const suite = { id: 'synthetic-structural-evidence', revision: '1',
  thresholds: { minimumRecall: 1, maximumUnexpected: 0, maximumFailed: 0 },
  cases: examples.map(({ id, stratum, split, text, expected }) => ({ id, stratum, split,
    sourceDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`, expected })) }
const trial = { id: 'local-deterministic', suiteDigest: digest(suite),
  processor: { id: 'atelier-builtins', version: '1.0.0', configurationDigest: digest(limits) }, currency: 'USD', outcomes: [] }
for (const example of examples) {
  const started = performance.now()
  let status = 'complete'; let evidence = []
  try { evidence = extractIngestionEvidence({ ref: example.ref, bytes: Buffer.from(example.text), limits }).evidence }
  catch { status = 'failed' }
  trial.outcomes.push({ caseId: example.id, sourceDigest: suite.cases.find(c => c.id === example.id).sourceDigest,
    status, evidence, attempts: 1, elapsedMs: performance.now() - started, cost: null, humanAssessment: null })
}
const report = evaluateIngestionTrial({ suite, trial })
console.log(JSON.stringify({ suite, trial, report }, null, 2))
if (!report.structuralThresholdsPassed) process.exitCode = 1
