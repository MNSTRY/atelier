// A command's own refusal prints its message. Anything that can carry host
// detail (Node system errors, child-process failures, parser excerpts, or a
// message naming an absolute path) is rethrown to the command executor, which
// prints only a typed code or `[internal-error]` with Node's code.
const TYPED_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const ABSOLUTE_PATH = /(?:^|[\s'"(=:,])(?:\/[^\s'"/]+|[A-Za-z]:\\)/

export function safeCommandMessage(error) {
  if (!(error instanceof Error) || error instanceof SyntaxError) return null
  if (error.code !== undefined && !(typeof error.code === 'string' && (TYPED_CODE.test(error.code) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(error.code) && !/^ERR_/.test(error.code)))) return null
  if (['errno', 'syscall', 'path', 'status', 'stderr', 'stdout', 'cmd'].some(key => key in error)) return null
  if (typeof error.message !== 'string' || ABSOLUTE_PATH.test(error.message)) return null
  return error.message
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
