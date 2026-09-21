import { createTrackableStore, previewTrackable, releaseTrackable } from '../trackables/store.mjs'
try {
  const [command, ...rest] = process.argv.slice(2)
  if (!['preview', 'release', 'execute', 'snapshot', 'view', 'export'].includes(command) || rest.length) throw new Error('Usage: atelier trackable preview|release|execute|snapshot|view|export (JSON stdin)')
  const chunks = []; let length = 0
  for await (const chunk of process.stdin) { length += chunk.length; if (length > 256 * 1024) throw new Error('request exceeds limit'); chunks.push(chunk) }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  const fields = command === 'preview' ? ['definition', 'subject', 'at', 'effectiveAt', 'evidence'] : command === 'release' ? ['definition'] : ['scope', 'actor', ...(command === 'execute' ? ['command'] : command === 'view' ? ['instanceId', 'at'] : [])]
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(k => !fields.includes(k))) throw new Error('invalid trackable request fields')
  let result
  if (command === 'preview') result = previewTrackable(input)
  else if (command === 'release') result = releaseTrackable(input.definition)
  else {
    const store = createTrackableStore({ workspaceRoot: process.cwd(), scope: input.scope, actor: input.actor })
    result = command === 'execute' ? store.execute(input.command) : command === 'view' ? store.view({ instanceId: input.instanceId, at: input.at }) : command === 'export' ? store.exportHistory() : store.snapshot()
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1 }
