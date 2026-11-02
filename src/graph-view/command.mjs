import fs from 'node:fs/promises'
import { parseGraphView, refuse } from './contracts.mjs'

// A consuming CLI binds its authenticated reader through this port. The
// standalone validator reads fixture bytes only; a file is never an access grant.
export async function runGraphViewCommand(argv, { reader, stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  try {
    const flags = new Map()
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index], value = argv[index + 1]
      if (!['--validate', '--request', '--out'].includes(key) || !value || value.startsWith('--') || flags.has(key)) refuse('invalid_arguments')
      flags.set(key, value)
    }
    let bytes
    if (flags.has('--validate')) {
      if (flags.has('--request') || flags.has('--out') || reader) refuse('invalid_arguments')
      parseGraphView(await fs.readFile(flags.get('--validate'), 'utf8'))
      stdout('graph-view fixture valid\n')
      return 0
    } else {
      if (!reader || typeof reader.exportGraphView !== 'function') refuse('host_binding_required')
      const request = flags.has('--request') ? JSON.parse(await fs.readFile(flags.get('--request'), 'utf8')) : {}
      bytes = await reader.exportGraphView(request)
    }
    if (flags.has('--out')) await fs.writeFile(flags.get('--out'), bytes, { flag: 'wx', mode: 0o600 })
    else stdout(bytes)
    return 0
  } catch (error) {
    const known = ['invalid_arguments', 'host_binding_required', 'policy_refusal', 'stale_source', 'stale_cursor', 'unavailable', 'budget_exceeded', 'contract_mismatch', 'digest_mismatch']
    const code = known.includes(error?.code) ? error.code : 'operation_failed'
    stderr(`graph-view: ${code}\n`)
    return 2
  }
}
