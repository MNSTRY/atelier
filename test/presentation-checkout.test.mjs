import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

test('presentation generation remains byte-exact in an autocrlf checkout', t => {
  const root = new URL('../', import.meta.url)
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-checkout-'))
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=true', ...args], { cwd: checkout, env, stdio: 'pipe' })
  git('init', '--quiet')
  const generated = 'src/ui/presentation/schema.generated.mjs'
  const files = [
    'contracts/atelier-presentation.v1.schema.json',
    'contracts/atelier-pane-presentation.v1.schema.json',
    'scripts/generate-presentation-schema.mjs',
    generated,
  ]
  if (fs.existsSync(new URL('.gitattributes', root))) files.push('.gitattributes')
  for (const file of files) {
    const destination = path.join(checkout, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(new URL(file, root), destination)
  }
  git('add', '--', ...files)
  fs.unlinkSync(path.join(checkout, generated))
  git('checkout-index', '--force', '--', generated)
  assert.equal(fs.readFileSync(path.join(checkout, generated), 'utf8').includes('\r'), false)
  const check = () => execFileSync(process.execPath, ['scripts/generate-presentation-schema.mjs', '--check'], { cwd: checkout, env, stdio: 'pipe' })
  check()
  // Checkout normalization must not weaken the byte-drift refusal.
  fs.appendFileSync(path.join(checkout, generated), '\n')
  assert.throws(check, /presentation schema projection drift/)
})
