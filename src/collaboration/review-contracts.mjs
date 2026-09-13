import fs from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
for (const name of ['atelier-review'])
  ajv.addSchema(
    JSON.parse(
      fs.readFileSync(
        new URL(`../../contracts/${name}.v1.schema.json`, import.meta.url),
        'utf8',
      ),
    ),
  )
const validators = new Map()
export function validReviewArtifact(kind, value) {
  if (!validators.has(kind))
    validators.set(
      kind,
      ajv.compile({
        $ref: `https://mnstry.ai/schemas/atelier/atelier-review.v1.schema.json#/$defs/${kind}`,
      }),
    )
  return validators.get(kind)(value)
}
