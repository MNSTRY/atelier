import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { commandProject } from '../src/project/config.mjs'
import {
  knowledgeDashboard,
  loadKnowledgeWorkspace,
} from '../src/knowledge/workspace.mjs'
import { createKnowledgeSessions } from '../src/knowledge/sessions.mjs'
import { createAtelierSidecarServer } from '../src/server/local-sidecar.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = (cwd, args, input) =>
  spawnSync(process.execPath, [path.join(root, 'bin/atelier.mjs'), ...args], {
    cwd,
    input: input && JSON.stringify(input),
    encoding: 'utf8',
  })
function setup(t) {
  const temp = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'atelier-knowledge-workspace-')
  )
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const dir = path.join(temp, 'workspace')
  assert.equal(
    cli(root, ['init', '--template', 'knowledge-workspace', '--target', dir])
      .status,
    0
  )
  assert.equal(spawnSync('git', ['init', '--quiet', dir]).status, 0)
  const project = commandProject({ cwd: dir, argv: [] })
  const sessions = createKnowledgeSessions(project)
  const workspace = loadKnowledgeWorkspace(project)
  const input = {
    requestId: randomUUID(),
    flow: 'apply',
    questionId: 'loan',
    snapshot: workspace.snapshot,
    author: 'Sample author',
  }
  return { temp, dir, project, workspace, sessions, input }
}
const event = (sessionId, type, expectedRevision, extra = {}) => ({
  sessionId,
  event: { id: randomUUID(), type, expectedRevision, ...extra },
})

test('dashboards connect all five flows to current ontology, gaps, and evidence comparison', (t) => {
  const w = setup(t)
  const report = knowledgeDashboard(w.workspace)
  assert.deepEqual(
    report.flows.map((f) => f.id),
    ['onboard', 'model', 'deepen', 'apply', 'learn']
  )
  assert.equal(report.evaluation.cases[0].runs.lexical.evidenceRecall, 0.5)
  assert.equal(report.evaluation.cases[0].runs.graph.evidenceRecall, 1)
  assert.equal(report.next.stage, 'apply')
  assert.equal(report.providerCalls, 0)
  assert.equal(report.sourceEditsApplied, false)
  assert.equal(report.concepts[0].coverage.records, 1)
  assert.equal(
    JSON.parse(cli(w.dir, ['knowledge', 'dashboard']).stdout).snapshot,
    report.snapshot
  )
  assert.equal(
    fs.existsSync(path.join(w.dir, '.atelier-local/knowledge')),
    false
  )
  w.workspace.plan.concepts.push({
    id: 'unused',
    tag: 'concept:unused',
    definition: 'No use yet',
    identityRule: 'No merge implied',
  })
  assert.equal(knowledgeDashboard(w.workspace).next.stage, 'deepen')
})

