import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// A minimal probe-able bin whose --version output carries the attribution,
// for tests whose subject is something other than the bin rule (a packs/
// marker makes the bin probe mandatory).
function withPassingBin(dir) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'bin', 'sample.mjs'), `console.log('Sample Studio 1.0.0 — ${ATTRIBUTION} 0.0.0')\n`)
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'sample-studio', version: '1.0.0', bin: { sample: 'bin/sample.mjs' } }, null, 2)}\n`)
  return dir
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
  const dir = withPassingBin(makeDistribution({
    readme: `${ATTRIBUTION}\n`,
    manifest: { schema: 'mnstry-atelier-extension-pack@v1', id: 'sample.pack' },
  }))
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
  const dir = withPassingBin(makeDistribution({
    readme: `${ATTRIBUTION}\n`,
    manifest: { schema: 'mnstry-atelier-extension-pack@v1', id: 'sample.pack', ext: { [EXT_KEY]: ATTRIBUTION } },
  }))
  try {
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /advisory: packs\/sample-pack\/atelier\.pack\.json declares ext\["mnstry\.atelier\/attribution"\] — satisfied/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('advisory key must equal the attribution string exactly, not merely exist', () => {
  const dir = withPassingBin(makeDistribution({
    readme: `${ATTRIBUTION}\n`,
    manifest: { ext: { [EXT_KEY]: 'powered by something else' } },
  }))
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
  const dir = withPassingBin(makeDistribution({ readme: `${ATTRIBUTION}\n` }))
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

// Writes a distribution bin that wraps the real runCli. With swallow: true it
// injects no-op stdout/stderr writers — the demonstrated M6 attack, where the
// wrapper suppresses the attribution that --version output carries.
function writeWrapperBin(dir, { swallow }) {
  const pkg = { name: 'wrapper-dist', version: '1.0.0', type: 'module', bin: { shadowtool: 'bin/shadowtool.mjs' } }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  const runCliUrl = pathToFileURL(path.join(ROOT, 'src', 'cli', 'run.mjs')).href
  const streamOverrides = swallow ? '\n  stdout: () => {},\n  stderr: () => {},' : ''
  fs.writeFileSync(path.join(dir, 'bin', 'shadowtool.mjs'), `import { runCli } from ${JSON.stringify(runCliUrl)}
const code = await runCli({
  argv: process.argv.slice(2),
  brand: { command: 'shadowtool', displayName: 'Shadow Tool', version: '9.9.9' },${streamOverrides}
})
process.exit(code)
`)
}

// Replay of the demonstrated M6 attack: runCli's injected writers let a
// wrapper swallow every attribution line. The blocking bin probe spawns the
// declared bin with --version over real pipes, so the suppression is caught.
test('a wrapper bin that swallows runCli output fails the blocking bin probe', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  try {
    writeWrapperBin(dir, { swallow: true })
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 1, 'stream-swallowing wrapper must block')
    assert.match(result.stderr, /--version stdout does not contain the exact byte string/)
    assert.match(result.stderr, /TRADEMARKS\.md/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an honest wrapper bin passes the blocking bin probe', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  try {
    writeWrapperBin(dir, { swallow: false })
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /declared bin --version output carries the required attribution/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a declared bin that cannot be resolved is a blocking failure', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'ghost-dist', bin: { ghost: 'bin/missing.mjs' } })}\n`)
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /declared bin "ghost" cannot be resolved/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a package without any declared bin is only an advisory note', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'library-dist', version: '1.0.0' })}\n`)
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /advisory: no package\.json bin declared and no distribution markers; CLI attribution probe skipped/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Replay of the demonstrated N7 defect: `check --target` with no value used
// to fall through to a silent cwd check. Both value-taking flags must be a
// usage error (exit 2) when left valueless.
test('--target and --pack without a value are usage errors, never a silent cwd check', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  try {
    // cwd carries a passing README, so exit 2 proves no silent cwd fallback.
    const target = runDistribution(['check', '--target'], dir)
    assert.equal(target.status, 2)
    assert.match(target.stderr, /--target requires a value/)
    assert.match(target.stderr, /Usage: distribution check/)
    const pack = runDistribution(['check', '--pack'], dir)
    assert.equal(pack.status, 2)
    assert.match(pack.stderr, /--pack requires a value/)
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

// G1: the CLI attribution probe must not be opt-out-able by a target that
// looks like a distribution. Six dodge shapes, all against a target carrying
// a distribution marker (packs/), all blocking.
test('a distribution-shaped target cannot dodge the bin probe', (t) => {
  const dodges = [
    ['no bin key', { name: 'dodger', version: '1.0.0' }],
    ['empty bin object', { name: 'dodger', bin: {} }],
    ['whitespace-only bin entry', { name: 'dodger', bin: { s: '   ' } }],
    ['bin as array', { name: 'dodger', bin: ['x.mjs'] }],
  ]
  for (const [label, pkg] of dodges) {
    const dir = makeDistribution({ readme: `${ATTRIBUTION}\n`, manifest: { schema: 'mnstry-atelier-extension-pack@v1' } })
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    const result = runDistribution(['check', '--target', dir])
    assert.equal(result.status, 1, `${label} must be blocking, got exit ${result.status}`)
    assert.match(result.stdout + result.stderr, /no probe-able bin/, label)
  }

  // No package.json at all, but packs/ marker present — blocking.
  const bare = makeDistribution({ readme: `${ATTRIBUTION}\n`, manifest: { schema: 'mnstry-atelier-extension-pack@v1' } })
  const bareResult = runDistribution(['check', '--target', bare])
  assert.equal(bareResult.status, 1, 'marker without manifest must be blocking')

  // Malformed package.json — blocking, distinguishable from absent.
  const malformed = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  fs.writeFileSync(path.join(malformed, 'package.json'), '{ not json')
  const malformedResult = runDistribution(['check', '--target', malformed])
  assert.equal(malformedResult.status, 1, 'malformed manifest must be blocking')
  assert.match(malformedResult.stdout + malformedResult.stderr, /does not parse/)
})

test('a markerless target without a bin still gets the advisory skip', () => {
  const dir = makeDistribution({ readme: `${ATTRIBUTION}\n` })
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'plain-lib', version: '1.0.0' }, null, 2)}\n`)
  const result = runDistribution(['check', '--target', dir])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /probe skipped/)
})
