import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const tools = JSON.parse(execFileSync(process.execPath, [
  '--experimental-vm-modules', '--no-warnings',
  fileURLToPath(new URL('./helpers/capture-redteam-tools.mjs', import.meta.url)),
], { encoding: 'utf8', timeout: 10_000 }))

function checkExplicitObjectOpenness(schema, path) {
  // DSH 0.2.1's author-schema compiler rejects every object node unless
  // additionalProperties is explicitly boolean (including nested objects).
  if (schema.type === 'object') {
    assert.equal(typeof schema.additionalProperties, 'boolean', `${path}.additionalProperties must be explicit`)
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      checkExplicitObjectOpenness(child, `${path}.${name}`)
    }
  }
  if (schema.items) checkExplicitObjectOpenness(schema.items, `${path}[]`)
  for (const [index, child] of (schema.oneOf ?? []).entries()) {
    checkExplicitObjectOpenness(child, `${path}.oneOf[${index}]`)
  }
}

test('all registered tool schemas declare nested object openness for DSH 0.2.1', () => {
  assert.ok(tools.length > 0)
  assert.equal(new Set(tools.map(({ name }) => name)).size, tools.length)
  for (const tool of tools) {
    for (const [name, schema] of Object.entries(tool.parameters)) {
      checkExplicitObjectOpenness(schema, `${tool.name}.${name}`)
    }
    checkExplicitObjectOpenness(tool.output, `${tool.name}.output`)
  }
})

test('evidence payload objects remain open and required results remain required', () => {
  for (const [name, fields] of [
    ['redteam_evidence_record', ['parameters', 'result']],
    ['redteam_evidence_verify', ['parameters', 'result']],
    ['redteam_evidence_upgrade', ['verified_result']],
  ]) {
    const tool = tools.find((tool) => tool.name === name)
    assert.ok(tool, `${name} must register`)
    for (const field of fields) {
      assert.equal(tool.parameters[field].type, 'object')
      assert.equal(tool.parameters[field].additionalProperties, true, `${name}.${field} must accept arbitrary evidence keys`)
    }
    if (fields.includes('result')) assert.equal(tool.parameters.result.required, true)
  }
})
