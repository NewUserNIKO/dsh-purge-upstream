import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installPreparedUpdate } from '../lib/update-install.js'

const repo = new URL('../', import.meta.url)
const sha = 'a'.repeat(40)

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-install-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const sourceDir = path.join(root, 'candidate')
  await fs.mkdir(sourceDir)
  const pkg = JSON.parse(await fs.readFile(new URL('package.json', repo), 'utf8'))
  for (const name of ['package.json', ...pkg.files.filter((x) => !x.startsWith('!'))]) {
    await fs.cp(new URL(name, repo), path.join(sourceDir, name), { recursive: true })
  }
  const dest = path.join(root, 'installed')
  await fs.cp(sourceDir, dest, { recursive: true })
  await fs.writeFile(path.join(dest, 'README.md'), 'original installation')
  await fs.writeFile(path.join(sourceDir, 'README.md'), 'new installation')
  return { root, sourceDir, dest, backupRoot: path.join(root, 'backups') }
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', stdio: 'pipe',
  }).trim()
}

async function gitFixture(f) {
  const dir = path.join(f.root, 'checkout')
  await fs.cp(f.dest, dir, { recursive: true })
  git(dir, 'init', '--template=')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fixture@example.invalid')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'old')
  const before = git(dir, 'rev-parse', 'HEAD')
  const branch = git(dir, 'symbolic-ref', 'HEAD')
  await fs.writeFile(path.join(dir, 'README.md'), 'new installation')
  await fs.writeFile(path.join(dir, 'new-tracked.txt'), 'new tracked file')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'new')
  const target = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'reset', '--hard', before)
  return { dir, before, branch, target }
}

test('a prepared archive updates files and metadata while retaining a backup', async (t) => {
  const f = await fixture(t)
  const metadata = path.join(f.root, 'profile.json')
  await fs.writeFile(metadata, 'old profile')
  const result = await installPreparedUpdate({ ...f, sha, jobs: [{ kind: 'zip', dir: f.dest }], metadataFiles: [metadata],
    writeMetadata: async () => { await fs.writeFile(metadata, sha) },
  })
  assert.equal(await fs.readFile(path.join(f.dest, 'README.md'), 'utf8'), 'new installation')
  assert.equal(await fs.readFile(metadata, 'utf8'), sha)
  assert.ok((await fs.stat(result.backupPath)).isDirectory())
})

test('metadata failure restores all archive destinations and removes newly created state', async (t) => {
  const f = await fixture(t)
  const second = path.join(f.root, 'second')
  await fs.cp(f.dest, second, { recursive: true })
  const metadata = path.join(f.root, 'new-state.json')
  await assert.rejects(installPreparedUpdate({ ...f, sha, jobs: [
    { kind: 'zip', dir: f.dest }, { kind: 'zip', dir: second },
  ], metadataFiles: [metadata], writeMetadata: async () => {
    await fs.writeFile(metadata, sha)
    throw new Error('fixture metadata failure')
  } }), (error) => error.rolledBack === true && /fixture metadata failure/.test(error.message))
  for (const dir of [f.dest, second]) assert.equal(await fs.readFile(path.join(dir, 'README.md'), 'utf8'), 'original installation')
  await assert.rejects(fs.stat(metadata), { code: 'ENOENT' })
})

test('all destinations are preflighted before a dirty later Git checkout can change the first', async (t) => {
  const f = await fixture(t)
  const g = await gitFixture(f)
  await fs.writeFile(path.join(g.dir, 'README.md'), 'user edit')
  await assert.rejects(installPreparedUpdate({ ...f, sha: g.target, jobs: [
    { kind: 'zip', dir: f.dest }, { kind: 'git', dir: g.dir },
  ] }), /本地|修改|dirty/)
  assert.equal(await fs.readFile(path.join(f.dest, 'README.md'), 'utf8'), 'original installation')
  assert.equal(await fs.readFile(path.join(g.dir, 'README.md'), 'utf8'), 'user edit')
  assert.equal(git(g.dir, 'rev-parse', 'HEAD'), g.before)
})

test('Git update fast-forwards without changing branch and rolls back HEAD on later failure', async (t) => {
  const f = await fixture(t)
  const g = await gitFixture(f)
  const metadata = path.join(f.root, 'state.json')
  await fs.writeFile(metadata, 'previous')
  await assert.rejects(installPreparedUpdate({ ...f, sha: g.target, jobs: [{ kind: 'git', dir: g.dir }],
    metadataFiles: [metadata], writeMetadata: async () => {
      assert.equal(git(g.dir, 'rev-parse', 'HEAD'), g.target)
      await fs.writeFile(metadata, 'next')
      throw new Error('late failure')
    },
  }), (error) => error.rolledBack === true)
  assert.equal(git(g.dir, 'rev-parse', 'HEAD'), g.before)
  assert.equal(git(g.dir, 'symbolic-ref', 'HEAD'), g.branch)
  assert.equal(git(g.dir, 'status', '--porcelain'), '')
  assert.equal(await fs.readFile(metadata, 'utf8'), 'previous')
  await installPreparedUpdate({ ...f, sha: g.target, jobs: [{ kind: 'git', dir: g.dir }] })
  assert.equal(git(g.dir, 'rev-parse', 'HEAD'), g.target)
  assert.equal(git(g.dir, 'symbolic-ref', 'HEAD'), g.branch)
  assert.equal(git(g.dir, 'status', '--porcelain'), '')
})

