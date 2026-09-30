// Synthetic loopback proof using the installed browser and locked Playwright.
// Never opens a person's browser profile or touches an operational workspace.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { commandProject } from '../src/project/config.mjs'
import { createAtelierSidecarServer } from '../src/server/local-sidecar.mjs'
import { createKnowledgeSessions } from '../src/knowledge/sessions.mjs'
import { digest } from '../src/knowledge/plan.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = path.resolve(
  process.env.ATELIER_KNOWLEDGE_PROOF_OUTPUT ||
    path.join(root, '.artifacts/knowledge-browser')
)
fs.mkdirSync(output, { recursive: true })
const temp = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), 'atelier-knowledge-browser-')
)
const workspace = path.join(temp, 'workspace')
const cli = (...args) =>
  spawnSync(process.execPath, [path.join(root, 'bin/atelier.mjs'), ...args], {
    cwd: fs.existsSync(workspace) ? workspace : root,
    encoding: 'utf8',
  })
const init = cli(
  'init',
  '--template',
  'knowledge-workspace',
  '--target',
  workspace
)
assert.equal(init.status, 0, init.stderr)
assert.equal(spawnSync('git', ['init', '--quiet', workspace]).status, 0)
for (const step of ['graph', 'build']) {
  const result = cli(step)
  assert.equal(result.status, 0, result.stderr)
}
const project = commandProject({ cwd: workspace, argv: [] })
let server = createAtelierSidecarServer({
  workspaceRoot: project.outputRoot,
  knowledgeProject: project,
})
const address = await server.listen(),
  base = 'http://127.0.0.1:' + address.port
const browser = await chromium.launch({
  headless: true,
  ...(process.env.ATELIER_BROWSER_CHANNEL
    ? { channel: process.env.ATELIER_BROWSER_CHANNEL }
    : {}),
})
const page = await browser.newPage({
  viewport: { width: 1440, height: 1050 },
  deviceScaleFactor: 1,
  locale: 'en-US',
  reducedMotion: 'reduce',
})
page.setDefaultTimeout(10000)
const errors = [],
  external = [],
  checks = [],
  screenshots = []
let failNextSave = false,
  failedValue = null
