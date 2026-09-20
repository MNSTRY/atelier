import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalize } from '../../../src/attestation/jcs.mjs'
import { createProposalStore } from '../../../src/collaboration/proposals.mjs'
import { createAbandonmentProof, isProcessAlive } from '../../../src/runtime/obsidian/private-lock.mjs'
import { protectedRoots } from '../../../src/runtime/obsidian/machine-settings.mjs'
import { APPLY_WORKSPACE_ID, git, makeApplyWorld, noteText, treeListing } from '../obsidian-edits/apply-world.mjs'

// An invented project of two real git repositories that hold the SAME relative
// paths, a temporary data root, a view written directly (no publisher and no
// atomic exchange is needed to refuse an apply, so this runs on every
// platform), and structural edits made the way a person makes them: the note
// is edited, the real observation queues it, and the real source apply looks
// at it and records the operation as `proposed`. Every repository, ledger and
// store written here lives under that temporary directory.

export const WORKSPACE_ID = APPLY_WORKSPACE_ID
export const REPOSITORIES = Object.freeze(['east-wing', 'west-wing'])
export const STORE_DIRECTORY = '.atelier-proposals'
// A title no proposal of another repository may ever hold.
export const WEST_TITLE = 'Tide tables of the western shore'
export const PRIVATE_TITLE = 'Keeper only ledger'

export const PROPOSAL_FILES = Object.freeze({
  'east-wing/notes/guide.md': noteText({ id: 'east-wing:guide', title: 'Lantern guide', body: 'The lamp turns once a minute.\n\nClosing words.' }),
  'east-wing/notes/second.md': noteText({ id: 'east-wing:second', title: 'Second sheet', body: 'A second sheet.\n\nClosing words.' }),
  'east-wing/notes/third.md': noteText({ id: 'east-wing:third', title: 'Third sheet', body: 'A third sheet.\n\nClosing words.' }),
  'east-wing/notes/plain.md': noteText({ id: 'east-wing:plain', title: 'Plain sheet', body: 'Only the body of this one is edited.\n\nClosing words.' }),
  'east-wing/notes/ledger.md': noteText({ id: 'east-wing:ledger', title: PRIVATE_TITLE, body: 'Kept for the keeper only.', audience: 'private' }),
  'west-wing/notes/guide.md': noteText({ id: 'west-wing:guide', title: WEST_TITLE, body: 'High water at noon.\n\nClosing words.' }),
  'west-wing/notes/second.md': noteText({ id: 'west-wing:second', title: 'Western second sheet', body: 'Low water at six.\n\nClosing words.' }),
})

// The whole project tree except the proposal stores (git directories included), and what git says about each
// repository: the oracle that no source byte and no index entry changed.
export const sourceState = (world) => ({
  tree: treeListing(world.projectDir, { skip: (relative) => relative.split('/').includes(STORE_DIRECTORY) }),
  status: Object.fromEntries(REPOSITORIES.map((name) => [name, git(world.repo(name), ['status', '--porcelain'])])),
})

export function makeProposalWorld(t, { files = PROPOSAL_FILES, audienceAllow = ['team', 'private'], gitignore = Object.fromEntries(REPOSITORIES.map((name) => [name, `${STORE_DIRECTORY}/\n`])) } = {}) {
  const world = makeApplyWorld(t, { repositories: [...REPOSITORIES], files, audienceAllow, gitignore })
  world.configureMachine({ maintenanceMode: 'manual', audienceAllow })
  world.publishDirectly()
  const wikiOf = (nodeId) => path.basename(world.manifest().notes.find((note) => note.nodeId === nodeId).path, '.md')

  return Object.assign(world, {
    wikiOf,
    context: (extra = {}) => ({ project: world.loadProject(), workspaceRoot: world.workspaceRoot(), workspaceId: WORKSPACE_ID, repositoryRoots: protectedRoots(world.loadProject()), edits: world.pendingEdits(), clock: world.clock, ...extra }),
    // A person adds a link to another note of the vault: the text of the link is the file name of that note.
    addLink(nodeId, targetNodeId) { return world.editNote(nodeId, 'Closing words.', `Closing words and [[${wikiOf(targetNodeId)}]].`) },
    editFrontMatter(nodeId, from, to) { return world.editNote(nodeId, `title: "${from}"`, `title: "${to}"`) },
    // The real observation queues every edited note; the real source apply looks at each and records what it is.
    async observe() {
      world.queueDirectly()
      const results = []
      for (const edit of world.pendingEdits().filter((item) => item.closedAt === null)) results.push(await world.sourceApply().apply({ editId: edit.editId, mode: 'manual' }))
      return results
    },
    store: (name) => createProposalStore({ workspaceRoot: world.repo(name), workspaceId: WORKSPACE_ID }),
    storeDir: (name) => path.join(world.repo(name), STORE_DIRECTORY),
    ledgerFile: (name) => path.join(world.repo(name), STORE_DIRECTORY, 'events.ndjson'),
    ledgerBytes: (name) => { try { return fs.readFileSync(path.join(world.repo(name), STORE_DIRECTORY, 'events.ndjson')) } catch (error) { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error } },
    // Every proposal of a repository that the adapter made, read from the persisted store.
    adapterProposals(name) {
      if (!fs.existsSync(path.join(world.repo(name), STORE_DIRECTORY))) return []
      const listed = world.store(name).listProposals()
      if (!listed.ok) throw new Error(`the store of ${name} cannot be listed: ${listed.error}`)
      return listed.proposals.filter((record) => record.payload?.adapter?.operationId)
    },
    queueDir: () => path.join(world.workspaceRoot(), 'state', 'proposals'),
  })
}

