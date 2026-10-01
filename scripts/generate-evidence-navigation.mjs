import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = 'contracts/atelier-evidence-navigation.v1.schema.json'
const sourceBytes = fs.readFileSync(path.join(root, source))
const schema = JSON.parse(sourceBytes)
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const header = '// Generated from contracts. Run node scripts/generate-evidence-navigation.mjs.\n'
const definitions = Object.keys(schema.$defs)
const files = new Map([['src/evidence-navigation/schema.generated.mjs', header +
  'export const evidenceSchema = ' + JSON.stringify(schema, null, 2) + '\n']])
const names = Object.fromEntries(definitions.map(name => [name, name[0].toUpperCase() + name.slice(1)]))
function type(node) {
  if (node.$ref) return names[node.$ref.split('/').at(-1)]
  if (Object.hasOwn(node, 'const')) return JSON.stringify(node.const)
  if (node.enum) return node.enum.map(value => JSON.stringify(value)).join('|')
  if (node.anyOf || node.oneOf) return (node.anyOf ?? node.oneOf).map(value => `(${type(value)})`).join('|')
  if (node.type === 'array') return `Array<(${type(node.items)})>`
  if (node.type === 'object') return '{' + Object.entries(node.properties ?? {}).map(([name, value]) =>
    `${name}${node.required?.includes(name) ? '' : '?'}: (${type(value)})`).join(', ') + '}'
  if (['string', 'number', 'boolean', 'null'].includes(node.type)) return node.type
  if (node.type === 'integer') return 'number'
  throw new Error('unsupported declaration schema')
}
files.set('src/evidence-navigation/types.mjs', header + definitions.map(name =>
  `/** @typedef {${type(schema.$defs[name])}} ${names[name]} */`).join('\n') + '\nexport {}\n')

const packageVersion = name => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'))).version
if (packageVersion('ajv') !== '8.20.0' || packageVersion('ajv-formats') !== '3.0.1') {
  throw new Error('evidence generator toolchain differs from the pinned contract')
}
const manifest = { schema: 'atelier-evidence-navigation-generation@v1', contract: schema.$id,
  contractDigest: hash(sourceBytes), generatorVersion: 2,
  validator: { name: 'ajv', version: packageVersion('ajv'), schemaDraft: '2020-12' },
  formats: { name: 'ajv-formats', version: packageVersion('ajv-formats'), mode: 'full' },
  distribution: 'schema-and-types-with-package-validator',
  files: Object.fromEntries([...files].map(([name, value]) => [name, hash(value)])) }
files.set('src/evidence-navigation/generation.mjs', header +
  'export const evidenceGeneration = ' + JSON.stringify(manifest, null, 2) + '\n')
for (const [relative, content] of files) {
  const target = path.join(root, relative)
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) throw new Error('evidence navigation generation drift')
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}