test('Git update refuses backward or diverged revisions even with force requested', async (t) => {
  const f = await fixture(t)
  const g = await gitFixture(f)
  git(g.dir, 'reset', '--hard', g.target)
  await assert.rejects(installPreparedUpdate({ ...f, sha: g.before, force: true, jobs: [{ kind: 'git', dir: g.dir }] }), /快进|领先|分叉/)
  assert.equal(git(g.dir, 'rev-parse', 'HEAD'), g.target)
  git(g.dir, 'reset', '--hard', g.before)
  await fs.writeFile(path.join(g.dir, 'local.txt'), 'local commit')
  git(g.dir, 'add', '.')
  git(g.dir, 'commit', '-m', 'local work')
  const local = git(g.dir, 'rev-parse', 'HEAD')
  await assert.rejects(installPreparedUpdate({ ...f, sha: g.target, jobs: [{ kind: 'git', dir: g.dir }] }), /快进|领先|分叉/)
  assert.equal(git(g.dir, 'rev-parse', 'HEAD'), local)
})

for (const ignored of [false, true]) {
  test(`candidate collisions preserve ${ignored ? 'ignored' : 'untracked'} user files`, async (t) => {
    const f = await fixture(t)
    const g = await gitFixture(f)
    await fs.writeFile(path.join(g.dir, 'new-tracked.txt'), 'local content')
    if (ignored) {
      await fs.mkdir(path.join(g.dir, '.git/info'), { recursive: true })
      await fs.writeFile(path.join(g.dir, '.git/info/exclude'), 'new-tracked.txt\n')
    }
    await assert.rejects(installPreparedUpdate({ ...f, sha: g.target, jobs: [{ kind: 'git', dir: g.dir }] }), /未跟踪|忽略|覆盖|冲突/)
    assert.equal(await fs.readFile(path.join(g.dir, 'new-tracked.txt'), 'utf8'), 'local content')
    assert.equal(git(g.dir, 'rev-parse', 'HEAD'), g.before)
  })
}

test('invalid candidates and nested destinations cannot mutate installed files', async (t) => {
  const f = await fixture(t)
  await assert.rejects(installPreparedUpdate({ ...f, sha, jobs: [
    { kind: 'zip', dir: f.dest }, { kind: 'zip', dir: path.join(f.dest, 'lib') },
  ] }), /嵌套|重叠|overlap|package/)
  await fs.unlink(path.join(f.sourceDir, 'lib/index.js'))
  await assert.rejects(installPreparedUpdate({ ...f, sha, jobs: [{ kind: 'zip', dir: f.dest }] }))
  assert.equal(await fs.readFile(path.join(f.dest, 'README.md'), 'utf8'), 'original installation')
})

test('an unfinished Git operation blocks all destinations and remains intact', async (t) => {
  const f = await fixture(t)
  const g = await gitFixture(f)
  await fs.writeFile(path.join(g.dir, '.git/MERGE_HEAD'), g.target + '\n')
  await assert.rejects(installPreparedUpdate({ ...f, sha: g.target, jobs: [
    { kind: 'zip', dir: f.dest }, { kind: 'git', dir: g.dir },
  ] }), /Git 操作未完成/)
  assert.equal(await fs.readFile(path.join(g.dir, '.git/MERGE_HEAD'), 'utf8'), g.target + '\n')
  assert.equal(await fs.readFile(path.join(f.dest, 'README.md'), 'utf8'), 'original installation')
})

test('replacing an installed file symlink cannot write outside the package', async (t) => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'user-note.txt')
  await fs.writeFile(outside, 'outside content')
  await fs.unlink(path.join(f.dest, 'README.md'))
  await fs.symlink(outside, path.join(f.dest, 'README.md'))
  await installPreparedUpdate({ ...f, sha, jobs: [{ kind: 'zip', dir: f.dest }] })
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside content')
  assert.equal(await fs.readFile(path.join(f.dest, 'README.md'), 'utf8'), 'new installation')
  assert.equal((await fs.lstat(path.join(f.dest, 'README.md'))).isSymbolicLink(), false)
})
