// Replay of the demonstrated N2 defect: `readiness protocols` only honored a
// parsed --project flag, contradicting the help text's promise that every
// project-aware command accepts --project-config=PATH or the
// MNSTRY_ATELIER_PROJECT_CONFIG env var. The subcommand must be project-aware
// for all three explicit forms, and a bare invocation must stay bundled-only
// — never auto-detecting a project from the cwd.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeSampleProject } from './helpers/sample-project.mjs'
import { runReadinessCommand } from '../src/readiness/readiness.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACK_FIXTURES = path.join(ROOT, 'fixtures', 'atelier-extension-pack')
const ENV_VAR = 'MNSTRY_ATELIER_PROJECT_CONFIG'
const PACK_PROTOCOL_ID = 'sample.readiness:contract-gate'

function makePackProject(t) {
  const sample = makeSampleProject(t)
  fs.mkdirSync(path.join(sample.dir, 'packs', 'protocols'), { recursive: true })
  fs.copyFileSync(
    path.join(PACK_FIXTURES, 'valid', 'sample-pack.v1.json'),
    path.join(sample.dir, 'packs', 'sample.readiness.v1.json'),
  )
  fs.copyFileSync(
    path.join(PACK_FIXTURES, 'valid', 'protocols', 'contract-gate.v1.json'),
    path.join(sample.dir, 'packs', 'protocols', 'contract-gate.v1.json'),
  )
  const config = JSON.parse(fs.readFileSync(sample.config, 'utf8'))
  config.ext = {
    'mnstry.atelier': {
      extensionPacks: [
        { id: 'sample.readiness', version: 'v1', path: 'packs/sample.readiness.v1.json', enabled: true },
      ],
    },
  }
  fs.writeFileSync(sample.config, `${JSON.stringify(config, null, 2)}\n`)
  return sample
}

// Direct runReadinessCommand invocation with console.log captured.
function captureProtocols(argv) {
  const lines = []
  const original = console.log
  console.log = (line) => lines.push(String(line))
  try {
    runReadinessCommand(argv)
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, ENV_VAR)
  const previous = process.env[ENV_VAR]
  if (value === undefined) delete process.env[ENV_VAR]
  else process.env[ENV_VAR] = value
  try {
    return fn()
  } finally {
    if (had) process.env[ENV_VAR] = previous
    else delete process.env[ENV_VAR]
  }
}

function listedProtocolIds(argv) {
  const output = captureProtocols(argv)
  const doc = JSON.parse(output)
  assert.equal(doc.schema, 'mnstry.readiness-protocol-list@v1')
  return doc.protocols
}

test('protocols with --project PATH lists the pack protocols with a source marker', (t) => {
  const sample = makePackProject(t)
  withEnv(undefined, () => {
    const protocols = listedProtocolIds(['protocols', '--json', '--project', sample.config])
    const packEntry = protocols.find((protocol) => protocol.id === PACK_PROTOCOL_ID)
    assert.ok(packEntry, 'pack protocol must be listed')
    assert.equal(packEntry.source, 'sample.readiness')
  })
})

test('protocols with --project-config=PATH is project-aware, matching the help text', (t) => {
  const sample = makePackProject(t)
  withEnv(undefined, () => {
    const protocols = listedProtocolIds(['protocols', '--json', `--project-config=${sample.config}`])
    assert.ok(protocols.some((protocol) => protocol.id === PACK_PROTOCOL_ID))
  })
})

test('protocols honors the MNSTRY_ATELIER_PROJECT_CONFIG env var without any argv flag', (t) => {
  const sample = makePackProject(t)
  withEnv(sample.config, () => {
    const protocols = listedProtocolIds(['protocols', '--json'])
    assert.ok(
      protocols.some((protocol) => protocol.id === PACK_PROTOCOL_ID),
      'env-configured project packs must be listed',
    )
    // Human-readable listing carries the source marker too.
    const text = captureProtocols(['protocols'])
    assert.match(text, /sample\.readiness:contract-gate.*\(source: sample\.readiness\)/)
  })
})

test('bare protocols stays bundled-only and never auto-detects a project from the cwd', (t) => {
  const sample = makePackProject(t)
  const previousCwd = process.cwd()
  t.after(() => process.chdir(previousCwd))
  // Run from inside a directory that DOES contain a resolvable
  // atelier.project.json with packs: a cwd auto-detect would list the pack
  // protocol (or throw); bundled-only must list none.
  process.chdir(sample.dir)
  withEnv(undefined, () => {
    const protocols = listedProtocolIds(['protocols', '--json'])
    assert.ok(protocols.length > 0, 'bundled protocols must still be listed')
    assert.equal(protocols.some((protocol) => protocol.id === PACK_PROTOCOL_ID), false)
    assert.equal(protocols.some((protocol) => 'source' in protocol), false)
  })
})
