import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { refuse } from './errors.mjs'

// Where later work plugs in without touching a shared file: every module in
// `contributions/` beside this file is a contribution. Its default export is
// `{ id, register({ extensions, operations }) }`. The command and the service
// entry both load the directory, so an apply operation registered there is
// the one the service dispatches to and the one `status` reports.
//
// Only regular `.mjs` files directly in that directory are loaded, in name
// order. The directory ships with the package; nothing outside it is read.

export const CONTRIBUTIONS_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contributions')

export async function loadContributions({ directory = CONTRIBUTIONS_DIRECTORY } = {}) {
  let entries
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const contributions = []
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.mjs')).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const loaded = await import(pathToFileURL(path.join(directory, entry.name)).href)
    if (loaded.default === null || typeof loaded.default !== 'object' || typeof loaded.default.register !== 'function') refuse('invalid-extension', 'a contribution module must export { id, register } by default', { file: entry.name })
    contributions.push(loaded.default)
  }
  return contributions
}
