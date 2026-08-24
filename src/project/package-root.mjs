import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function nativePathFromFileUrl(value) {
  return fileURLToPath(value instanceof URL ? value : new URL(value))
}

export function packageRootFrom(moduleUrl) {
  return path.resolve(nativePathFromFileUrl(new URL('../..', moduleUrl)))
}
