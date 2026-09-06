// Shared project-location syntax. Command-specific arguments remain owned by
// their command; this parser does not make unknown options globally valid.
export const PROJECT_OPTION_SPEC = Object.freeze({
  project: 'value',
  'project-config': 'value',
  'repo-path': 'value',
})

function invalid(message) {
  const error = new Error(message)
  error.code = 'project-option-invalid'
  error.exitCode = 2
  throw error
}

export function projectOptionAt(argv, index, configArgPrefix = '--project-config=') {
  const arg = argv[index]
  if (typeof arg !== 'string' || !arg.startsWith('--')) return null
  const name = arg.slice(2).split('=')[0]
  const custom = configArgPrefix !== '--project-config=' && arg.startsWith(configArgPrefix)
  if (!custom && !Object.hasOwn(PROJECT_OPTION_SPEC, name)) return null
  const inline = custom || arg.includes('=')
  const value = custom ? arg.slice(configArgPrefix.length) : inline ? arg.slice(arg.indexOf('=') + 1) : argv[index + 1]
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
    invalid(`--${custom ? 'project-config' : name} requires a non-empty value`)
  }
  const option = custom ? 'project-config' : name
  if (option === 'repo-path') {
    const separator = value.indexOf('=')
    if (separator < 1 || !value.slice(0, separator).trim() || !value.slice(separator + 1).trim()) {
      invalid('--repo-path requires NAME=PATH')
    }
  }
  return { name: option, value, nextIndex: index + (inline ? 1 : 2) }
}

export function parseProjectOptions(argv = [], configArgPrefix = '--project-config=') {
  let project = null
  const repoPaths = new Map()
  const remaining = []
  for (let index = 0; index < argv.length;) {
    const option = projectOptionAt(argv, index, configArgPrefix)
    if (!option) {
      remaining.push(argv[index++])
      continue
    }
    if (option.name === 'repo-path') {
      const separator = option.value.indexOf('=')
      repoPaths.set(option.value.slice(0, separator).trim(), option.value.slice(separator + 1))
    } else if (project === null) {
      // Preserve the resolver's first project selection and last named repo
      // override behavior, including aliases in the same invocation.
      project = option.value.trim()
    }
    index = option.nextIndex
  }
  return { project, repoPaths, remaining }
}
