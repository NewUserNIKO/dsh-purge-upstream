import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'

const calls = []
const forbidden = () => { throw new Error('panel fixture forbids installers, host actions and live I/O') }
const scenario = process.argv[2]
const checked = {
  ok: true, hasUpdate: true, localVersion: '1.1.73', remoteVersion: '1.1.73',
  localSha: '1111111', remoteSha: '2222222',
  sourceRepository: 'NewUserNIKO/dsh-purge-upstream', sourceRef: 'codex/reliability-fixes',
}
const completed = {
  ok: true, filesUpdated: true, applied: false, needsApply: true,
  restartAfter: false, reloadClient: false, backupPath: '/fixture/backups/one',
  localVersion: '1.1.73', message: 'Files updated; reload and Apply manually later.',
}
const protectedUpdater = {
  async checkUpdate() { calls.push({ op: 'check' }); return checked },
  async handleUpdateOp(request) { calls.push(JSON.parse(JSON.stringify(request))); return completed },
}
const imports = {
  'node:url': { fileURLToPath },
  'node:path': { resolve: nodePath.resolve, join: nodePath.join },
  'node:fs': {
    existsSync: () => true,
    readFileSync: (name) => {
      assert.equal(name, '/fixture/profile/package.json')
      return JSON.stringify({ dependencies: { 'dsh-purge': 'link:/fixture/plugin' } })
    },
    writeFileSync: forbidden, mkdirSync: forbidden, readdirSync: forbidden, realpathSync: forbidden,
  },
  'node:os': { homedir: () => '/fixture/home' },
  'node:child_process': { spawn: forbidden, execFileSync: forbidden },
  'node:https': { request: forbidden },
  './store-core.js': { dispatch: forbidden, dispatchAsync: forbidden },
  './skill-availability.js': {
    checkSkill: forbidden, officialSkillSummaries: forbidden, skillLibraryOf: forbidden, summarizeSkills: forbidden,
  },
  './settings.js': {
    maxAgentsOf: forbidden, maxAgentsSourceOf: forbidden, saveMaxAgents: forbidden,
    DEFAULT_MAX_AGENTS: 3, MAX_AGENTS_LIMIT: 10,
  },
  './platform-config.js': {
    loadPlatformConfig: forbidden, mergeConfigEnv: forbidden, redteamRoot: forbidden,
    envAdaptStatus: forbidden, markEnvAdaptSkip: forbidden, platformSummary: forbidden,
    savePlatformConfig: forbidden, assignToolkitFolder: forbidden,
  },
}
const sourceUrl = new URL('../../lib/redteam/ui.js', import.meta.url)
const context = createContext({
  process: { platform: 'darwin', env: {}, exit: forbidden },
  setTimeout: forbidden, setInterval: forbidden, clearTimeout: forbidden,
})
function synthetic(exports) {
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
  }, { context })
}
const updater = synthetic(protectedUpdater)
await updater.link(() => { throw new Error('unexpected updater dependency') })
await updater.evaluate()
const module = new SourceTextModule((await readFile(sourceUrl, 'utf8')) + '\nexport { handleUpdateOp };\n', {
  context,
  initializeImportMeta(meta) { meta.url = sourceUrl.href },
  importModuleDynamically: async (specifier) => {
    assert.equal(specifier, '../update.js')
    return updater
  },
})
await module.link((specifier) => {
  assert.ok(Object.hasOwn(imports, specifier), `unexpected static import ${specifier}`)
  return synthetic(imports[specifier])
})
await module.evaluate({ timeout: 5000 })
const ctx = {
  baseUrl: 'file:///fixture/profile',
  redteam: { plugin: { name: 'dsh-purge', version: '1.1.73' } },
  get(name) {
    if (name === 'sessions') return { list: () => [{ id: 'root', header: {} }] }
    if (name === 'subagents') return { listChildren: async () => scenario === 'blocked'
      ? [{ id: 'child', kind: 'child', activity: 'running', label: 'Fixture task' }] : [] }
    return undefined
  },
}
const op = scenario === 'check' ? 'updateCheck' : scenario === 'version' ? 'version' : 'updateApply'
const result = await module.namespace.handleUpdateOp(ctx, { op })
process.stdout.write(JSON.stringify({ result, calls }))
