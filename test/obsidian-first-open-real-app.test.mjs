import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Opt-in: `atelier obsidian open` against a real, isolated, disposable
// Obsidian, in the two states of the app a first open meets on a desktop, and
// with a vault listed at a folder above the view's vault. It opens application
// windows, so it never runs by default:
//
//   ATELIER_OBSIDIAN_FIRST_OPEN=1 [ATELIER_OBSIDIAN_ASAR=<pinned app build>] node --test test/obsidian-first-open-real-app.test.mjs
//
// The app is reached only through its private HOME, its process table is read
// by its own profile, and URLs are handed to it directly (see
// test/support/obsidian-open/isolated-app.mjs): an Obsidian the person runs on
// the same desktop is never seen or touched. The command, the opening flow,
// the app probe, the vault registry and the maintenance service are the
// production ones; the service entry differs only in that process probe.

const ENABLED = process.env.ATELIER_OBSIDIAN_FIRST_OPEN === '1'
// Qualified on macOS only (see test/support/obsidian-open/isolated-app.mjs).
const SKIP = !ENABLED ? 'set ATELIER_OBSIDIAN_FIRST_OPEN=1 on a macOS desktop with Obsidian installed; opens application windows' : process.platform !== 'darwin' ? 'the isolated app is qualified on macOS only' : false
const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SERVICE_ENTRY = path.join(REPOSITORY_ROOT, 'test', 'support', 'obsidian-open', 'isolated-service-entry.mjs')
const EXT = 'mnstry.atelier.obsidian'
const SCOPE = 'scope-whole'

