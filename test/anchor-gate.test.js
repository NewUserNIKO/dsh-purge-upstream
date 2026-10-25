import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../presets/redteam/anchor-gate.mjs'

function gate(config = {}) {
  const hooks = new Map()
  apply({ on: (name, handler) => hooks.set(name, handler) }, {
    bootstrapMaxTokens: 8192,
    ...config,
  })
  const session = { events: [] }
  const agent = { session }
  return {
    session,
    request: (options, payload = { agent }) =>
      hooks.get('agent/request')(payload, async () => options),
    compact() {
      const event = { type: 'compaction/end' }
      session.events.push(event)
      hooks.get('session/event')(session, event)
    },
  }
}

for (const [budget, expected] of [[undefined, 8192], [2048, 2048], [8192, 8192], [16384, 8192]]) {
  test(`bootstrap respects caller budget ${budget}`, async () => {
    const fixture = gate()
    const tools = Object.freeze([{ name: 'fixture_echo' }])
    const options = Object.freeze({ model: 'deepseek-flash', reasoningEffort: 'max', tools,
      ...(budget === undefined ? {} : { maxTokens: budget }) })
    const result = await fixture.request(options)
    assert.deepEqual(result, { ...options, maxTokens: expected })
    assert.equal(options.maxTokens, budget)
    assert.equal(result.tools, tools)
  })
}

test('promotion preserves caller-owned budgets including the bootstrap value', async () => {
  const fixture = gate()
  const options = Object.freeze({ maxTokens: 16384, reasoningEffort: 'max' })
  assert.equal((await fixture.request(options)).maxTokens, 8192)
  fixture.session.events.push({ type: 'assistant/message', data: { message: {
    content: [{ type: 'text', text: 'Fixture response' }],
  } } })
  for (const maxTokens of [2048, 8192, 16384, undefined]) {
    const nextOptions = Object.freeze({ ...options, maxTokens })
    assert.equal(await fixture.request(nextOptions), nextOptions)
  }
})

test('tool promotion and compaction cap each fresh request without mutating options', async () => {
  const fixture = gate()
  const options = Object.freeze({ maxTokens: 16384, reasoningEffort: 'max' })
  assert.equal((await fixture.request(options)).maxTokens, 8192)
  fixture.session.events.push({ type: 'step/start' }, { type: 'tool/call' })
  assert.equal(await fixture.request(options), options)
  fixture.compact()
  assert.equal((await fixture.request(options)).maxTokens, 8192)
  assert.equal(options.maxTokens, 16384)
  const smaller = Object.freeze({ maxTokens: 2048 })
  assert.equal((await fixture.request(smaller)).maxTokens, 2048)
})

test('requests without a session pass through unchanged', async () => {
  const fixture = gate()
  const options = Object.freeze({ maxTokens: 8192, reasoningEffort: 'max' })
  assert.equal(await fixture.request(options, {}), options)
})

for (const budget of [undefined, 16384]) {
  test(`promotion restores budget ${budget} from a persisted bootstrap request`, async () => {
    const fixture = gate()
    const original = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max',
      ...(budget === undefined ? {} : { maxTokens: budget }) }
    const capped = await fixture.request(Object.freeze(original))
    // DSH saves request/header and clones its config into the next proposal.
    assert.equal((await fixture.request(structuredClone(capped))).maxTokens, 8192)
    fixture.session.events.push({ type: 'assistant/message' })
    const restored = await fixture.request(Object.freeze(structuredClone(capped)))
    assert.deepEqual(restored, original)
    assert.equal(capped.maxTokens, 8192)
    assert.equal(await fixture.request(restored), restored)
    fixture.compact()
    const recapped = await fixture.request(restored)
    assert.equal(recapped.maxTokens, 8192)
    fixture.session.events.push({ type: 'assistant/message' })
    assert.deepEqual(await fixture.request(structuredClone(recapped)), original)
  })
}

test('a changed caller budget replaces ownership of the earlier bootstrap cap', async () => {
  const fixture = gate()
  await fixture.request({ maxTokens: 16384 })
  const changed = Object.freeze({ maxTokens: 4096 })
  assert.equal(await fixture.request(changed), changed)
  fixture.session.events.push({ type: 'assistant/message' })
  assert.equal(await fixture.request(changed), changed)
})

test('a bootstrap cap is not restored into a different model or agent', async () => {
  for (const change of ['model', 'agent']) {
    const fixture = gate()
    const capped = await fixture.request({ provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 16384 })
    fixture.session.events.push({ type: 'assistant/message' })
    const options = Object.freeze(change === 'model' ? { ...capped, model: 'fixture-other' } : capped)
    const payload = change === 'agent' ? { agent: { session: fixture.session } } : undefined
    assert.equal(await fixture.request(options, payload), options)
  }
})
