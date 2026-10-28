import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withUpdateRollback } from '../lib/update-transaction.js'

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'purge-transaction-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const backupRoot = path.join(root, 'backups')
  const first = path.join(root, 'first')
  const second = path.join(root, 'second')
  await fs.mkdir(first)
  await fs.mkdir(second)
  await fs.writeFile(path.join(first, 'old.txt'), 'first original')
  await fs.writeFile(path.join(second, 'old.txt'), 'second original')
  return { root, backupRoot, first, second }
}

async function journal(backupPath) {
  return JSON.parse(await fs.readFile(path.join(backupPath, 'journal.json'), 'utf8'))
}

test('success preserves a private backup before applying any target changes', async (t) => {
  const f = await fixture(t)
  const original = path.join(f.first, 'old.txt')
  await fs.chmod(original, 0o640)
  let during
  const result = await withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first], details: { sha: 'fixture' } }, async (backupPath) => {
    during = backupPath
    assert.equal((await journal(during)).stage, 'applying')
    assert.equal(await fs.readFile(path.join(during, 'entries', '0', 'old.txt'), 'utf8'), 'first original')
    await fs.writeFile(original, 'new')
    return 42
  })
  assert.equal(result.value, 42)
  assert.equal(result.backupPath, during)
  assert.equal((await journal(during)).stage, 'committed')
  assert.equal((await fs.stat(during)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(path.join(during, 'entries', '0', 'old.txt'))).mode & 0o777, 0o640)
  assert.equal(await fs.readFile(original, 'utf8'), 'new')
  // The completed journal must allow a later independent transaction.
  await withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => {})
})

test('a later target failure restores every original and removes newly created entries', async (t) => {
  const f = await fixture(t)
  const absent = path.join(f.root, 'new-state.json')
  await fs.chmod(f.first, 0o750)
  let failure
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first, f.second, absent] }, async () => {
    await fs.rm(f.first, { recursive: true })
    await fs.mkdir(f.first)
    await fs.writeFile(path.join(f.first, 'new.txt'), 'new first')
    await fs.writeFile(path.join(f.second, 'old.txt'), 'new second')
    await fs.writeFile(absent, 'new state')
    throw new Error('second destination failed')
  }), (error) => {
    failure = error
    return error.rolledBack === true && error.rollbackErrors.length === 0 && /second destination failed/.test(error.message)
  })
  assert.equal((await journal(failure.backupPath)).stage, 'rolled-back')
  assert.deepEqual(await fs.readdir(f.first), ['old.txt'])
  assert.equal(await fs.readFile(path.join(f.first, 'old.txt'), 'utf8'), 'first original')
  assert.equal(await fs.readFile(path.join(f.second, 'old.txt'), 'utf8'), 'second original')
  assert.equal((await fs.stat(f.first)).mode & 0o777, 0o750)
  await assert.rejects(fs.lstat(absent), { code: 'ENOENT' })
})

test('failure writing the final journal still restores the changed target', async (t) => {
  const f = await fixture(t)
  let backupPath
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => {
    const [entry] = (await fs.readdir(f.backupRoot)).filter((name) => name.startsWith('update-'))
    backupPath = path.join(f.backupRoot, entry)
    await fs.writeFile(path.join(f.first, 'old.txt'), 'new')
    // A directory at the final metadata path makes atomic rename fail on real FS.
    await fs.unlink(path.join(backupPath, 'journal.json'))
    await fs.mkdir(path.join(backupPath, 'journal.json'))
  }), (error) => error.rolledBack === false && error.rollbackErrors.some((item) => /journal/.test(item.path)))
  assert.equal(await fs.readFile(path.join(f.first, 'old.txt'), 'utf8'), 'first original')
  assert.equal(await fs.readFile(path.join(backupPath, 'entries', '0', 'old.txt'), 'utf8'), 'first original')
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => assert.fail('must stay locked')))
})

test('preparation failure never calls apply or rollback and leaves targets alone', async (t) => {
  const f = await fixture(t)
  const invalid = path.join(f.first, 'old.txt', 'not-a-directory')
  let calls = 0
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.second, invalid], rollback: () => { calls += 1 } }, () => { calls += 1 }))
  assert.equal(calls, 0)
  assert.equal(await fs.readFile(path.join(f.first, 'old.txt'), 'utf8'), 'first original')
  assert.equal(await fs.readFile(path.join(f.second, 'old.txt'), 'utf8'), 'second original')
})

test('a failed final preflight preserves external changes made during backup', async (t) => {
  const f = await fixture(t)
  const target = path.join(f.first, 'old.txt')
  let calls = 0
  let failure
  await assert.rejects(withUpdateRollback({
    backupRoot: f.backupRoot,
    paths: [f.first],
    beforeApply: async (backupPath) => {
      assert.equal((await journal(backupPath)).stage, 'prepared')
      assert.equal(await fs.readFile(path.join(backupPath, 'entries', '0', 'old.txt'), 'utf8'), 'first original')
      await fs.writeFile(target, 'external user edit')
      throw new Error('Git state changed during backup')
    },
    rollback: () => { calls += 1 },
  }, async () => { calls += 1 }), (error) => {
    failure = error
    return error.preparationFailed === true && error.rolledBack === false
  })
  assert.equal(calls, 0)
  assert.equal(await fs.readFile(target, 'utf8'), 'external user edit')
  assert.equal((await journal(failure.backupPath)).preparationFailed, true)
  assert.equal((await journal(failure.backupPath)).stage, 'rolled-back')
})

test('an unusable backup root fails before touching installation paths', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.backupRoot, 'not a directory')
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => assert.fail('must not run')))
  assert.equal(await fs.readFile(path.join(f.first, 'old.txt'), 'utf8'), 'first original')
})

