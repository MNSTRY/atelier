import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isPendingPrivateWrite, publishPrivateFile } from '../../../project/durable-state.mjs'
import { readRegularTextNoFollow } from '../../../project/private-state.mjs'
import { OBSIDIAN_EXT_KEY, assertObsidianContract } from '../contracts.mjs'
import { refuse } from './store.mjs'

// Durable publication journal. The registered shape is one document; on disk
// it is a header plus one immutable file per entry, each published atomically
// under a name that is never overwritten, so an entry is either wholly present
// or absent and history cannot be rewritten in place. The document is
// assembled from those files and validated against the registered schema every
// time it is read or extended.
//
// Entry steps follow the schema: `capture` (the write-ahead record binding a
// note to its base, candidate, staged file and recovery path, written before
// anything is exchanged), `conditional-update` (the exchange, exclusive
// create or conditional removal and its outcome), `verify`, `manifest-commit`
// and `restart`. Each entry file also carries the journal state that holds
// after it.

export const JOURNAL_SCHEMA = 'atelier-obsidian-publication-journal/v1'
const ENTRY_FILE = /^\d{8}\.json$/
const CLOSED_FILE = 'closed.json'

const isoTime = (clock) => {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('the clock did not return a time')
  return date.toISOString()
}

export function newJournalId(clock = () => new Date()) {
  return `journal-${isoTime(clock).replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`
}

function load(directory) {
  const header = JSON.parse(readRegularTextNoFollow(path.join(directory, 'header.json')))
  const entriesDir = path.join(directory, 'entries')
  const names = fs.existsSync(entriesDir) ? fs.readdirSync(entriesDir).filter((name) => !isPendingPrivateWrite(name)).sort() : []
  const records = names.map((name, index) => {
    if (!ENTRY_FILE.test(name) || Number(name.slice(0, 8)) !== index) refuse('journal-corrupt', 'journal entries are not a contiguous sequence; preserve and inspect')
    const record = JSON.parse(readRegularTextNoFollow(path.join(entriesDir, name)))
    if (record.entry?.seq !== index) refuse('journal-corrupt', 'a journal entry does not carry its own sequence number')
    return record
  })
  return { header, records }
}

function assemble({ header, records }) {
  const restarts = records.filter((record) => record.entry.step === 'restart' && record.entry.ext?.[OBSIDIAN_EXT_KEY]?.phase === 'begin')
  const document = {
    ...header,
    state: records.length > 0 ? records.at(-1).state : 'prepared',
    entries: records.map((record) => record.entry),
    restart: { count: restarts.length, ...(restarts.length > 0 ? { lastRecoveredAt: restarts.at(-1).entry.at } : {}) },
  }
  return assertObsidianContract('publication-journal', document)
}

function handle(store, directory, clock) {
  // One writer at a time extends a journal (the publisher holds the view's
  // lock), so the entries read once stay the entries on disk.
  let cached = null
  const current = () => (cached ??= load(directory))
  const journal = {
    directory,
    document: () => assemble(current()),
    // detail lands under the entry's ext container; the rest are schema fields.
    append({ step, outcome, state, notePath, beforeDigest, afterDigest, recoveryRef, detail }) {
      const loaded = current()
      const entry = {
        seq: loaded.records.length,
        at: isoTime(clock),
        step,
        outcome,
        ...(notePath === undefined ? {} : { notePath }),
        ...(beforeDigest ? { beforeDigest } : {}),
        ...(afterDigest ? { afterDigest } : {}),
        ...(recoveryRef ? { recoveryRef } : {}),
        ...(detail ? { ext: { [OBSIDIAN_EXT_KEY]: detail } } : {}),
      }
      const record = { entry, state: state ?? (loaded.records.at(-1)?.state ?? 'prepared') }
      assemble({ header: loaded.header, records: [record] })
      try {
        publishPrivateFile(path.join(directory, 'entries', `${String(entry.seq).padStart(8, '0')}.json`), `${JSON.stringify(record, null, 2)}\n`)
      } catch (error) {
        cached = null
        throw error
      }
      loaded.records.push(record)
      return entry
    },
    // A journal that can no longer matter (committed, or superseded by a later
    // commit) is closed so that later runs do not read it again. The flag file
    // is advisory: a journal without one is simply read and judged again.
    close() {
      try { publishPrivateFile(path.join(directory, CLOSED_FILE), `${JSON.stringify({ state: assemble(current()).state })}\n`) } catch (error) { if (error.code !== 'EEXIST') throw error }
    },
  }
  return journal
}

export function createJournal(store, { journalId, protocolId, expectedGeneration, targetGeneration, detail, clock = () => new Date() }) {
  const directory = store.journalDir(journalId)
  fs.mkdirSync(path.join(directory, 'entries'), { recursive: true, mode: 0o700 })
  const header = {
    schema: JOURNAL_SCHEMA,
    contractVersion: '1.0.0',
    journalId,
    workspaceId: store.workspaceId,
    scopeId: store.scopeId,
    protocolId,
    expectedGeneration,
    targetGeneration,
    ...(detail ? { ext: { [OBSIDIAN_EXT_KEY]: detail } } : {}),
  }
  assemble({ header, records: [] })
  publishPrivateFile(path.join(directory, 'header.json'), `${JSON.stringify(header, null, 2)}\n`)
  return handle(store, directory, clock)
}

// Journals of this view, oldest first. A directory without a header is a
// journal that never began: nothing can refer to it.
export function listJournals(store, { clock = () => new Date(), openOnly = false } = {}) {
  if (!fs.existsSync(store.journalsRoot)) return []
  return fs.readdirSync(store.journalsRoot).sort()
    .filter((name) => fs.existsSync(path.join(store.journalsRoot, name, 'header.json')))
    .filter((name) => !openOnly || !fs.existsSync(path.join(store.journalsRoot, name, CLOSED_FILE)))
    .map((name) => handle(store, path.join(store.journalsRoot, name), clock))
}

export const journalDetail = (value) => value?.ext?.[OBSIDIAN_EXT_KEY] ?? {}
