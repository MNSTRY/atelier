import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { execNpmSync } from '../scripts/npm-cli.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
test('packed extension API has its exact declarations and imports from an isolated consumer', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atelier-extension-package-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const [pack] = JSON.parse(execNpmSync(['pack', '--json', '--ignore-scripts', '--cache', path.join(dir, 'cache'), '--pack-destination', dir], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  }))
  const destination = path.join(dir, 'node_modules/@mnstry/atelier')
  await mkdir(destination, { recursive: true })
  execFileSync('tar', ['-xzf', path.join(dir, pack.filename), '--strip-components=1', '-C', destination])
  const pkg = JSON.parse(await readFile(path.join(destination, 'package.json')))
  for (const name of ['contracts', 'client', 'server', 'postgres', 'drizzle', 'prisma', 'convex']) {
    assert.ok(pack.files.some(file => file.path === `src/extensions/${name}.d.mts`))
    assert.ok(pack.files.some(file => file.path === `src/extensions/${name}.mjs`))
  }
  for(const name of ['postgres','drizzle-orm','drizzle-kit','prisma','@prisma/client','@prisma/adapter-pg','pg','convex']) assert.equal(pkg.dependencies?.[name], undefined)
  const file = path.join(dir, 'consumer.mjs')
  await writeFile(file, `import assert from 'node:assert/strict';
    import { canonicalJson } from '@mnstry/atelier/extensions';
    import { createExtensionClient } from '@mnstry/atelier/extensions/client';
    import { assertVerifiedScope } from '@mnstry/atelier/extensions/server';
    import { withPostgresScope } from '@mnstry/atelier/extensions/postgres';
    import { withDrizzleScope } from '@mnstry/atelier/extensions/drizzle';
    import { withPrismaScope } from '@mnstry/atelier/extensions/prisma';
    import { convexDigest } from '@mnstry/atelier/extensions/convex';
    assert.equal(await convexDigest({a:1}), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
    assert.equal(canonicalJson({b:2,a:1}), '{"a":1,"b":2}');
    assert.equal(typeof createExtensionClient, 'function');
    assert.throws(() => assertVerifiedScope({}));
    assert.equal(typeof withPostgresScope, 'function');
    assert.equal(typeof withDrizzleScope, 'function');assert.equal(typeof withPrismaScope, 'function');
    await assert.rejects(import('@mnstry/atelier/src/extensions/server.mjs'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`)
  execFileSync(process.execPath, [file], { cwd: dir, timeout: 10000 })
})
