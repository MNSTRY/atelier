export function refuse(code) {
  const error = new Error(`graph-view: ${code}`)
  error.code = code
  throw error
}
