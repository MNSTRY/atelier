import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('trusted publishing uploads the exact artifact retained by release:candidate', () => {
  const workflow = fs.readFileSync(path.join(packageRoot, '.github', 'workflows', 'publish.yml'), 'utf8')
  assert.match(workflow, /ATELIER_RELEASE_OUTPUT_DIR="\$CANDIDATE_DIR" npm run prepublishOnly/)
  assert.match(workflow, /npm publish "\$CANDIDATE_TARBALL" --tag "\$NPM_TAG"/)
  assert.doesNotMatch(workflow, /^\s+npm publish --tag/m)
  assert.match(workflow, /if \[ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" \]/)
})
