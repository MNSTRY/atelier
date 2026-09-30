import { createIngestionStore } from '../ingestion/store.mjs'
import { reportCommandFailure } from '../cli/command-failure.mjs'

const commands = ['plan', 'run', 'status', 'query']
const usage = `Usage: atelier ingest plan|run|status|query
Read one UTF-8 JSON object from stdin, maximum 256 KiB:
{workspaceId,input}. Run inside the intended Git workspace with untracked,
ignored .atelier-local/ state. Plans bind explicit sources, scope and budgets.
Run processes bounded local text, CSV and JSON. Status retains every selected
source's disposition. Query returns source-bound lexical evidence with coverage;
no operation accepts semantic claims, calls a provider or enrolls raw files into
the graph. Output is private JSON. See docs/ingestion.md.`

try {
  const command = process.argv[2]
  if (command === '--help' || command === 'help') console.log(usage)
  else {
    if (!commands.includes(command) || process.argv.length !== 3) throw new Error(usage)
    const chunks = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 256 * 1024) throw new Error('ingestion request exceeds byte limit')
      chunks.push(chunk)
    }
    let body
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new Error('ingestion request must be UTF-8 JSON') }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'workspaceId') || !Object.hasOwn(body, 'input')) {
      throw new Error('invalid ingestion request fields')
    }
    const store = createIngestionStore({ workspaceRoot: process.cwd(), workspaceId: body.workspaceId })
    console.log(JSON.stringify(await store[command](body.input), null, 2))
  }
} catch (error) {
  // Parser exceptions above are replaced before they can echo source text.
  reportCommandFailure(error)
}
