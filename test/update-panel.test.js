import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

function host(scenario) {
  return JSON.parse(execFileSync(process.execPath, [
    '--experimental-vm-modules', '--no-warnings',
    fileURLToPath(new URL('./helpers/update-panel-host.mjs', import.meta.url)), scenario,
  ], { encoding: 'utf8', timeout: 10000 }))
}

for (const scenario of ['check', 'version']) {
  test(`redteam ${scenario} uses protected source and detects same-version commit updates`, () => {
    const { result, calls } = host(scenario)
    assert.deepEqual(calls, [{ op: 'check' }])
    assert.equal(result.updateAvailable, true)
    assert.equal(result.current, '1.1.73')
    assert.equal(result.latest, '1.1.73')
    assert.equal(result.sourceRepository, 'NewUserNIKO/dsh-purge-upstream')
  })
}

test('redteam update delegates to the protected transaction without installing or restarting', () => {
  const { result, calls } = host('apply')
  assert.deepEqual(calls, [{ op: 'apply' }])
  assert.equal(result.filesUpdated, true)
  assert.equal(result.needsApply, true)
  assert.equal(result.restartAfter, false)
  assert.equal(result.backupPath, '/fixture/backups/one')
})

test('running agents block redteam updates before any updater action', () => {
  const { result, calls } = host('blocked')
  assert.deepEqual(calls, [])
  assert.equal(result.ok, false)
  assert.match(result.error, /Fixture task/)
})

function section(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end)
}

test('main panel file-update response never schedules a restart or reload', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const block = section(source, 'const postUpdate = useCallback(', 'const doUpdate = useCallback(')
  const effects = []
  const done = { ok: true, filesUpdated: true, needsApply: true, restartAfter: true, needsFullQuit: true }
  const context = {
    useCallback: (fn) => fn, setUpdateBusy() {}, setUpdateJob() {},
    tRef: { current: (key) => key }, setUpdateNotice() {}, applyUpdateInfo() {},
    apiJson: async () => done,
    suppressRestartAsk: {}, setAskRestart: () => effects.push('restart'),
    setTimeout: () => effects.push('timer'),
    window: { location: { reload: () => effects.push('reload') } },
  }
  const post = vm.runInNewContext(block + '\npostUpdate', context)
  assert.equal(await post({ op: 'apply' }, 'done', 'stable'), done)
  assert.deepEqual(effects, [])
})

test('main panel asks the protected updater for its default branch rather than master', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const block = section(source, 'const doUpdate = useCallback(', 'const changeChannel = useCallback(')
  const requests = []
  const run = vm.runInNewContext(block + '\ndoUpdate', {
    useCallback: (fn) => fn,
    postUpdate: async (body) => { requests.push(JSON.parse(JSON.stringify(body))) },
  })
  run('stable')
  assert.deepEqual(requests, [{ op: 'apply', channel: 'stable' }])
})

for (const file of ['../lib/redteam/client.js', '../client.js']) {
  test(`${file} redteam update completion keeps the page open and shows its backup`, async () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    const block = section(source, 'function VersionBar(props) {', '/* ---------------------------------------------------------- 常驻面板主体 */')
    const effects = []
    let index = 0
    const state = [{ current: '1.1.73', latest: '1.1.73', updateAvailable: true,
      install: { mode: 'package' } }, null, false, true, null, 0]
    const requests = []
    const context = {
      React: {
        useState(initial) {
          const n = index++
          return [n < state.length ? state[n] : initial, (value) => { state[n] = value }]
        },
        useEffect() {},
      },
      h: (type, props, ...children) => ({ type, props, children }),
      api: async (request) => {
        requests.push(JSON.parse(JSON.stringify(request)))
        return { ok: true, filesUpdated: true, needsApply: true,
          backupPath: '/fixture/backups/one', message: 'Files updated; reload manually later.' }
      },
      setInterval: () => effects.push('timer'), clearInterval() {},
      window: { location: { reload: () => effects.push('reload') } },
    }
    const render = vm.runInNewContext(block + '\nVersionBar', context)
    const tree = render({})
    function findApply(node) {
      if (node?.type === 'button' && node.props?.onClick?.name === 'apply') return node.props.onClick
      for (const child of node?.children ?? []) {
        const found = findApply(child)
        if (found) return found
      }
    }
    const apply = findApply(tree)
    assert.equal(typeof apply, 'function')
    apply()
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(requests, [{ op: 'updateApply' }])
    assert.deepEqual(effects, [])
    assert.match(state[4].ok, /fixture\/backups\/one/)
  })
}
