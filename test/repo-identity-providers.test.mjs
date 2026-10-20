import assert from 'node:assert/strict'
import childProcess, { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { auditRepoIdentities, githubLookup, identityKey, resolveRepoIdentity } from '../src/project/repo-identity.mjs'

const remoteUrl = 'https://github.com/Acme/Journal.git'
const declaredRepo = { name: 'studio-journal', identity: { provider: 'github', id: '900001' } }

function withProviderCommand(command, run) {
  const original = childProcess.execFileSync
  childProcess.execFileSync = command
  syncBuiltinESMExports()
  try {
    return run()
  } finally {
    childProcess.execFileSync = original
    syncBuiltinESMExports()
  }
}

test('identity imports retain their public exports without starting a provider command', () => {
  const moduleUrl = new URL('../src/project/repo-identity.mjs', import.meta.url).href
  execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const calls = []
    for (const method of ['execFileSync', 'execSync', 'spawnSync', 'execFile', 'exec', 'spawn']) {
      childProcess[method] = (...args) => {
        calls.push(args[0])
        throw new Error('No subprocess is available during import')
      }
    }
    syncBuiltinESMExports()
    const api = await import(${JSON.stringify(moduleUrl)})
    assert.deepEqual(Object.keys(api).sort(), [
      'SUPPORTED_PROVIDERS', 'auditRepoIdentities', 'githubLookup',
      'identityKey', 'parseRemoteRef', 'resolveRepoIdentity',
    ].sort())
    assert.deepEqual(api.SUPPORTED_PROVIDERS, ['github'])
    assert.deepEqual(calls, [])
  `], { encoding: 'utf8' })
})

test('the default GitHub lookup preserves its command and normalized rename identity', () => {
  const calls = []
  withProviderCommand((...args) => {
    calls.push(args)
    return JSON.stringify({ id: 900001, fullName: 'Acme/Studio-Journal' })
  }, () => {
    assert.deepEqual(githubLookup({ owner: 'acme', name: 'journal' }), {
      id: '900001', fullName: 'acme/studio-journal', currentName: 'studio-journal',
    })
    const identity = resolveRepoIdentity(null, { remoteUrl })
    assert.equal(identity.source, 'provider')
    assert.equal(identity.reachable, true)
    assert.equal(identity.renamed, true)
    assert.equal(identity.remoteName, 'journal')
    assert.equal(identity.currentName, 'studio-journal')
    assert.equal(identityKey(identity), 'github:900001')
  })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.deepEqual(call, [
      'gh', ['api', 'repos/acme/journal', '--jq', '{id: .id, fullName: .full_name}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ])
  }
})

test('an explicit empty lookup map keeps all identity fallbacks offline', () => {
  let providerCalls = 0
  withProviderCommand(() => {
    providerCalls += 1
    throw new Error('The disabled provider must not run')
  }, () => {
    const recorded = resolveRepoIdentity(null, { remoteUrl, repo: declaredRepo, lookups: {} })
    assert.equal(recorded.source, 'recorded-identity')
    assert.equal(recorded.id, '900001')
    assert.equal(recorded.currentName, 'studio-journal')
    assert.equal(recorded.reachable, false)

    const alias = resolveRepoIdentity(null, {
      remoteUrl, repo: { name: 'studio-journal', aliases: ['JOURNAL'] }, lookups: {},
    })
    assert.equal(alias.source, 'alias')
    assert.equal(alias.currentName, 'studio-journal')
    assert.equal(alias.renamed, true)

    const remote = resolveRepoIdentity(null, { remoteUrl, lookups: {} })
    assert.equal(remote.source, 'remote-url')
    assert.equal(remote.currentName, 'journal')
    assert.equal(remote.reachable, false)

    const unresolved = resolveRepoIdentity(null, { remoteUrl: '', lookups: {} })
    assert.equal(unresolved.source, 'unresolved')
    assert.equal(unresolved.ok, false)
  })
  assert.equal(providerCalls, 0)
})

test('an injected lookup receives the recorded ref without calling the default provider', () => {
  const refs = []
  let providerCalls = 0
  withProviderCommand(() => {
    providerCalls += 1
    throw new Error('Injected lookup must replace the default provider')
  }, () => {
    const identity = resolveRepoIdentity(null, {
      remoteUrl,
      lookups: {
        github: (ref) => {
          refs.push(ref)
          return { id: '900001', fullName: 'acme/studio-journal', currentName: 'studio-journal' }
        },
      },
    })
    assert.equal(identity.source, 'provider')
    assert.equal(identityKey(identity), 'github:900001')
    assert.deepEqual(refs, [{ host: 'github.com', provider: 'github', owner: 'acme', name: 'journal' }])
  })
  assert.equal(providerCalls, 0)
})

test('unknown hosts stay on the remote fallback without invoking GitHub', () => {
  let providerCalls = 0
  withProviderCommand(() => {
    providerCalls += 1
    throw new Error('Unknown hosts must not invoke GitHub')
  }, () => {
    const identity = resolveRepoIdentity(null, { remoteUrl: 'https://git.example.test/acme/journal.git' })
    assert.equal(identity.provider, null)
    assert.equal(identity.source, 'remote-url')
    assert.equal(identity.currentName, 'journal')
    assert.equal(identity.reachable, false)
  })
  assert.equal(providerCalls, 0)
})

for (const [label, response] of [
  ['unavailable command', () => { throw Object.assign(new Error('Unavailable'), { code: 'ENOENT' }) }],
  ['provider refusal', () => { throw Object.assign(new Error('Refused'), { status: 1 }) }],
  ['malformed JSON', () => 'not json'],
  ['missing stable id', () => JSON.stringify({ fullName: 'acme/studio-journal' })],
  ['null response', () => 'null'],
]) {
  test(`${label} returns no lookup result and retains recorded identity`, () => {
    withProviderCommand(response, () => {
      assert.equal(githubLookup({ owner: 'acme', name: 'journal' }), null)
      const identity = resolveRepoIdentity(null, { remoteUrl, repo: declaredRepo })
      assert.equal(identity.id, '900001')
      assert.equal(identity.source, 'recorded-identity')
      assert.equal(identity.reachable, false)
      assert.equal(identity.renamed, false)
    })
  })
}

test('identity auditing honors an empty lookup map without requiring gh', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-provider-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', root])
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remoteUrl])
  let providerCalls = 0
  withProviderCommand(() => {
    providerCalls += 1
    throw new Error('The disabled provider must not run')
  }, () => {
    const audit = auditRepoIdentities({ repos: [{ ...declaredRepo, path: root }] }, { lookups: {} })
    assert.equal(audit.ok, true)
    assert.deepEqual(audit.findings, [])
  })
  assert.equal(providerCalls, 0)
})