test('concurrent and interrupted locks refuse another update', async (t) => {
  const f = await fixture(t)
  await withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => {
    await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.second] }, async () => assert.fail('concurrent apply')), { code: 'UPDATE_LOCKED' })
  })
  await fs.writeFile(path.join(f.backupRoot, '.update.lock'), JSON.stringify({ backupPath: 'interrupted backup' }))
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => assert.fail('interrupted apply')), { code: 'UPDATE_LOCKED' })
})

test('an incomplete journal remains blocking even if its lock was removed externally', async (t) => {
  const f = await fixture(t)
  const interrupted = path.join(f.backupRoot, 'update-interrupted')
  await fs.mkdir(interrupted, { recursive: true })
  await fs.writeFile(path.join(interrupted, 'journal.json'), JSON.stringify({ stage: 'applying' }))
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => assert.fail('interrupted journal')), { code: 'UPDATE_INTERRUPTED' })
  assert.equal((await journal(interrupted)).stage, 'applying')
})

test('a journal symlink cannot mark an unfinished backup as completed', async (t) => {
  const f = await fixture(t)
  const interrupted = path.join(f.backupRoot, 'update-interrupted')
  const external = path.join(f.root, 'unrelated.json')
  await fs.mkdir(interrupted, { recursive: true })
  await fs.writeFile(external, JSON.stringify({ stage: 'committed' }))
  await fs.symlink(external, path.join(interrupted, 'journal.json'))
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => assert.fail('must not trust symlink journal')), { code: 'UPDATE_INTERRUPTED' })
})

test('a changed backup entry type leaves its replacement intact and reports failed recovery', async (t) => {
  const f = await fixture(t)
  const target = path.join(f.first, 'old.txt')
  const external = path.join(f.root, 'unrelated.txt')
  await fs.writeFile(external, 'unrelated')
  await fs.chmod(external, 0o600)
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [target] }, async () => {
    const [entry] = (await fs.readdir(f.backupRoot)).filter((name) => name.startsWith('update-'))
    const snapshot = path.join(f.backupRoot, entry, 'entries', '0')
    await fs.unlink(snapshot)
    await fs.symlink(external, snapshot)
    await fs.writeFile(target, 'replacement')
    throw new Error('backup damaged')
  }), (error) => error.rolledBack === false && error.rollbackErrors.some((item) => /type/.test(item.error)))
  assert.equal(await fs.readFile(target, 'utf8'), 'replacement')
  assert.equal((await fs.lstat(target)).isSymbolicLink(), false)
  assert.equal((await fs.stat(external)).mode & 0o777, 0o600)
})

test('rollback callback runs before path restoration and its failure is not hidden', async (t) => {
  const f = await fixture(t)
  let failure
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first], rollback: async () => {
    assert.equal(await fs.readFile(path.join(f.first, 'old.txt'), 'utf8'), 'new')
    throw new Error('Git restoration failed')
  } }, async () => {
    await fs.writeFile(path.join(f.first, 'old.txt'), 'new')
    throw new Error('write failed')
  }), (error) => {
    failure = error
    return error.rolledBack === false && error.rollbackErrors.some((item) => /Git restoration failed/.test(item.error))
  })
  assert.equal(await fs.readFile(path.join(f.first, 'old.txt'), 'utf8'), 'first original')
  assert.equal((await journal(failure.backupPath)).stage, 'rollback-failed')
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => assert.fail('unresolved rollback')), { code: 'UPDATE_LOCKED' })
})

test('snapshot and restoration preserve symlinks without copying or changing their targets', async (t) => {
  const f = await fixture(t)
  const external = path.join(f.root, 'external.txt')
  const link = path.join(f.first, 'link')
  await fs.writeFile(external, 'external untouched')
  await fs.symlink('../external.txt', link)
  let failure
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [link] }, async () => {
    await fs.unlink(link)
    await fs.writeFile(link, 'replacement')
    throw new Error('abort')
  }), (error) => { failure = error; return error.rolledBack === true })
  assert.equal(await fs.readlink(link), '../external.txt')
  assert.equal(await fs.readlink(path.join(failure.backupPath, 'entries', '0')), '../external.txt')
  assert.equal(await fs.readFile(external, 'utf8'), 'external untouched')
})

test('restoration preserves a file mode and a dangling link nested in a directory', async (t) => {
  const f = await fixture(t)
  const file = path.join(f.first, 'old.txt')
  const link = path.join(f.first, 'dangling')
  await fs.chmod(file, 0o400)
  await fs.symlink('../missing', link)
  await assert.rejects(withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first] }, async () => {
    await fs.chmod(file, 0o600)
    await fs.writeFile(file, 'changed')
    await fs.unlink(link)
    throw new Error('abort')
  }), (error) => error.rolledBack === true)
  assert.equal(await fs.readFile(file, 'utf8'), 'first original')
  assert.equal((await fs.stat(file)).mode & 0o777, 0o400)
  assert.equal(await fs.readlink(link), '../missing')
})

test('overlapping paths or a backup inside a snapshot are rejected before apply', async (t) => {
  const f = await fixture(t)
  for (const input of [
    { backupRoot: f.backupRoot, paths: [f.first, path.join(f.first, 'old.txt')] },
    { backupRoot: path.join(f.first, 'backups'), paths: [f.first] },
  ]) {
    await assert.rejects(withUpdateRollback(input, async () => assert.fail('unsafe overlap')))
  }
  await assert.rejects(fs.lstat(f.backupRoot), { code: 'ENOENT' })
})

test('duplicate exact paths are backed up once', async (t) => {
  const f = await fixture(t)
  const result = await withUpdateRollback({ backupRoot: f.backupRoot, paths: [f.first, f.first] }, async () => {})
  assert.equal((await journal(result.backupPath)).paths.length, 1)
})
