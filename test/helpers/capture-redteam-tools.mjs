import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'

// Evaluate registration with closed imports: no real host lookup, store, disk
// access, event callback, or tool handler can run in this fixture.
const forbidden = () => { throw new Error('unexpected dependency call during tool registration') }
const imports = {
  'node:module': {
    createRequire: () => (name) => {
      assert.equal(name, '@deepseek-ai/dsh-tools')
      return { defineTool: (options) => options }
    },
  },
  'node:fs': { existsSync: forbidden, realpathSync: forbidden },
  'node:os': { homedir: forbidden },
  'node:path': { dirname: forbidden, join: forbidden },
  './store-core.js': {
    ROLE_TITLES: { coordinator: 'Coordinator' },
    PLANNER_ROLE: 'coordinator',
    ROLE_ORDER: ['coordinator'],
  },
  './skill-availability.js': {
    bundledSkillSummaries: forbidden, checkSkill: forbidden,
    summarizeSkills: forbidden, expandSkillPath: forbidden,
    redteamSummariesForCheck: forbidden,
  },
  './platform-config.js': {
    loadPlatformConfig: forbidden, mergeConfigEnv: forbidden,
    platformSummary: forbidden, toolkitDirOf: forbidden,
  },
  './settings.js': { maxAgentsOf: forbidden, DEFAULT_MAX_AGENTS: 3, MAX_AGENTS_LIMIT: 10 },
  './evidence-ledger.mjs': { EvidenceLedger: forbidden, UnknownRegistry: forbidden },
}
const sourceUrl = new URL('../../lib/redteam/tools.js', import.meta.url)
const context = createContext({})
const module = new SourceTextModule(await readFile(sourceUrl, 'utf8'), {
  context,
  initializeImportMeta(meta) { meta.url = sourceUrl.href },
})
await module.link((specifier) => {
  assert.ok(Object.hasOwn(imports, specifier), `unexpected import: ${specifier}`)
  const exports = imports[specifier]
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  }, { context })
})
await module.evaluate({ timeout: 5000 })
const tools = []
module.namespace.apply({
  redteam: Object.freeze({}),
  effect: (callback) => { assert.equal(typeof callback, 'function') },
  tools: {
    register(tool) {
      assert.equal(typeof tool.execute, 'function')
      tools.push({ name: tool.name, parameters: tool.parameters, output: tool.output.schema })
    },
  },
})
process.stdout.write(JSON.stringify(tools))