const note = ({ id, title, body }) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n\n${body}\n`
const FILES = {
  'east-wing/notes/lantern.md': note({ id: 'east-wing:lantern', title: 'Lantern room', body: 'The lamp turns once a minute. See the [compass](compass.md).' }),
  'east-wing/notes/compass.md': note({ id: 'east-wing:compass', title: 'Compass rose', body: 'North is painted red.' }),
  'west-wing/logs/tide.md': note({ id: 'west-wing:tide', title: 'Tide log', body: 'High water at noon.' }),
}

// A synthetic project beside the isolated app, and the command run in this process with the production decisions.
async function projectBeside(app) {
  const [{ writeJson }, { runObsidianCommand }, { createProductionAppProbe, createProductionAppRegistry }] = await Promise.all([
    import('../src/project/config.mjs'), import('../src/commands/obsidian.mjs'), import('../src/runtime/obsidian/app-production-seams.mjs'),
  ])
  const projectDir = path.join(app.root, 'project')
  const dataRoot = path.join(app.root, 'data')
  for (const [relative, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, relative)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, relative), content)
  }
  for (const name of ['east-wing', 'west-wing']) fs.mkdirSync(path.join(projectDir, name, '.git'), { recursive: true })
  const configPath = path.join(projectDir, 'atelier.project.json')
  writeJson(configPath, {
    schema: 'mnstry.atelier-project-config@v1', name: 'first-open-fixture', roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: ['east-wing', 'west-wing'].map((name) => ({ name, path: name, readBoundary: 'team' })),
    ext: { [EXT]: { schema: 'atelier-obsidian-ext-settings/v1', enabled: true, scopes: [{ scopeId: SCOPE, mode: 'full', selector: { all: true } }] } },
  })
  writeJson(path.join(projectDir, 'repo-access.v1.json'), { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: { 'east-wing': { readBoundary: 'team' }, 'west-wing': { readBoundary: 'team' } } })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = app.env
  const seams = {
    appProbe: createProductionAppProbe({ env, processProbe: app.processProbe, cliPath: app.cliPath }), registry: createProductionAppRegistry({ env, processProbe: app.processProbe, cliPath: app.cliPath }), launcher: app.launcher,
    service: { entryPath: SERVICE_ENTRY, entryArgs: [`--isolated-profile=${app.userDataDir}`] },
  }
  const run = async (argv) => {
    const out = []
    await runObsidianCommand({ argv: [...argv, '--json', `--project=${configPath}`, `--data-root=${dataRoot}`], seams, env, cwd: projectDir, stdout: (text) => out.push(text), stderr: () => {}, open: { appWaitMs: 60000 } })
    return JSON.parse(out.join('\n'))
  }
  const configured = await run(['audience', 'set', 'team'])
  assert.deepEqual(configured.audienceAllow, ['team'])
  return { projectDir, dataRoot, run, registry: seams.registry, appProbe: seams.appProbe }
}

const { vaultRoute } = await import('../src/projection/obsidian/publication/vault-list.mjs')

// The app's own list, asked again while it does not answer, for at most `withinMs`: right after a new vault window
// opens, a command-line call can wait out its timeout once.
async function listedWithin(registry, { withinMs = 60000 } = {}) {
  const until = Date.now() + withinMs
  for (;;) {
    const listed = await registry.listThroughApp()
    if (listed.answered || Date.now() >= until) return listed
    await new Promise((resolve) => { setTimeout(resolve, 1000) })
  }
}

async function journalModes(dataRoot) {
  const { createRecoveryStore, journalDetail, listJournals } = await import('../src/projection/obsidian/recovery/index.mjs')
  const [workspaceId] = fs.readdirSync(path.join(dataRoot, 'obsidian'))
  const store = createRecoveryStore({ workspaceRoot: fs.realpathSync(path.join(dataRoot, 'obsidian', workspaceId)), workspaceId, scopeId: SCOPE, repositoryRoots: [] })
  return { store, modes: listJournals(store).map((journal) => journalDetail(journal.document()).mode) }
}

test('real isolated Obsidian: open adds the view\'s vault and publishes, with the app running on another vault, with the app quit, and below a vault listed at a folder above it, and is current with no step by hand',
  { skip: SKIP, timeout: 900000 }, async (t) => {
    const { createIsolatedApp } = await import('./support/obsidian-open/isolated-app.mjs')

    await t.test('app running with an unrelated vault: the vault is added through the app, which opens it, and the first publication runs through the app', async () => {
      const unrelated = 'a1b2c3d4e5f60718'
      const app = createIsolatedApp({ vaults: {} })
      const unrelatedVault = path.join(app.root, 'unrelated-vault')
      fs.mkdirSync(unrelatedVault)
      fs.writeFileSync(path.join(unrelatedVault, 'Somebody else.md'), '# A vault this suite does not own\n')
      fs.writeFileSync(app.settingsFile, JSON.stringify({ vaults: { [unrelated]: { path: unrelatedVault, ts: Date.now(), open: true } }, cli: true, updateDisabled: true }))
      let world = null
      try {
        t.diagnostic(`isolated app ${await app.launch()} with an unrelated vault open`)
        world = await projectBeside(app)
        const started = Date.now()
        const opened = await world.run(['open', '--consent-actor', 'real-app-suite'])
        t.diagnostic(`open answered ${opened.outcome} (${opened.reason}) in ${Date.now() - started} ms; registration ${JSON.stringify(opened.registration ?? null)}`)
        assert.deepEqual([opened.outcome, opened.ok, opened.launched, opened.registration?.how], ['current', true, true, 'added-through-app'], JSON.stringify(opened, null, 2))
        const { store, modes } = await journalModes(world.dataRoot)
        t.diagnostic(`publications: ${JSON.stringify(modes)}`)
        assert.ok(modes.length >= 1 && modes.every((mode) => mode === 'in-app'), 'every publication ran through the app; nothing was written beside a running app')
        const listed = await listedWithin(world.registry)
        assert.equal(listed.answered, true)
        const ours = Object.values(listed.vaults).filter((entry) => fs.realpathSync(entry.path) === store.vaultRoot)
        assert.equal(ours.length, 1, 'the app lists the vault once')
        assert.ok(Object.hasOwn(listed.vaults, unrelated), 'the unrelated vault stays in the app\'s list')
        assert.equal(listed.vaults[unrelated].open, true, 'the unrelated vault\'s window stayed open: the view\'s vault opened in a new window')
        const route = vaultRoute({ vaults: listed.vaults, vaultRoot: store.vaultRoot })
        assert.equal(route.how, 'id', JSON.stringify(route))
        assert.deepEqual(await world.appProbe.vaultState({ vaultRoot: store.vaultRoot, route }), { answered: true, indexReady: true })
        assert.equal(fs.readdirSync(app.userDataDir).some((name) => name.includes('atelier-backup')), false, 'the running app\'s settings file was not written by Atelier')
        assert.equal(opened.readBack.intact, true)
        assert.ok(opened.readBack.noteCount >= 3)
      } finally {
        if (world) { const stopped = (await world.run(['service', 'stop'])).service; t.diagnostic(`service: ${stopped?.reason ?? JSON.stringify(stopped)}`); assert.equal(stopped?.stopped, true, 'the service this suite started is stopped') }
        assert.deepEqual(await app.quit(), [], 'the isolated app is gone')
        if (process.env.ATELIER_OBSIDIAN_FIRST_OPEN_KEEP !== '1') app.remove(); else t.diagnostic(`kept ${app.root}`)
      }
    })

    await t.test('app not running: the view is published directly, added to the app\'s settings with a backup, and the app is started on it', async () => {
      const app = createIsolatedApp({ vaults: {} })
      const unrelatedVault = path.join(app.root, 'unrelated-vault')
      fs.mkdirSync(unrelatedVault)
      // Obsidian has run on this account before: it left its settings, with one vault it knows.
      const before = JSON.stringify({ vaults: { f0e1d2c3b4a59687: { path: unrelatedVault, ts: 1700000000000 } }, cli: true, updateDisabled: true, suiteMarker: 'kept' })
      fs.writeFileSync(app.settingsFile, before)
      let world = null
      try {
        assert.equal(app.running(), false)
        world = await projectBeside(app)
        const started = Date.now()
        const opened = await world.run(['open', '--consent-actor', 'real-app-suite'])
        t.diagnostic(`open answered ${opened.outcome} (${opened.reason}) in ${Date.now() - started} ms; registration ${JSON.stringify(opened.registration ?? null)}`)
        assert.deepEqual([opened.outcome, opened.ok, opened.launched, opened.registration?.how], ['current', true, true, 'added-to-settings'], JSON.stringify(opened, null, 2))
        const { store, modes } = await journalModes(world.dataRoot)
        t.diagnostic(`publications: ${JSON.stringify(modes)}`)
        assert.deepEqual(modes, ['direct'], 'the first publication ran with no app, before the app was started')
        const backups = fs.readdirSync(app.userDataDir).filter((name) => name.startsWith('obsidian.json.atelier-backup-'))
        assert.equal(backups.length, 1)
        assert.equal(fs.readFileSync(path.join(app.userDataDir, backups[0]), 'utf8'), before, 'the backup holds the settings as they were')
        const after = JSON.parse(fs.readFileSync(app.settingsFile, 'utf8'))
        assert.deepEqual([after.suiteMarker, after.cli, after.vaults.f0e1d2c3b4a59687.path], ['kept', true, unrelatedVault], 'the app kept every other setting and vault')
        assert.equal(Object.values(after.vaults).filter((entry) => entry.path === store.vaultRoot).length, 1)
        assert.equal(app.running(), true, 'open started the app')
        assert.deepEqual(await world.appProbe.vaultState({ vaultRoot: store.vaultRoot, route: vaultRoute({ vaults: after.vaults, vaultRoot: store.vaultRoot }) }), { answered: true, indexReady: true })
      } finally {
        if (world) { const stopped = (await world.run(['service', 'stop'])).service; t.diagnostic(`service: ${stopped?.reason ?? JSON.stringify(stopped)}`); assert.equal(stopped?.stopped, true, 'the service this suite started is stopped') }
        assert.deepEqual(await app.quit(), [], 'the isolated app is gone')
        if (process.env.ATELIER_OBSIDIAN_FIRST_OPEN_KEEP !== '1') app.remove(); else t.diagnostic(`kept ${app.root}`)
      }
    })

    await t.test('a vault listed at a folder above the view\'s vault, before it: open reaches the view\'s vault by its id, and the vault above it is never opened', async () => {
      const app = createIsolatedApp({ vaults: {} })
      let world = null
      try {
        world = await projectBeside(app)
        // The view's vault as the app will know it, below a vault at the data root listed first, as a vault at the
        // home folder would be: a call run in the view's vault folder would reach that vault, and open it.
        const [workspaceId] = fs.readdirSync(path.join(world.dataRoot, 'obsidian'))
        const vaultRoot = path.join(fs.realpathSync(path.join(world.dataRoot, 'obsidian', workspaceId)), 'vaults', SCOPE)
        const [above, ours] = ['b0b1b2b3b4b5b6b7', 'c0c1c2c3c4c5c6c7']
        fs.writeFileSync(app.settingsFile, JSON.stringify({ vaults: { [above]: { path: world.dataRoot, ts: 1 }, [ours]: { path: vaultRoot, ts: 2 } }, cli: true, updateDisabled: true }))
        const started = Date.now()
        const opened = await world.run(['open', '--consent-actor', 'real-app-suite'])
        t.diagnostic(`open answered ${opened.outcome} (${opened.reason}) in ${Date.now() - started} ms; registration ${JSON.stringify(opened.registration ?? null)}`)
        assert.deepEqual([opened.outcome, opened.ok, opened.launched, opened.registration?.how], ['current', true, true, 'listed'], JSON.stringify(opened, null, 2))
        const listed = await listedWithin(world.registry)
        assert.equal(listed.answered, true)
        const route = vaultRoute({ vaults: listed.vaults, vaultRoot })
        assert.deepEqual(route, { how: 'id', id: ours })
        assert.deepEqual(await world.appProbe.vaultState({ vaultRoot, route }), { answered: true, indexReady: true })
        assert.notEqual(listed.vaults[above]?.open, true, 'the vault above it has no window')
        assert.equal(fs.existsSync(path.join(world.dataRoot, '.obsidian')), false, 'the app never opened the folder above it as a vault')
      } finally {
        if (world) { const stopped = (await world.run(['service', 'stop'])).service; t.diagnostic(`service: ${stopped?.reason ?? JSON.stringify(stopped)}`); assert.equal(stopped?.stopped, true, 'the service this suite started is stopped') }
        assert.deepEqual(await app.quit(), [], 'the isolated app is gone')
        if (process.env.ATELIER_OBSIDIAN_FIRST_OPEN_KEEP !== '1') app.remove(); else t.diagnostic(`kept ${app.root}`)
      }
    })
  })