test('people and agents share revision-bound private drafts, explicit revisions, and restart history', (t) => {
  const w = setup(t)
  const planBefore = fs.readFileSync(path.join(w.dir, 'knowledge-plan.json'))
  let r = w.sessions.start(w.input)
  const id = r.record.id
  assert.match(
    r.record.context.sources.find((s) => s.id === 'loan:inspection').text,
    /\*\*not\*\* passed/
  )
  assert.deepEqual(w.sessions.start(w.input), r)
  r = w.sessions.event(
    event(id, 'answer', r.state.revision, {
      text: 'Inspection has not passed.',
    })
  )
  const proposed = cli(
    w.dir,
    ['knowledge', 'session', 'event'],
    event(id, 'propose', r.state.revision, {
      text: 'Do not approve the loan until the inspection is completed.',
    })
  )
  assert.equal(proposed.status, 0, proposed.stderr)
  r = JSON.parse(proposed.stdout)
  assert.equal(r.state.phase, 'confirmation')
  assert.throws(
    () => w.sessions.event(event(id, 'save', r.state.revision)),
    /event refused/
  )
  r = w.sessions.event(event(id, 'reject', r.state.revision))
  assert.equal(r.state.proposal.text, 'Inspection has not passed.')
  const save = event(id, 'save', r.state.revision)
  r = w.sessions.event(save)
  assert.equal(r.state.phase, 'saved')
  assert.equal(r.savedMeaning, 'private-draft-only')
  assert.deepEqual(w.sessions.event(save), r)
  const restarted = createKnowledgeSessions(w.project).read(id)
  assert.deepEqual(restarted, r)
  assert.equal(
    restarted.state.saved[0].receipt.sourceDigest,
    w.workspace.sha256
  )
  assert.deepEqual(
    fs.readFileSync(path.join(w.dir, 'knowledge-plan.json')),
    planBefore
  )
  assert.equal(
    JSON.parse(cli(w.dir, ['knowledge', 'session', 'list']).stdout).sessions[0]
      .saved,
    1
  )
  assert.equal(
    fs.statSync(
      path.join(w.dir, '.atelier-local/knowledge/sessions', id + '.json')
    ).mode & 0o777,
    0o600
  )
})

test('source body drift and changed enrollment stop writes while exact old evidence stays readable', (t) => {
  const w = setup(t)
  const r = w.sessions.start(w.input),
    id = r.record.id
  fs.appendFileSync(
    path.join(w.dir, 'records/inspection.md'),
    '\nA later observation.\n'
  )
  assert.notEqual(
    loadKnowledgeWorkspace(w.project).snapshot,
    w.workspace.snapshot
  )
  assert.throws(
    () => w.sessions.event(event(id, 'answer', 0, { text: 'Outdated' })),
    /workspace changed/
  )
  assert.throws(() => w.sessions.start(w.input), /workspace changed/)
  const old = w.sessions.read(id)
  assert.equal(old.current, false)
  assert.doesNotMatch(
    old.record.context.sources.find((s) => s.id === 'loan:inspection').text,
    /later observation/
  )
  fs.writeFileSync(path.join(w.dir, 'knowledge-plan.json'), '{}')
  assert.equal(w.sessions.read(id).current, false)
  assert.equal(w.sessions.list()[0].current, false)
})

test('stale versions, invalid private placement, and forged persistence events refuse', (t) => {
  const w = setup(t)
  const r = w.sessions.start(w.input),
    id = r.record.id
  w.sessions.event(event(id, 'answer', 0, { text: 'First writer' }))
  assert.throws(
    () => w.sessions.event(event(id, 'answer', 0, { text: 'Stale writer' })),
    /stale revision/
  )
  assert.throws(() => w.sessions.event(event(id, 'receipt', 1)), /store-owned/)
  assert.throws(
    () => w.sessions.read('../outside'),
    /invalid knowledge session id/
  )
  fs.writeFileSync(path.join(w.dir, '.gitignore'), '')
  assert.throws(
    () => w.sessions.start({ ...w.input, requestId: randomUUID() }),
    /ignored/
  )
  assert.throws(() => w.sessions.event(event(id, 'save', 1)), /ignored/)
})

test('source overrides persist, changed configuration refreshes, and malformed session records refuse', (t) => {
  const w = setup(t)
  const moved = path.join(w.temp, 'other-records')
  fs.renameSync(path.join(w.dir, 'records'), moved)
  const project = commandProject({
    cwd: w.dir,
    argv: ['--repo-path', `records=${moved}`],
  })
  const workspace = loadKnowledgeWorkspace(project)
  assert.equal(workspace.graph.ok, true)
  assert.equal(workspace.project.repos[0].path, moved)
  const sessions = createKnowledgeSessions(project)
  const r = sessions.start({ ...w.input, snapshot: workspace.snapshot })
  const configFile = path.join(w.dir, 'atelier.project.json')
  const config = JSON.parse(fs.readFileSync(configFile))
  config.name = 'changed-workspace'
  fs.writeFileSync(configFile, JSON.stringify(config))
  assert.equal(sessions.read(r.record.id).current, false)
  const descriptor = path.join(
    w.dir,
    '.atelier-local/knowledge/sessions',
    r.record.id + '.json'
  )
  const data = JSON.parse(fs.readFileSync(descriptor))
  data.record.author = 'Altered'
  fs.writeFileSync(descriptor, JSON.stringify(data))
  assert.throws(
    () => sessions.read(r.record.id),
    /invalid knowledge session record/
  )
})