page.on('pageerror', (error) => errors.push(error.message))
await page.route('**/*', (route) => {
  if (new URL(route.request().url()).origin !== base) {
    external.push(route.request().url())
    return route.abort('blockedbyclient')
  }
  if (
    failNextSave &&
    route.request().method() === 'POST' &&
    new URL(route.request().url()).pathname === '/api/knowledge/event'
  ) {
    const input = route.request().postDataJSON()
    if (input.event.type === 'save') {
      failNextSave = false
      const values = path.join(
        workspace,
        '.atelier-local/coauthor/values',
        digest(input.sessionId)
      )
      fs.mkdirSync(values, { recursive: true })
      failedValue = path.join(values, digest(input.event.id) + '.json')
      fs.writeFileSync(
        failedValue,
        'Synthetic conflicting value; preserve instead of overwriting.'
      )
    }
  }
  return route.continue()
})
const expectText = async (selector, text) => {
  await page.waitForFunction(
    ({ selector, text }) =>
      document.querySelector(selector)?.textContent.includes(text),
    { selector, text }
  )
}
const capture = async (name) => {
  const file = path.join(output, name + '.png')
  const bytes = await page.screenshot({
    path: file,
    fullPage: true,
    animations: 'disabled',
  })
  screenshots.push({ file: name + '.png', sha256: digest(bytes) })
}
try {
  await page.goto(base + '/knowledge')
  await expectText('#status', 'Current plan and graph loaded')
  assert.equal(await page.locator('#steps button').count(), 5)
  await page.getByRole('button', { name: '02 Model' }).click()
  await expectText('#dashboard', 'similar names are not identity')
  await capture('model-wide')
  await page.getByRole('button', { name: '04 Apply' }).click()
  await page.getByRole('button', { name: 'Inspect graph context' }).click()
  await expectText('#evidence', 'loan:inspection')
  const passages = page.getByText('Read complete source', { exact: true })
  for (let i = 0; i < (await passages.count()); i++)
    await passages.nth(i).click()
  await expectText('#evidence', '**not** passed')
  await capture('apply-wide')
  checks.push('real projection build, all stages, complete qualified context')
  await page.getByLabel('Your name or role').fill('Sample reviewer')
  await page
    .getByRole('button', { name: 'Start a session', exact: true })
    .click()
  await expectText('#session-status', 'Session started')
  const store = createKnowledgeSessions(project),
    id = store.list().sessions[0].id
  await page
    .locator('#answer')
    .fill('The inspection has not passed. Do not approve a loan yet.')
  await page
    .getByRole('button', { name: 'Record my answer', exact: true })
    .click()
  await expectText('#session-status', 'Answer retained')
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click()
  await expectText('#session-status', 'Current step: saved')
  await page.reload()
  await expectText('#sessions', 'Apply · saved')
  await page.locator('#sessions button').first().click()
  await expectText('#history', 'The inspection has not passed.')
  assert.equal(
    store.read(id).state.saved[0].text,
    'The inspection has not passed. Do not approve a loan yet.'
  )
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expectText('#session-status', 'Current step: input')
  checks.push(
    'save receipt, browser reload, session discovery, and explicit advance'
  )
  const draft = 'Arrival is only forecast; receipt evidence is missing.'
  await page.locator('#answer').fill(draft)
  await server.close()
  await page
    .getByRole('button', { name: 'Record my answer', exact: true })
    .click()
  await expectText('#session-status', 'Not confirmed saved')
  assert.equal(await page.locator('#answer').inputValue(), draft)
  assert.equal(await page.locator('#answer').isDisabled(), true)
  // Failure recovery remains visible after both reading and exporting, and
  // editing cannot silently change the payload kept for exact retry.
  await page
    .getByRole('button', { name: 'Reload session', exact: true })
    .click()
  await expectText('#session-status', 'Session unavailable')
  assert.equal(
    await page
      .getByRole('button', { name: 'Retry exact request', exact: true })
      .isVisible(),
    true
  )
  const pendingDownload = page.waitForEvent('download')
  await page
    .getByRole('button', { name: 'Export pending request', exact: true })
    .click()
  const pendingSnapshot = JSON.parse(
    fs.readFileSync(await (await pendingDownload).path(), 'utf8')
  )
  assert.equal(pendingSnapshot.pendingRequest.input.event.text, draft)
  assert.equal(
    await page
      .getByRole('button', { name: 'Retry exact request', exact: true })
      .isVisible(),
    true
  )
  server = createAtelierSidecarServer({
    workspaceRoot: project.outputRoot,
    knowledgeProject: project,
  })
  await server.listen(address.port)
  await page
    .getByRole('button', { name: 'Reload session', exact: true })
    .click()
  await expectText('#session-status', 'Session loaded')
  assert.equal(
    await page
      .getByRole('button', { name: 'Retry exact request', exact: true })
      .isVisible(),
    true
  )
  await page
    .getByRole('button', { name: 'Retry exact request', exact: true })
    .click()
  await expectText('#session-status', 'Current step: draft')
  assert.match(
    await page.locator('#session-status').textContent(),
    /Answer retained/
  )
  assert.doesNotMatch(
    await page.locator('#session-status').textContent(),
    /Saved draft receipt/
  )
  assert.equal(store.read(id).state.proposal.text, draft)
  assert.equal(
    store.read(id).state.answers.filter((a) => a.text === draft).length,
    1
  )
  checks.push(
    'service loss, blocked editing, failed and successful reload, export, and exact retry preserve text and record once without a false save claim'
  )
  const s = store.read(id).state
  store.event({
    sessionId: id,
    event: {
      id: 'agent-proposal',
      expectedRevision: s.revision,
      type: 'propose',
      text: 'No receipt evidence establishes arrival. The forecast remains uncertain.',
    },
  })
  await page
    .getByRole('button', { name: 'Reload session', exact: true })
    .click()
  await expectText('#controls', 'Confirm revised wording')
  assert.equal(
    await page
      .getByRole('button', { name: 'Save private draft', exact: true })
      .count(),
    0
  )
  await page
    .getByRole('button', { name: 'Keep original wording', exact: true })
    .click()
  await expectText('#session-status', 'Current step: draft')
  assert.equal(await page.locator('#answer').inputValue(), draft)
  failNextSave = true
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click()
  await expectText('#session-status', 'Not confirmed saved')
  await page
    .getByRole('button', { name: 'Retry exact request', exact: true })
    .click()
  await expectText('#session-status', 'Save not confirmed')
  assert.doesNotMatch(
    await page.locator('#session-status').textContent(),
    /Saved draft receipt/
  )
  assert.equal(store.read(id).state.phase, 'recovery')
  fs.unlinkSync(failedValue) // Remove only this proof's deliberately introduced fault.
  await page
    .getByRole('button', { name: 'Retry private save', exact: true })
    .click()
  await expectText('#session-status', 'Current step: saved')
  checks.push(
    'agent confirmation, original wording, failed-save reporting, exact retry, and explicit save recovery'
  )
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expectText('#session-status', 'Current step: input')
  const unsaved = 'A proposed follow-up remains unrecorded.'
  await page.locator('#answer').fill(unsaved)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expectText('#session-status', 'Record or export')
  await page
    .getByRole('button', { name: 'Reload session', exact: true })
    .click()
  await expectText('#session-status', 'Your unsaved text is still')
  assert.equal(await page.locator('#answer').inputValue(), unsaved)
  const download = page.waitForEvent('download')
  await page
    .getByRole('button', { name: 'Export draft snapshot', exact: true })
    .click()
  const snapshot = await download
  const exported = JSON.parse(fs.readFileSync(await snapshot.path(), 'utf8'))
  assert.equal(exported.unsavedText, unsaved)
  assert.equal(exported.sourceEditsApplied, false)
  await page
    .getByRole('button', { name: 'Discard unsaved text', exact: true })
    .click()
  checks.push(
    'pause refuses unsaved loss, reload preserves draft, explicit snapshot export'
  )
  // A concurrent agent advances the revision while the browser retains its own
  // wording. Ending an unconfirmed retry must preserve that wording and permit
  // a newly bound intent after the intervening state is inspected.
  const concurrent = store.read(id).state
  store.event({
    sessionId: id,
    event: {
      id: 'agent-answer',
      expectedRevision: concurrent.revision,
      type: 'answer',
      text: 'Agent retained a separate observation.',
    },
  })
  await page.locator('#answer').fill('My wording after the agent observation.')
  await page
    .getByRole('button', { name: 'Record my answer', exact: true })
    .click()
  await expectText('#session-status', 'stale revision')
  await page
    .getByRole('button', { name: 'End retry and inspect history', exact: true })
    .click()
  await expectText('#session-status', 'Retry ended')
  await expectText(
    '#recorded-wording',
    'Agent retained a separate observation.'
  )
  assert.equal(
    await page
      .getByRole('heading', { name: 'Current recorded wording', exact: true })
      .isVisible(),
    true
  )
  assert.match(
    await page.locator('#recorded-wording').innerText(),
    /Agent retained a separate observation/
  )
  assert.equal(
    await page.locator('#answer').inputValue(),
    'My wording after the agent observation.'
  )
  await page
    .getByRole('button', { name: 'Record my answer', exact: true })
    .click()
  await expectText('#session-status', 'Answer retained')
  assert.equal(
    store
      .read(id)
      .state.answers.filter(
        (a) => a.text === 'My wording after the agent observation.'
      ).length,
    1
  )
  // Open by ID without relying on a particular session's position in the list.
  await page.getByLabel('Open an exact session ID').fill(id)
  await page.getByRole('button', { name: 'Open session', exact: true }).click()
  await expectText('#session-status', 'Session loaded')
  checks.push(
    'stale revision recovery displays intervening wording before a new intent, preserves tab text, and supports exact-ID navigation'
  )
  await page
    .locator('#answer')
    .fill('Text kept during a failed history inspection.')
  await server.close()
  await page
    .getByRole('button', { name: 'Record my answer', exact: true })
    .click()
  await expectText('#session-status', 'Not confirmed saved')
  await page
    .getByRole('button', { name: 'End retry and inspect history', exact: true })
    .click()
  await expectText('#session-status', 'Session unavailable')
  assert.doesNotMatch(
    await page.locator('#session-status').textContent(),
    /Retry ended/
  )
  assert.equal(
    await page.locator('#answer').inputValue(),
    'Text kept during a failed history inspection.'
  )
  server = createAtelierSidecarServer({
    workspaceRoot: project.outputRoot,
    knowledgeProject: project,
  })
  await server.listen(address.port)
  await page
    .getByRole('button', { name: 'Reload session', exact: true })
    .click()
  await expectText('#session-status', 'Session loaded')
  await expectText(
    '#recorded-wording',
    'My wording after the agent observation.'
  )
  await page
    .getByRole('button', { name: 'Record my answer', exact: true })
    .click()
  await expectText('#session-status', 'Answer retained')
  checks.push(
    'failed history inspection remains visible after ending retry; restored service displays recorded wording and preserves tab text'
  )
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    )
    assert.ok(overflow <= 1, 'horizontal overflow at ' + width)
    const targets = await page
      .locator('button,input,select,textarea')
      .evaluateAll((els) =>
        els
          .filter((e) => e.getClientRects().length)
          .map((e) => ({
            width: e.getBoundingClientRect().width,
            height: e.getBoundingClientRect().height,
          }))
      )
    assert.ok(
      targets.every((t) => t.width >= 44 && t.height >= 44),
      'small interactive target'
    )
    if (width === 390) await capture('apply-narrow')
  }
  checks.push('320, 390, 768, and 1440px layout; 44px controls')
  fs.appendFileSync(
    path.join(workspace, 'records/inspection.md'),
    '\nA newer source revision.\n'
  )
  await page
    .getByRole('button', { name: 'Reload session', exact: true })
    .click()
  await expectText('#source-state', 'Earlier source revision')
  assert.equal(await page.locator('#editor').evaluate((e) => e.disabled), true)
  assert.equal(await page.locator('#answer').isDisabled(), true)
  assert.equal(store.read(id).current, false)
  checks.push('changed-source refusal retains original evidence and history')
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  const sources = [
    'src/knowledge/workspace.mjs',
    'src/knowledge/sessions.mjs',
    'src/coauthor/store.mjs',
    'src/ui/knowledge-page.mjs',
    'src/server/local-sidecar.mjs',
    'src/server/server.mjs',
    'src/commands/knowledge.mjs',
    'scripts/prove-knowledge-browser.mjs',
    'package-lock.json',
  ]
  const proof = {
    schema: 'atelier-knowledge-browser-proof/experimental-v1',
    browser: browser.version(),
    head: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout.trim(),
    sources: Object.fromEntries(
      sources.map((p) => [p, digest(fs.readFileSync(path.join(root, p)))])
    ),
    checks,
    screenshots,
    sourceEditsApplied: false,
    humanAcceptanceObserved: false,
    scope: 'invented local workspace; software behavior only',
  }
  fs.writeFileSync(
    path.join(output, 'proof.json'),
    JSON.stringify(proof, null, 2) + '\n'
  )
  console.log(JSON.stringify({ ok: true, checks: checks.length, output }))
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(temp, { recursive: true, force: true })
}
