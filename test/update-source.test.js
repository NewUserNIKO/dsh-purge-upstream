import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { archiveUrl, isProtectedRef, validateUpdatePackage } from '../lib/update-source.js'

const packageUrl = new URL('../package.json', import.meta.url)
const marker = { repository: 'NewUserNIKO/dsh-purge-upstream', branch: 'codex/reliability-fixes', policyVersion: 1 }
const roots = ['lib', 'bin', 'docs', 'presets', 'scripts', 'client.js', 'cordis.patch.yml',
  'screenshots.json', 'package.json', 'README.md', 'README.zh-CN.md', 'LICENSE', 'NOTICE']
const entrypoints = ['lib/index.js', 'client.js', 'lib/redteam/index.js', 'lib/redteam/store.js',
  'lib/redteam/ui.js', 'lib/redteam/tools.js', 'bin/dsh-purge.js']

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-source-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  for (const name of roots) {
    if (['lib', 'bin', 'docs', 'presets', 'scripts'].includes(name)) await fs.mkdir(path.join(dir, name))
    else await fs.writeFile(path.join(dir, name), 'fixture')
  }
  for (const name of entrypoints) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), 'throw new Error("candidate code must not execute")\n')
  }
  const pkg = { ...JSON.parse(await fs.readFile(packageUrl, 'utf8')), dshPurgeUpdate: { ...marker } }
  const save = () => fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg))
  await save()
  return { dir, pkg, save }
}

test('archive requests stay on the protected fork and encode its branch', () => {
  assert.equal(archiveUrl('zip', 'codex/reliability-fixes'),
    'https://codeload.github.com/NewUserNIKO/dsh-purge-upstream/zip/refs/heads/codex%2Freliability-fixes')
  assert.equal(archiveUrl('tar.gz', 'codex/reliability-fixes'),
    'https://codeload.github.com/NewUserNIKO/dsh-purge-upstream/tar.gz/refs/heads/codex%2Freliability-fixes')
  const sha = '0123456789abcdef0123456789abcdef01234567'
  assert.equal(archiveUrl('zip', sha), `https://codeload.github.com/NewUserNIKO/dsh-purge-upstream/zip/${sha}`)
  assert.equal(isProtectedRef(sha), true)
  for (const ref of ['master', 'main', 'beta', 'v1.1.73', '1.1.73', '0123456', '../master',
    'codex/reliability-fixes/extra', ' codex/reliability-fixes', 'https://example.invalid/package.zip', '', null]) {
    assert.equal(isProtectedRef(ref), false, String(ref))
    assert.throws(() => archiveUrl('zip', ref), /ref|来源|分支/)
  }
  assert.throws(() => archiveUrl('tgz', sha), /format|格式/)
})

test('complete candidate validates without executing its entrypoints', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await validateUpdatePackage(f.dir), f.pkg)
})

test('the shipped package can reinstall only from the protected fork branch', async () => {
  const dir = fileURLToPath(new URL('..', import.meta.url))
  const pkg = await validateUpdatePackage(dir)
  assert.equal(pkg.repository.url, 'git+https://github.com/NewUserNIKO/dsh-purge-upstream.git')
  assert.equal(pkg.homepage, 'https://github.com/NewUserNIKO/dsh-purge-upstream#readme')
  assert.equal(pkg.bugs.url, 'https://github.com/NewUserNIKO/dsh-purge-upstream/issues')
  assert.equal(pkg.dsh.install.zip,
    'https://codeload.github.com/NewUserNIKO/dsh-purge-upstream/zip/refs/heads/codex%2Freliability-fixes')
  assert.equal(pkg.dsh.install.tarball,
    'https://codeload.github.com/NewUserNIKO/dsh-purge-upstream/tar.gz/refs/heads/codex%2Freliability-fixes')
  assert.equal(pkg.dsh.install.git, 'https://github.com/NewUserNIKO/dsh-purge-upstream.git#codex/reliability-fixes')
})

