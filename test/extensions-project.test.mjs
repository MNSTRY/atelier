import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { scaffoldPostgres, sealProject, validateProject } from '../src/extensions/project.mjs'

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'atelier-extension-project-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { root: dir, project: path.join(dir, 'custom') }
}
test('Postgres project is complete, sealed and generates a native backend without starting it', async t => {
  const { project } = await directory(t)
  const result = await scaffoldPostgres({ directory: project })
  assert.equal(result.qualified, false)
  assert.equal((await validateProject(project)).valid, true)
  const pkg = JSON.parse(await readFile(path.join(project, 'package.json')))
  assert.equal(pkg.dependencies.postgres, '3.4.7')
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit')
  const backend = await readFile(path.join(project, 'src/backend.ts'), 'utf8')
  assert.ok(backend.includes('createRootAdmissionConsumer'))
  assert.ok(!backend.includes('.listen('))
  const manifest = JSON.parse(await readFile(path.join(project, 'extension.manifest.json')))
  const contract = JSON.parse(await readFile(new URL('../contracts/atelier-extension-manifest.v1.schema.json', import.meta.url)))
  const validate = new Ajv2020({ strict: true }).compile(contract)
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors))
  assert.equal(manifest.recovery.lookupActionId, 'counter.lookup')
  assert.equal(manifest.actions.length, 5)
  assert.deepEqual(manifest.compatibility.hosts, ['web'])
})
test('an existing destination is refused without replacing its data', async t => {
  const { project } = await directory(t)
  await scaffoldPostgres({ directory: project })
  const file = path.join(project, 'README.md'); await writeFile(file, 'existing owner data')
  await assert.rejects(scaffoldPostgres({ directory: project }))
  assert.equal(await readFile(file, 'utf8'), 'existing owner data')
})
test('source changes invalidate the seal and explicit resealing preserves the edited source', async t => {
  const { project } = await directory(t)
  await scaffoldPostgres({ directory: project })
  const before = await validateProject(project)
  const file = path.join(project, 'src/backend.ts'); const source = await readFile(file, 'utf8')
  await writeFile(file, source + '\n// Reviewed synthetic edit.\n')
  await assert.rejects(validateProject(project), /stale/)
  await sealProject(project)
  assert.notEqual((await validateProject(project)).releaseDigest, before.releaseDigest)
  assert.equal(await readFile(file, 'utf8'), source + '\n// Reviewed synthetic edit.\n')
})
test('symlinked source and manifest refuse without changing their external targets', async t => {
  const { root, project } = await directory(t)
  await scaffoldPostgres({ directory: project })
  const outside = path.join(root, 'outside.json'); await writeFile(outside, 'synthetic sentinel')
  await symlink(outside, path.join(project, 'src/external.json'))
  await assert.rejects(sealProject(project), /symlink/)
  await rm(path.join(project, 'src/external.json'))
  await rm(path.join(project, 'extension.manifest.json'))
  await symlink(outside, path.join(project, 'extension.manifest.json'))
  await assert.rejects(sealProject(project), /regular/)
  assert.equal(await readFile(outside, 'utf8'), 'synthetic sentinel')
})
test('CLI resolves the real extension command and keeps failures content-free', async t => {
  const { project } = await directory(t)
  const cli = fileURLToPath(new URL('../bin/atelier.mjs', import.meta.url))
  const run = args => spawnSync(process.execPath, [cli, 'extension', ...args], { encoding: 'utf8' })
  const created = run(['init', '--directory', project, '--id', 'sample.counter', '--json'])
  assert.equal(created.status, 0, created.stderr)
  assert.equal(JSON.parse(created.stdout).profile, 'postgres-sql')
  assert.equal(run(['validate', '--directory', project, '--json']).status, 0)
  const refused = run(['init', '--directory', project, '--profile', 'convex-native'])
  assert.equal(refused.status, 1)
  assert.ok(!refused.stderr.includes(project))
})
