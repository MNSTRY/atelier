import { planInstructionAdoption, applyInstructionAdoption, recoverInstructionAdoption, abandonInstructionAdoption, inspectInstructionAdoption, consumeInstructionContext } from '../capabilities/instructions.mjs'
import { reportCommandFailure, parseJsonRequest } from '../cli/command-failure.mjs'

const methods = { plan: planInstructionAdoption, apply: applyInstructionAdoption, recover: recoverInstructionAdoption, abandon: abandonInstructionAdoption, status: inspectInstructionAdoption, context: consumeInstructionContext }
const fields = {
  plan: ['workspaceId', 'scope', 'harnessId', 'lessonId', 'target', 'slot', 'mode'],
  apply: ['workspaceId', 'scope', 'harnessId', 'lessonId', 'target', 'slot', 'mode', 'confirm'],
  recover: ['confirm'], abandon: ['confirm', 'destinationDigest'], status: [], context: ['target', 'slot', 'session', 'scope', 'harnessId'],
}
try {
  const [command, ...rest] = process.argv.slice(2)
  if (!methods[command] || rest.length) throw new Error('Usage: atelier practice plan|apply|recover|abandon|status|context (JSON stdin)')
  const chunks = []; let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 256 * 1024) throw new Error('practice request exceeds limit')
    chunks.push(chunk)
  }
  const body = parseJsonRequest(Buffer.concat(chunks), 'practice request')
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(k => !fields[command].includes(k))) throw new Error('invalid practice request fields')
  console.log(JSON.stringify(methods[command]({ ...body, workspaceRoot: process.cwd() }), null, 2))
} catch (error) {
  reportCommandFailure(error)
}