for (const change of ['missing marker', 'wrong repository', 'wrong branch', 'wrong policy', 'extra policy', 'wrong name']) {
  test(`rejects ${change} before installation`, async (t) => {
    const f = await fixture(t)
    if (change === 'missing marker') delete f.pkg.dshPurgeUpdate
    if (change === 'wrong repository') f.pkg.dshPurgeUpdate.repository = 'YuJunZhiXue/dsh-purge'
    if (change === 'wrong branch') f.pkg.dshPurgeUpdate.branch = 'master'
    if (change === 'wrong policy') f.pkg.dshPurgeUpdate.policyVersion = 2
    if (change === 'extra policy') f.pkg.dshPurgeUpdate.fallback = 'upstream'
    if (change === 'wrong name') f.pkg.name = 'different-package'
    await f.save()
    await assert.rejects(validateUpdatePackage(f.dir), /policy|策略|name|包名/)
  })
}

test('candidate files cannot shrink the trusted required resources', async (t) => {
  const f = await fixture(t)
  f.pkg.files = ['lib']
  await f.save()
  for (const name of ['README.zh-CN.md', 'NOTICE', 'presets']) {
    const moved = path.join(f.dir, `${name}.saved`)
    await fs.rename(path.join(f.dir, name), moved)
    await assert.rejects(validateUpdatePackage(f.dir), /missing|缺少/)
    await fs.rename(moved, path.join(f.dir, name))
  }
})

test('rejects missing, non-shipped and escaping entrypoint declarations', async (t) => {
  const f = await fixture(t)
  for (const main of ['lib/missing.js', '../outside.js', '/tmp/outside.js', 'C:\\outside.js', 'lib\\index.js', 'outside.js']) {
    await fs.writeFile(path.join(f.dir, 'outside.js'), 'fixture')
    f.pkg.main = main
    await f.save()
    await assert.rejects(validateUpdatePackage(f.dir), /entry|入口|missing|缺少/)
  }
  f.pkg.main = 'lib/index.js'
  delete f.pkg.exports['./redteam/tools']
  await f.save()
  await assert.rejects(validateUpdatePackage(f.dir), /export|导出/)
  f.pkg.exports['./redteam/tools'] = './lib/redteam/tools.js'
  f.pkg.exports['.'] = { default: '../outside.js' }
  await f.save()
  await assert.rejects(validateUpdatePackage(f.dir), /entry|入口/)
  f.pkg.exports['.'] = { default: './lib/index.js' }
  f.pkg.bin = {}
  await f.save()
  await assert.rejects(validateUpdatePackage(f.dir), /bin|命令/)
})

test('rejects symlinks in the package root and shipped descendants', async (t) => {
  const f = await fixture(t)
  const link = f.dir + '-link'
  t.after(() => fs.rm(link, { force: true }))
  await fs.symlink(f.dir, link, 'dir')
  await assert.rejects(validateUpdatePackage(link), /symlink|符号链接/)
  const nested = path.join(f.dir, 'lib/link.js')
  await fs.symlink(path.join(f.dir, 'lib/index.js'), nested)
  await assert.rejects(validateUpdatePackage(f.dir), /symlink|符号链接/)
  await fs.unlink(nested)
  const json = await fs.readFile(path.join(f.dir, 'package.json'))
  await fs.writeFile(path.join(f.dir, 'package.saved.json'), json)
  await fs.unlink(path.join(f.dir, 'package.json'))
  await fs.symlink(path.join(f.dir, 'package.saved.json'), path.join(f.dir, 'package.json'))
  await assert.rejects(validateUpdatePackage(f.dir), /symlink|符号链接/)
})

test('rejects install lifecycle scripts even though the updater never executes them', async (t) => {
  const f = await fixture(t)
  for (const name of ['preinstall', 'install', 'postinstall']) {
    f.pkg.scripts[name] = 'echo unwanted-lifecycle'
    await f.save()
    await assert.rejects(validateUpdatePackage(f.dir), /lifecycle|安装脚本/)
    delete f.pkg.scripts[name]
  }
})

test('validates SemVer rather than accepting a truthy version string', async (t) => {
  const f = await fixture(t)
  for (const version of ['1.1.74', '1.1.74-beta.1+fork.1']) {
    f.pkg.version = version
    await f.save()
    assert.equal((await validateUpdatePackage(f.dir)).version, version)
  }
  for (const version of ['1.1', 'v1.1.73', '01.1.73', '1.1.73-beta.01', '1.1.73+build..one', 'latest', '', 1173]) {
    f.pkg.version = version
    await f.save()
    await assert.rejects(validateUpdatePackage(f.dir), /version|版本/)
  }
})
