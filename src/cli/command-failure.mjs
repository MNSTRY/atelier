// A command's own refusal prints its message. Anything that can carry host
// detail (Node system errors, child-process failures, parser excerpts, or a
// message naming an absolute path) is rethrown to the command executor, which
// prints only a typed code or `[internal-error]` with Node's code.
// Node's system errors always carry errno and syscall; child-process failures
// carry status and stderr. Atelier's own refusals carry neither, even when
// their code is EEXIST.
const NODE_DETAIL_KEYS = ['errno', 'syscall', 'path', 'dest', 'status', 'signal', 'stderr', 'stdout', 'cmd']
const HOST_ROOT = /(?:^|[\s'"(=,])(?:\/(?:Users|home|private|var|tmp|Volumes|opt|etc|root|mnt|srv|usr|Library|System|Applications)\/|[A-Za-z]:\\|\\\\|~\/)/
// A quoted absolute path, as Node and git print them, whatever its root.
const QUOTED_ABSOLUTE = /['"`](?:\/[^'"`\s/]+\/|[A-Za-z]:[\\/]|\\\\)/

export function safeCommandMessage(error) {
  if (!(error instanceof Error) || error instanceof SyntaxError) return null
  if (typeof error.code === 'string' && error.code.startsWith('ERR_')) return null
  if (NODE_DETAIL_KEYS.some(key => Object.hasOwn(error, key))) return null
  const message = error.message
  // Atelier's own messages never interpolate host paths; Node and git quote
  // theirs. Unquoted text such as a schema instance path `/data/0` stays.
  if (typeof message !== 'string' || HOST_ROOT.test(message) || QUOTED_ABSOLUTE.test(message)) return null
  return message
}

export function reportCommandFailure(error, stream = 'stderr') {
  const message = safeCommandMessage(error)
  if (message === null) throw error
  const text = JSON.stringify({ ok: false, error: message })
  if (stream === 'stdout') console.log(text)
  else console.error(text)
  process.exitCode = 1
}

export function parseJsonRequest(bytes, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error(`${label} must be UTF-8 JSON`) }
}
