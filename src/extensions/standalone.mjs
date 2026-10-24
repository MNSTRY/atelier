import { readFile, mkdir, lstat, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ExtensionError } from './contracts.mjs'

const local = `import { canonicalJson, exact, ExtensionError } from '@mnstry/atelier/extensions'

export function counter(value: unknown): { value: number } {
  const input = exact(value, ['value'])
  if (!Number.isSafeInteger(input.value) || Number(input.value) < 0 || Number(input.value) > 1000000)
    throw new ExtensionError('invalid-input')
  return { value: Number(input.value) }
}
/** Process-local application data. It is never a Root identity or VerifiedScope. */
export function createLocalCounter(initial = 0) {
  let state = canonicalJson(counter({ value: initial }))
  return Object.freeze({
    mode: 'unbound' as const,
    get: () => counter(JSON.parse(state)),
    set: (value: number) => { state = canonicalJson(counter({ value })); return counter(JSON.parse(state)) },
  })
}
`
const bound = `import { canonicalJson, ExtensionError, parseInstallationBinding, parseManifest,
  type ExtensionManifest, type InstallationBinding } from '@mnstry/atelier/extensions'
import { createExtensionClient, createHttpHostTransport } from '@mnstry/atelier/extensions/client'
import { releaseDigest } from '@mnstry/atelier/extensions/server'
import { counter } from './local.js'

/** The host supplies its authenticated fetch and an EXISTING admitted installation.
 * This sample never registers, configures, enables, grants consent or invents identity. */
export async function bindRootCounter(options: { manifest: ExtensionManifest; installation: InstallationBinding; hostFetch: typeof fetch }) {
  const manifest = parseManifest(options.manifest)
  const installation = Object.freeze(parseInstallationBinding(options.installation))
  if (manifest.releaseDigest !== releaseDigest(manifest) || installation.releaseDigest !== manifest.releaseDigest)
    throw new ExtensionError('stale-installation', 409)
  for (const [id, effect] of [['counter.get', 'read'], ['counter.set', 'write']] as const) {
    if (!manifest.actions.some(action => action.id === id && action.effect === effect && action.scope === 'member'))
      throw new ExtensionError('invalid-input')
  }
  const client = createExtensionClient(createHttpHostTransport(options.hostFetch))
  const check = async () => {
    if (canonicalJson(await client.getInstallation(installation.installationId)) !== canonicalJson(installation))
      throw new ExtensionError('stale-installation', 409)
  }
  await check()
  return Object.freeze({
    mode: 'root-bound' as const,
    get: async (idempotencyKey: string) => { await check(); return client.invoke(installation, 'counter.get', {}, idempotencyKey) },
    set: async (value: number, idempotencyKey: string) => {
      const input = counter({ value }); await check(); return client.invoke(installation, 'counter.set', input, idempotencyKey)
    },
  })
}
`
const main = `import { canonicalJson } from '@mnstry/atelier/extensions'
import { createLocalCounter } from './local.js'

const value = process.argv[2] === undefined ? 7 : Number(process.argv[2])
const app = createLocalCounter()
app.set(value)
console.log(canonicalJson({ mode: app.mode, result: app.get(), storage: 'process-local', rootAuthority: false }))
`
const readme = `# Standalone counter app

This TypeScript app runs with Node and the installed public Atelier SDK. It
uses process-local memory and starts no network listener or database. Its
unbound mode has no MNSTRY authority, installation, identity, consent or grants.
Run npm install, npm run typecheck, then npm start -- 19. Keep the dependency lock.
For an unpublished SDK candidate, explicitly install the owner-supplied tarball
instead of resolving an unpublished version from a registry. Record its digest.

src/root.ts contains a separate optional binding. Your host must supply its
supported authenticated fetch, a verified release manifest from the existing
sealed extension project, and the exact existing installation binding. Supply
those to bindRootCounter; do not send credentials to the counter provider directly.
The existing provider scaffold still verifies delegation and consumes Root
admission. Root still enforces membership, consent, enablement and scope.

The binding fetches the current installation and pins generation and release.
It checks again before every invocation and never silently refreshes or retries.
get and set require caller-chosen idempotency keys and return the SDK operation
receipt; inspect pending/unknown/failed states. Reconcile a lost write through
the supported lookup/recovery workflow before deciding on another operation.
The sample exposes no admin transition or result-recording shortcut.

Binding changes authority and storage: local memory is not migrated or uploaded.
Use a separately reviewed import path if you need to transfer local data.
This scaffold proves no real Root admission, database, host or customer journey.
`

/** Generate a fresh local app; never adopt or overwrite an existing directory. */
export async function scaffoldStandaloneProject({ directory, applicationId = 'sample.counter-app' }) {
  if (typeof directory !== 'string' || !directory || typeof applicationId !== 'string' || applicationId.length > 128 ||
      !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(applicationId)) throw new ExtensionError('invalid-input')
  const target = path.resolve(directory)
  await mkdir(target)
  const identity = await lstat(target)
  try {
    const kit = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    const files = {
      'package.json': JSON.stringify({ name: applicationId, version: '1.0.0', private: true, type: 'module',
        scripts: { typecheck: 'tsc --noEmit', build: 'tsc', start: 'npm run build && node dist/main.js' },
        dependencies: { '@mnstry/atelier': kit.version }, devDependencies: { typescript: '5.8.3', '@types/node': '22.18.0' },
        engines: { node: '>=22.18.0 <23' } }, null, 2) + '\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext',
        moduleResolution: 'NodeNext', outDir: 'dist', rootDir: 'src', skipLibCheck: true }, include: ['src/**/*.ts'] }, null, 2) + '\n',
      'src/local.ts': local, 'src/root.ts': bound, 'src/main.ts': main, 'README.md': readme,
      '.gitignore': 'node_modules/\ndist/\n.env\n.env.*\n',
    }
    for (const [relative, bytes] of Object.entries(files)) {
      const file = path.join(target, relative)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, bytes, { flag: 'wx' })
    }
    return { directory: target, applicationId, mode: 'unbound', rootAuthority: false, qualified: false }
  } catch (error) {
    const current = await lstat(target).catch(() => null)
    if (current?.isDirectory() && current.dev === identity.dev && current.ino === identity.ino) await rm(target, { recursive: true })
    throw error
  }
}
