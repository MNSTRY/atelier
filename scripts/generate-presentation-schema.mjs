import fs from 'node:fs'
const root = new URL('../', import.meta.url)
const entries = [
  ['presentationSchema', 'atelier-presentation.v1.schema.json'],
  ['paneSchema', 'atelier-pane-presentation.v1.schema.json'],
]
const content = '// Generated from contracts. Run node scripts/generate-presentation-schema.mjs.\n' + entries.map(([name, file]) => {
  const value = JSON.parse(fs.readFileSync(new URL('contracts/' + file, root), 'utf8'))
  return 'export const ' + name + ' = ' + JSON.stringify(value, null, 2) + '\n'
}).join('\n')
const destination = new URL('src/ui/presentation/schema.generated.mjs', root)
if (process.argv.includes('--check')) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content) throw new Error('presentation schema projection drift')
} else fs.writeFileSync(destination, content)
