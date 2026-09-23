import { createLearningStore } from '../learning/store.mjs'
import { planLearningWork } from '../learning/assistance.mjs'

const commands = ['capture', 'propose', 'decide', 'activate', 'withdraw', 'list', 'context', 'render', 'graph', 'export', 'plan']
const writes = new Set(commands.slice(0, 5))
const usage = `Usage: atelier learn ${commands.join('|')}
Read one JSON object from stdin, maximum 256 KiB. Run inside the intended Git
workspace with untracked, ignored .atelier-local/ state.

Every request includes workspaceId. Writes also include actor:{id,kind},
requestId, expectedRevision and input. Actor is a local caller assertion, not
authenticated identity. Reads use query only for context and render.

Capture records evidence; propose creates an inert lesson. Decide binds an exact
lesson digest. Activate makes approved content available to a named harness;
it does not install files or grant tool permissions. Withdraw stops future use.
List, context, render, graph, export and plan print private JSON to stdout.
Export is an explicit private archive, never a send or publication operation.
See docs/learning.md for complete examples.`

function exactObject(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw new Error('invalid learning request fields')
}

const command = process.argv[2]
if (command === '--help' || command === 'help') {
  console.log(usage)
} else {
  try {
    if (!commands.includes(command) || process.argv.length !== 3) throw new Error(usage)
    const chunks = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 256 * 1024) throw new Error('learning request exceeds byte limit')
      chunks.push(chunk)
    }
    let body
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new Error('learning request must be UTF-8 JSON') }
    const fields = writes.has(command)
      ? ['workspaceId', 'actor', 'requestId', 'expectedRevision', 'input']
      : ['workspaceId', ...(['context', 'render'].includes(command) ? ['query'] : [])]
    exactObject(body, fields, fields)
    const store = createLearningStore({ workspaceRoot: process.cwd(), workspaceId: body.workspaceId })
    let result
    if (writes.has(command)) {
      result = store.execute({ requestId: body.requestId, expectedRevision: body.expectedRevision,
        operation: command, input: body.input }, { actor: body.actor })
    } else if (command === 'list') result = store.snapshot()
    else if (command === 'plan') result = planLearningWork(store.snapshot())
    else if (command === 'context' || command === 'render') result = store[command](body.query)
    else result = store[command]()
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }))
    process.exitCode = 1
  }
}