test('optional loopback routes retain origin, method, nonce, and private-file boundaries', async (t) => {
  const w = setup(t)
  const output = path.join(w.dir, 'atelier-output')
  fs.mkdirSync(output)
  fs.writeFileSync(
    path.join(output, 'index.html'),
    '<h1>Synthetic projection</h1>'
  )
  fs.writeFileSync(
    path.join(output, 'atelier.manifest.json'),
    JSON.stringify({
      schema: 'mnstry.atelier-manifest@v1',
      entry: 'index.html',
    })
  )
  const sidecar = createAtelierSidecarServer({
    workspaceRoot: output,
    knowledgeProject: w.project,
  })
  t.after(() => sidecar.close())
  const address = await sidecar.listen(),
    base = 'http://127.0.0.1:' + address.port
  const headers = {
    Origin: base,
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json',
  }
  // @atelier-test-fixture
  const get = (route) => fetch(base + route, { headers })
  // @atelier-test-fixture
  const post = (route, body, extra = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    })
  assert.equal((await get('/knowledge')).status, 200)
  assert.equal((await get('/api/knowledge/dashboard')).status, 200)
  for (const denied of [
    { Origin: 'https://example.invalid', 'Sec-Fetch-Site': 'cross-site' },
    { Origin: base, 'Sec-Fetch-Site': 'same-site' },
  ]) {
    assert.equal((await post('/api/knowledge/session', {}, denied)).status, 403)
    // @atelier-test-fixture
    assert.equal(
      (await fetch(base + '/api/knowledge/dashboard', { headers: denied }))
        .status,
      403
    )
  }
  assert.equal((await post('/api/knowledge/start', w.input)).status, 403)
  const grant = await (await post('/api/knowledge/session', {})).json()
  const nonce = { 'X-Atelier-Nonce': grant.mutationNonce }
  const started = await (
    await post('/api/knowledge/start', w.input, nonce)
  ).json()
  assert.equal(started.ok, true)
  assert.equal(
    (
      await post(
        '/api/knowledge/event',
        event(started.record.id, 'answer', 0, {
          text: 'Retained via browser API',
        }),
        nonce
      )
    ).status,
    200
  )
  const unknown = await (
    await get('/api/knowledge/read?id=kg-00000000-0000-0000-0000-000000000000')
  ).json()
  assert.equal(JSON.stringify(unknown).includes(w.dir), false)
  assert.equal((await get('/api/knowledge/start')).status, 404)
  assert.equal(
    (await get('/api/knowledge/context?id=loan&mode=semantic')).status,
    409
  )
  assert.equal(
    (await get('/api/knowledge/context?id=loan&id=arrival')).status,
    409
  )
  assert.equal(
    (await post('/api/knowledge/event?other=1', {}, nonce)).status,
    404
  )
  assert.equal(
    (
      await get(
        '/.atelier-local/knowledge/sessions/' + started.record.id + '.json'
      )
    ).status,
    403
  )
  const off = createAtelierSidecarServer({ workspaceRoot: output })
  t.after(() => off.close())
  const offAddress = await off.listen()
  // @atelier-test-fixture
  const absent = await fetch(
    'http://127.0.0.1:' + offAddress.port + '/api/knowledge/dashboard',
    { headers: { 'Sec-Fetch-Site': 'none' } }
  )
  assert.equal(absent.status, 404)
})
