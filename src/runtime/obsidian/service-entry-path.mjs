import { fileURLToPath } from 'node:url'

// The absolute path of the maintenance service entry, kept in its own module
// so that nothing which needs the path has to import the entry itself. The
// entry awaits at top level (it loads the command contributions before it
// serves), and a module that both reaches it through a static import and is
// itself reached by that load would deadlock the process: the contribution
// graph waits for the entry, the entry waits for the contribution graph.
export const SERVICE_ENTRY_PATH = fileURLToPath(new URL('./service-main.mjs', import.meta.url))
