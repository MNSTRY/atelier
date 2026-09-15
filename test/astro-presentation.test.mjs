import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')
test('Astro reference keeps build dependencies out of the portable runtime', () => {
  const root = JSON.parse(read('package.json'))
  const example = JSON.parse(read('examples/astro-presentation/package.json'))
  assert.equal(root.dependencies.astro, undefined)
  assert.equal(example.private, true)
  assert.match(example.devDependencies.astro, /^\d+\.\d+\.\d+$/)
  assert.equal(example.dependencies['@mnstry/atelier'], 'file:../..')
  assert(!root.files.includes('examples/'))
})
test('Astro reference consumes checked public tokens without a workspace renderer', () => {
  const source = read('examples/astro-presentation/src/components/ReadingPage.astro')
  assert(source.includes("from '@mnstry/atelier/presentation'"))
  assert(source.includes('tokenVariables(resolveTokens(theme))'))
  assert(!source.includes('renderPresentation('))
  assert(!source.includes('client:load'))
  assert(source.includes('noindex, nofollow'))
})
test('Astro form is explicitly local and unavailable before enhancement', () => {
  const source = read('examples/astro-presentation/src/components/ReadingPage.astro')
  assert.match(source, /type="button" data-demo-check disabled/)
  assert.match(source, /role="group" aria-labelledby="practice-title"/)
  assert.match(source, /input.reportValidity\(\)/)
  assert(!/<form\b/.test(source))
  assert(!/<input[^>]*name=/.test(source))
  assert(!/\bfetch\s*\(|localStorage|sessionStorage|sendBeacon/.test(source))
  assert(source.includes('Nothing was sent or saved.'))
})
