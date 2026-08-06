import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = path.join(ROOT, 'src', 'commands', 'distribution.mjs')
const ATTRIBUTION = 'powered by MNSTRY Atelier'
const EXT_KEY = 'mnstry.atelier/attribution'

// New CLI command modules are exercised by direct invocation (Stage 3 wires
// the commandMap entry); the spawned env mirrors runCli's dispatch contract.
function runDistribution(args, cwd = ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MNSTRY_ATELIER_PACKAGE_ROOT: ROOT },
  })
}

function makeDistribution({ readme, manifest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-distribution-check-'))
  if (readme !== undefined) fs.writeFileSync(path.join(dir, 'README.md'), readme)
  if (manifest !== undefined) {
    const packDir = path.join(dir, 'packs', 'sample-pack')
    fs.mkdirSync(packDir, { recursive: true })
    fs.writeFileSync(path.join(packDir, 'atelier.pack.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return dir
}

test('check passes when the distribution README carries the exact byte string', () => {
  const dir = makeDistribution({ readme: `# Sample Studio\n\nA distribution, ${ATTRIBUTION}.\n` })
  try {
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /\[atelier-distribution:check\] required README\.md attribution present/)
    assert.match(result.stdout, /distribution check passed/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('check fails with exit 1 and a TRADEMARKS.md pointer when the byte string is absent', () => {
  const dir = makeDistribution({ readme: '# Sample Studio\n\nPowered By MNSTRY atelier (wrong case).\n' })
  try {
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /TRADEMARKS\.md/)
    assert.match(result.stderr, /docs\/attestation\.md/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing README fails the same blocking check', () => {
  const dir = makeDistribution({})
  try {
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md is missing/)
    assert.match(result.stderr, /TRADEMARKS\.md/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('check runs against the cwd when no --target is given', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  try {
    const result = runDistribution(['check'], dir)
    assert.equal(result.status, 0, result.stderr)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('missing pack-manifest attribution key is reported as advisory and never blocks', () => {
  const dir = makeDistribution({
    readme: `${ATTRIBUTION}\n`,
    manifest: { schema: 'mnstry-atelier-extension-pack@v1', id: 'sample.pack' },
  })
  try {
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 0, 'advisory findings must not change the exit code')
    assert.match(result.stdout, /advisory: .*does not declare ext\["mnstry\.atelier\/attribution"\]/)
    assert.match(result.stdout, /TRADEMARKS\.md/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pack-manifest attribution key is reported satisfied when present', () => {
  const dir = makeDistribution({
    readme: `${ATTRIBUTION}\n`,
    manifest: { schema: 'mnstry-atelier-extension-pack@v1', id: 'sample.pack', ext: { [EXT_KEY]: ATTRIBUTION } },
  })
  try {
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /advisory: packs\/sample-pack\/atelier\.pack\.json declares ext\["mnstry\.atelier\/attribution"\] — satisfied/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('advisory key must equal the attribution string exactly, not merely exist', () => {
  const dir = makeDistribution({
    readme: `${ATTRIBUTION}\n`,
    manifest: { ext: { [EXT_KEY]: 'powered by something else' } },
  })
  try {
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /does not declare ext\["mnstry\.atelier\/attribution"\]/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--pack overrides the packs/ convention and accepts a manifest file path', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-pack-override-'))
  try {
    const manifestPath = path.join(packDir, 'atelier.pack.json')
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ext: { [EXT_KEY]: ATTRIBUTION } })}\n`)
    const byDir = runDistribution(['check', '--target', dir, '--pack', packDir])
    assert.equal(byDir.status, 0, byDir.stderr)
    assert.match(byDir.stdout, /declares ext\["mnstry\.atelier\/attribution"\] — satisfied/)
    const byFile = runDistribution(['check', '--target', dir, '--pack', manifestPath])
    assert.equal(byFile.status, 0, byFile.stderr)
    assert.match(byFile.stdout, /declares ext\["mnstry\.atelier\/attribution"\] — satisfied/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(packDir, { recursive: true, force: true })
  }
})

test('an unreadable pack manifest is an advisory note, not a failure', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  try {
    const packDir = path.join(dir, 'packs', 'broken-pack')
    fs.mkdirSync(packDir, { recursive: true })
    fs.writeFileSync(path.join(packDir, 'atelier.pack.json'), '{ not json\n')
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /advisory: .*not readable JSON/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown subcommand exits 2 with usage', () => {
  const result = runDistribution(['frobnicate'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Unknown distribution command: frobnicate/)
  assert.match(result.stderr, /Usage: distribution check/)
})

test('a target that is not a directory exits 2', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  try {
    const result = runDistribution(['check', '--target', path.join(dir, 'README.md')])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /target is not a directory/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bare invocation defaults to the check subcommand', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  try {
    const result = runDistribution([], dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /distribution check passed/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
