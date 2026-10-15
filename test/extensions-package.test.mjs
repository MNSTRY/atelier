import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
test('packed extension API has its exact declarations and imports from an isolated consumer', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atelier-extension-package-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--cache', path.join(dir, 'cache'), '--pack-destination', dir], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  }))
  const destination = path.join(dir, 'node_modules/@mnstry/atelier')
  await mkdir(destination, { recursive: true })
  execFileSync('tar', ['-xzf', path.join(dir, pack.filename), '--strip-components=1', '-C', destination])
  const pkg = JSON.parse(await readFile(path.join(destination, 'package.json')))
  for (const name of ['contracts', 'client', 'server', 'postgres']) {
    assert.ok(pack.files.some(file => file.path === `src/extensions/${name}.d.mts`))
    assert.ok(pack.files.some(file => file.path === `src/extensions/${name}.mjs`))
  }
  assert.equal(pkg.dependencies?.postgres, undefined)
  const file = path.join(dir, 'consumer.mjs')
  await writeFile(file, `import assert from 'node:assert/strict';
    import { canonicalJson } from '@mnstry/atelier/extensions';
    import { createExtensionClient } from '@mnstry/atelier/extensions/client';
    import { assertVerifiedScope } from '@mnstry/atelier/extensions/server';
    import { withPostgresScope } from '@mnstry/atelier/extensions/postgres';
    assert.equal(canonicalJson({b:2,a:1}), '{"a":1,"b":2}');
    assert.equal(typeof createExtensionClient, 'function');
    assert.throws(() => assertVerifiedScope({}));
    assert.equal(typeof withPostgresScope, 'function');
    await assert.rejects(import('@mnstry/atelier/src/extensions/server.mjs'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`)
  execFileSync(process.execPath, [file], { cwd: dir, timeout: 10000 })
})
