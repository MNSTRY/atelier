import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { Instance } from '../scripts/obsidian/lib/instance-fixture.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const layout = () => ({ home: path.join(os.tmpdir(), 'atelier-inspector-home') })

test('the desktop fixture reads disk and editor evidence without writing or invoking the production publisher', async (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-inspector-'))
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }))
  const notePath = 'notes/Synthetic.md'
  const diskText = '# Synthetic disk text\n'
  const editorText = '# Synthetic unsaved buffer\n'
  fs.mkdirSync(path.join(vault, 'notes'))
  fs.writeFileSync(path.join(vault, notePath), diskText)
  const mainDocument = {}
  const views = [
    { file: { path: notePath }, editor: {}, dirty: true, getViewData: () => editorText, containerEl: { ownerDocument: mainDocument } },
    { file: { path: notePath }, editor: {}, dirty: false, getViewData: () => diskText, containerEl: { ownerDocument: {} } },
    { file: { path: 'notes/Other.md' }, editor: {}, getViewData: () => 'unrelated', containerEl: { ownerDocument: mainDocument } },
  ]
  const reads = []
  const app = { vault: { adapter: { getBasePath: () => vault } }, workspace: { iterateAllLeaves: (visit) => views.forEach((view) => visit({ view })) } }
  const instance = new Instance(layout())
  instance.cli = async (command, code) => {
    assert.equal(command, 'eval')
    assert.ok(code.startsWith('code='))
    const result = vm.runInNewContext(code.slice(5), { app, document: mainDocument, Buffer, atob,
      require: (name) => {
        if (name === 'fs') return { existsSync: (file) => { reads.push(file); return fs.existsSync(file) }, readFileSync: (file) => { reads.push(file); return fs.readFileSync(file) } }
        if (name === 'path') return path
        if (name === 'crypto') return { createHash }
        throw new Error(`Unexpected inspector dependency: ${name}`)
      } })
    return `=> ${result}`
  }
  assert.deepEqual(await instance.bridge({ op: 'inspect', path: notePath }), {
    status: 'inspected', trace: [], diskSha256: digest(diskText), views: [
      { dirty: true, bufferSha256: digest(editorText), bufferBase64: Buffer.from(editorText).toString('base64'), popout: false },
      { dirty: false, bufferSha256: digest(diskText), bufferBase64: Buffer.from(diskText).toString('base64'), popout: true },
    ],
  })
  assert.deepEqual(reads, [path.join(vault, notePath), path.join(vault, notePath)])
  assert.equal(fs.readFileSync(path.join(vault, notePath), 'utf8'), diskText)
  assert.equal(views[0].getViewData(), editorText)
})

test('the desktop fixture refuses unsupported operations and invalid paths before asking the app anything', async () => {
  const instance = new Instance(layout())
  let calls = 0
  instance.cli = async () => { calls += 1; throw new Error('Unexpected CLI call') }
  for (const payload of [
    null, [], {}, { op: 'publish', path: 'notes/Example.md' }, { op: 'collect', path: 'notes/Example.md' },
    { op: 'eval', path: 'notes/Example.md' }, { op: 'inspect', path: 'notes/Example.md', code: 'anything' },
    { op: 'inspect', path: '../outside.md' }, { op: 'inspect', path: '/absolute.md' },
    { op: 'inspect', path: 'notes\\Example.md' }, { op: 'inspect', path: 'notes/Example\x00.md' },
    { op: 'inspect', path: '.obsidian/Example.md' }, { op: 'inspect', path: 'notes/Example.txt' },
  ]) {
    await assert.rejects(instance.bridge(payload), TypeError)
    await assert.rejects(instance.bridgeOnce(payload), TypeError)
  }
  assert.equal(calls, 0)
  assert.deepEqual(instance.transportRetries, [])
})

test('a note path travels as data in the fixed read-only inspector', async () => {
  const instance = new Instance(layout())
  const source = []
  instance.cli = async (command, code) => { assert.equal(command, 'eval'); source.push(code); return '=> {"status":"inspected","views":[]}' }
  const hostile = "notes/');process.exit(1);('.md"
  await instance.bridge({ op: 'inspect', path: hostile })
  await instance.bridge({ op: 'inspect', path: 'notes/Other.md' })
  assert.ok(!source[0].includes('process.exit(1)'))
  const encoded = /atob\('([A-Za-z0-9+/=]+)'\)/.exec(source[0])
  assert.ok(encoded)
  assert.deepEqual(JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8')), { op: 'inspect', path: hostile })
  const fixed = (code) => code.replace(/atob\('[A-Za-z0-9+/=]+'\)/, 'atob()')
  assert.equal(fixed(source[0]), fixed(source[1]))
})

test('read-only inspector retries remain bounded after a lost reply', async () => {
  const instance = new Instance(layout())
  let calls = 0
  instance.cli = async () => { if (++calls < 3) throw new Error('CLI call timed out'); return '=> {"status":"inspected","views":[]}' }
  assert.equal((await instance.bridge({ op: 'inspect', path: 'notes/Example.md' })).status, 'inspected')
  assert.deepEqual([calls, instance.transportRetries], [3, ['inspect', 'inspect']])
  calls = 0
  instance.cli = async () => { calls += 1; throw new Error('CLI call timed out') }
  await assert.rejects(instance.bridge({ op: 'inspect', path: 'notes/Example.md' }), /timed out/)
  assert.equal(calls, 3)
})

test('typing whose reply is lost is not repeated after inspection proves its bytes arrived', async () => {
  const instance = new Instance(layout())
  const calls = []
  instance.cli = async (command) => {
    calls.push(command)
    if (command === 'dev:cdp') throw new Error('CLI call timed out')
    return `=> ${JSON.stringify({ status: 'inspected', views: [{ bufferBase64: Buffer.from('text already arrived').toString('base64') }] })}`
  }
  assert.equal(await instance.typeText('already arrived', 'notes/Example.md'), 'arrived')
  assert.deepEqual(calls, ['dev:cdp', 'eval'])
  assert.deepEqual(instance.transportRetries, ['typeText'])
})
