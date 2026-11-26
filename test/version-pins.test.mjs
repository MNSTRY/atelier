import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkVersionPinsInRoot, findVersionPinDrift } from '../scripts/check-version-pins.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('version pin checker accepts matching npm and git tag pins while ignoring historical prose', () => {
  const findings = findVersionPinDrift({
    expectedVersion: '0.3.0',
    files: [
      {
        path: 'README.md',
        content: [
          'Documents valid against v0.2.0-alpha.0 stay valid.',
          'Shipped since 0.2.0-alpha.13.',
          'npm install --save-dev @mnstry/atelier@0.3.0',
        ].join('\n'),
      },
      {
        path: 'docs/start/install.md',
        content: [
          'npm install --save-dev @mnstry/atelier@0.3.0',
          'npm install --save-dev "git+https://github.com/MNSTRY/atelier.git#v0.3.0"',
        ].join('\n'),
      },
    ],
  })
  assert.deepEqual(findings, [])
})

test('version pin checker catches stale npm and git pins', () => {
  const findings = findVersionPinDrift({
    expectedVersion: '0.3.0',
    files: [
      {
        path: 'README.md',
        content: 'npm install --save-dev @mnstry/atelier@0.2.0-alpha.14\n',
      },
      {
        path: 'docs/start/install.md',
        content: 'npm install --save-dev "git+https://github.com/MNSTRY/atelier.git#v0.2.0-alpha.25"\n',
      },
    ],
  })
  assert.equal(findings.length, 2)
  assert.match(findings[0], /README\.md:1 npm pin points at 0\.2\.0-alpha\.14, expected 0\.3\.0/)
  assert.match(findings[1], /docs\/start\/install\.md:1 git tag pin points at 0\.2\.0-alpha\.25, expected 0\.3\.0/)
})

test('version pin checker ignores trailing sentence punctuation and flags missing files when required', () => {
  const findings = findVersionPinDrift({
    expectedVersion: '0.3.0',
    files: [
      {
        path: 'README.md',
        content: 'Current package: @mnstry/atelier@0.3.0.\n',
      },
    ],
  })
  assert.deepEqual(findings, [])

  const missingFindings = checkVersionPinsInRoot(join(packageRoot, 'nonexistent-dir'), '0.3.0', { requireAllFiles: true })
  assert.ok(missingFindings.some((f) => f.includes('README.md is missing')))
})

test('current repository entry docs match package.json version', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const findings = checkVersionPinsInRoot(packageRoot, pkg.version, { requireAllFiles: true })
  assert.deepEqual(findings, [])
})