// A crash: thrown from a seam, it stands for a process that died there. The adapter releases nothing on its way out.
export function crashAt(step, { times = 1 } = {}) {
  let left = times
  return (name) => { if (name === step && left > 0) { left -= 1; throw Object.assign(new Error(`crashed at ${name}`), { crashSeam: true }) } }
}

// The proof a lock is passed over with, where the ONLY injected part is that the holder of this test (which stood
// for a process that died) is not alive. Every other PID is asked of the operating system.
export const holderIsGoneProof = () => createAbandonmentProof({ alive: (pid) => pid !== process.pid && isProcessAlive(pid) })

// ---- ledgers at their limits, written in the on-disk format of the store -----------------------------------------

function eventOf({ aggregateId, version = 1, type = 'filler-recorded', actor = 'synthetic writer', at = '2026-01-05T09:00:00.000Z', payload }) {
  const event = { schema: 'atelier-collaboration-event@v1', aggregateId, version, type, actor, at, payload }
  event.id = `event-${createHash('sha256').update(canonicalize(event)).digest('hex').slice(0, 32)}`
  return event
}

// A valid proposal-created line whose payload is padded so that the whole line is exactly `lineBytes` long.
export function fillerLine(index, lineBytes = 0) {
  const id = `proposal-${createHash('sha256').update(`filler-${index}`).digest('hex').slice(0, 32)}`
  const at = '2026-01-05T09:00:00.000Z'
  const build = (padding) => {
    const record = { schema: 'atelier-proposal@v1', workspaceId: null, proposal: { id, status: 'proposed', createdAt: at, updatedAt: at, sessionId: '', viewId: '', path: 'notes/filler.md', action: 'copy.repoPath', intent: '', reason: '', storage: { kind: 'local', ignored: true }, authority: { action: 'copy.repoPath', capability: 'proposal.copy-only', copyOnly: true, directWrite: false, applyEndpoint: null }, eventVersion: 1 }, diff: '', payload: { padding } }
    return `${JSON.stringify(eventOf({ aggregateId: id, type: 'proposal-created', at, payload: { record } }))}\n`
  }
  const bare = build('')
  const missing = lineBytes - Buffer.byteLength(bare)
  return missing > 0 ? build('x'.repeat(missing)) : bare
}

// Writes a ledger of `events` valid lines, `bytes` long in all when given (the last lines are padded to reach it).
export function writeLedger(storeDirectory, { events, bytes = null }) {
  fs.mkdirSync(storeDirectory, { recursive: true, mode: 0o700 })
  const lines = []
  let total = 0
  for (let index = 0; index < events; index += 1) { const line = fillerLine(index); lines.push(line); total += Buffer.byteLength(line) }
  if (bytes !== null) {
    let missing = bytes - total
    if (missing < 0) throw new Error('the ledger asked for is smaller than its events')
    // Spread over as many lines as it takes, each no longer than a line may be.
    for (let index = 0; missing > 0 && index < events; index += 1) {
      const own = Buffer.byteLength(lines[index])
      const grow = Math.min(missing, 200 * 1024 - own)
      if (grow <= 0) continue
      lines[index] = fillerLine(index, own + grow)
      missing -= Buffer.byteLength(lines[index]) - own
    }
    if (missing !== 0) throw new Error(`the ledger asked for cannot be reached with ${events} events`)
  }
  fs.writeFileSync(path.join(storeDirectory, 'events.ndjson'), lines.join(''), { mode: 0o600 })
  return { events, bytes: lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0) }
}
