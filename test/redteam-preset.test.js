import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const installerUrl = new URL('../lib/redteam/index.js', import.meta.url).href
const bundledScript = new URL('../presets/redteam/anchor-gate.mjs', import.meta.url)

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-preset-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  // Both home locations must be isolated: skill sync also considers os.homedir().
  const userHome = path.join(root, 'user-home')
  const dshHome = path.join(root, 'dsh-home')
  await fs.mkdir(userHome)
  const dir = path.join(dshHome, '.agent-presets', 'redteam')
  return {
    file: path.join(dir, 'agent.cordis.yml'),
    script: path.join(dir, 'anchor-gate.mjs'),
    install(force = false) {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { installPreset } = await import(process.argv[1]);
        process.stdout.write(JSON.stringify(installPreset({ force: process.argv[2] === 'true' })));
      `, installerUrl, String(force)], {
        env: { ...process.env, HOME: userHome, USERPROFILE: userHome, DSH_HOME: dshHome },
        encoding: 'utf8', stdio: 'pipe',
      })
      return JSON.parse(output)
    },
  }
}

function customize(text) {
  assert.match(text, /bootstrapMaxTokens: 8192/)
  return text.replace('bootstrapMaxTokens: 8192', 'bootstrapMaxTokens: 2048')
    .replace('maxBootstrapSteps: 2', 'maxBootstrapSteps: 6')
    .replace('anchorGate: true', 'anchorGate: false')
    .replace('instructionHint: true', 'instructionHint: false')
}

test('normal preset sync updates code while retaining customized anchor settings', async (t) => {
  const f = await fixture(t)
  assert.equal(f.install().action, 'installed')
  f.install() // Complete existing one-time delegation/path repairs before customizing.
  const customized = customize(await fs.readFile(f.file, 'utf8'))
  await fs.writeFile(f.file, customized)
  await fs.writeFile(f.script, '// old script\n')
  const result = f.install()
  assert.equal(result.action, 'repaired')
  assert.equal(await fs.readFile(f.file, 'utf8'), customized)
  assert.equal(await fs.readFile(f.script, 'utf8'), await fs.readFile(bundledScript, 'utf8'))
  assert.equal(f.install().action, 'kept')
  assert.equal(await fs.readFile(f.file, 'utf8'), customized)
})

test('forced preset sync explicitly restores the bundled settings', async (t) => {
  const f = await fixture(t)
  f.install()
  const initial = await fs.readFile(f.file, 'utf8')
  await fs.writeFile(f.file, customize(initial))
  assert.equal(f.install(true).action, 'installed')
  assert.equal(await fs.readFile(f.file, 'utf8'), initial)
})

test('normal preset sync adds a missing anchor row once and preserves other content', async (t) => {
  const f = await fixture(t)
  f.install()
  f.install() // Keep this fixture focused on anchor-row repair.
  const initial = await fs.readFile(f.file, 'utf8')
  const start = initial.indexOf('# 锚点门')
  const end = initial.indexOf('- id: redteam-tools')
  assert.ok(start >= 0 && end > start)
  const prefix = initial.slice(0, start)
  const suffix = initial.slice(end) + '\n# personal preset note\n'
  await fs.writeFile(f.file, prefix + suffix)
  assert.match(f.install().repaired, /anchor-gate/)
  const repaired = await fs.readFile(f.file, 'utf8')
  assert.ok(repaired.startsWith(prefix))
  assert.ok(repaired.endsWith(suffix))
  assert.equal(repaired.match(/- id: anchor-gate/g)?.length, 1)
  assert.equal(f.install().action, 'kept')
  assert.equal(await fs.readFile(f.file, 'utf8'), repaired)
})
