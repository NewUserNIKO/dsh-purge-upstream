import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

for (const mode of ['success', 'metadata-failure', 'invalid-ref', 'check', 'archive-rollback']) {
  test(`protected updater integration: ${mode}`, () => {
    const output = execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings',
      fileURLToPath(new URL('./helpers/update-runtime.mjs', import.meta.url)), mode,
    ], { encoding: 'utf8', timeout: 20000, stdio: 'pipe' })
    assert.equal(JSON.parse(output).passed, true)
  })
}
