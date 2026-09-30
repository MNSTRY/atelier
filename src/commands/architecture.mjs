import { architectureEntry, responsibilityCatalog, resolveBehaviorBinding } from '../architecture/index.mjs'
import { reportCommandFailure, parseJsonRequest } from '../cli/command-failure.mjs'

try {
  const [command, name, ...rest] = process.argv.slice(2)
  if (rest.length) throw new Error('unexpected architecture arguments')
  let result
  if (command === 'catalog' && name === undefined) result = responsibilityCatalog()
  else if (command === 'entry' && name !== undefined) {
    result = architectureEntry(name)
    if (!result) throw new Error('unknown architecture name')
  } else if (command === 'resolve' && name === undefined) {
    const chunks = []; let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 256 * 1024) throw new Error('architecture request exceeds limit')
      chunks.push(chunk)
    }
    const value = parseJsonRequest(Buffer.concat(chunks), 'architecture request')
    if (!value || Object.keys(value).sort().join(',') !== 'binding,consumers') throw new Error('binding and consumers required')
    result = resolveBehaviorBinding(value)
    if (!result.resolved) process.exitCode = 1
  } else throw new Error('Usage: atelier architecture catalog|entry NAME|resolve (JSON stdin)')
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  reportCommandFailure(error)
}
