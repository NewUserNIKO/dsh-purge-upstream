import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const TERMINAL_STAGES = new Set(['committed', 'rolled-back'])
const COPY_OPTIONS = { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true }

function inside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function entryType(stat) {
  return stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unsupported'
}

// Resolve parent aliases (including macOS /tmp) without following a leaf symlink.
async function physicalEntry(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('Update paths must be non-empty strings')
  const absolute = path.resolve(value)
  let parent = path.dirname(absolute)
  const suffix = [path.basename(absolute)]
  while (true) {
    try { return path.join(await fs.realpath(parent), ...suffix) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const next = path.dirname(parent)
      if (next === parent) throw error
      suffix.unshift(path.basename(parent))
      parent = next
    }
  }
}

async function atomicJournal(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, file)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

async function assertNoInterruptedBackup(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.name.startsWith('update-')) continue
    const backupPath = path.join(root, entry.name)
    let completed = false
    if (entry.isDirectory()) {
      try {
        const file = path.join(backupPath, 'journal.json')
        if (!(await fs.lstat(file)).isFile()) throw new Error('Journal must be a regular file')
        const record = JSON.parse(await fs.readFile(file, 'utf8'))
        completed = TERMINAL_STAGES.has(record.stage)
      } catch { /* Incomplete/corrupt journals require deliberate recovery. */ }
    }
    if (!completed) {
      const error = new Error(`Unfinished update backup requires recovery before another update: ${backupPath}`)
      error.code = 'UPDATE_INTERRUPTED'
      error.backupPath = backupPath
      throw error
    }
  }
}

async function restoreEntry(entry) {
  // Check backup existence before removing a replacement. A lost backup must
  // never cause us to erase the only remaining installation copy.
  if (entry.exists && entryType(await fs.lstat(entry.snapshot)) !== entry.type) throw new Error(`Backup entry type changed: ${entry.snapshot}`)
  await fs.rm(entry.path, { recursive: true, force: true })
  if (!entry.exists) return
  await fs.mkdir(path.dirname(entry.path), { recursive: true })
  await fs.cp(entry.snapshot, entry.path, COPY_OPTIONS)
  if (entry.type !== 'symlink') await fs.chmod(entry.path, entry.mode)
}

function failure(cause, backupPath, rolledBack, rollbackErrors, preparationFailed = false) {
  const original = cause instanceof Error ? cause : new Error(String(cause))
  const recovery = preparationFailed
    ? 'Update stopped before installation changes'
    : rolledBack ? 'Previous installation restored' : 'Recovery incomplete; keep the backup and resolve the recorded errors'
  const error = new Error(`${original.message}. ${recovery}. Backup: ${backupPath}`, { cause: original })
  error.code = original.code || 'UPDATE_FAILED'
  error.backupPath = backupPath
  error.rolledBack = rolledBack
  error.rollbackErrors = rollbackErrors
  error.preparationFailed = preparationFailed
  return error
}

/**
 * Back up exact filesystem entries, then run a bounded installation operation.
 * Restores all entries on caught failures, including failures writing final
 * transaction metadata. Backups are retained on both success and failure.
 * Interrupted/failed recovery locks are never guessed away automatically.
 */
export async function withUpdateRollback({ backupRoot, paths, details = {}, beforeApply, rollback } = {}, apply) {
  if (!Array.isArray(paths) || typeof apply !== 'function') throw new TypeError('Update paths and apply callback are required')
  if (rollback !== undefined && typeof rollback !== 'function') throw new TypeError('rollback must be a function')
  if (beforeApply !== undefined && typeof beforeApply !== 'function') throw new TypeError('beforeApply must be a function')
  // Check serializability before acquiring a lock or creating backup files.
  const safeDetails = JSON.parse(JSON.stringify(details))
  let root = await physicalEntry(backupRoot)
  try { root = await fs.realpath(root) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const targets = [...new Set(await Promise.all(paths.map(physicalEntry)))]
  for (let i = 0; i < targets.length; i += 1) {
    if (inside(targets[i], root) || inside(root, targets[i])) throw new Error('Update backup directory must be separate from snapshot paths')
    for (let j = i + 1; j < targets.length; j += 1) {
      if (inside(targets[i], targets[j]) || inside(targets[j], targets[i])) throw new Error('Update snapshot paths must not overlap')
    }
  }

  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const lockPath = path.join(root, '.update.lock')
  let lock
  try { lock = await fs.open(lockPath, 'wx', 0o600) }
  catch (cause) {
    if (cause.code !== 'EEXIST') throw cause
    const error = new Error(`An update is running or interrupted; inspect the retained lock: ${lockPath}`)
    error.code = 'UPDATE_LOCKED'
    error.backupPath = root
    error.rolledBack = false
    error.rollbackErrors = []
    throw error
  }

  const backupPath = path.join(root, `update-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  const journalPath = path.join(backupPath, 'journal.json')
  const record = { version: 1, pid: process.pid, createdAt: new Date().toISOString(), stage: 'preparing', details: safeDetails, paths: [] }
  let created = false
  let started = false
  let lockOwned = true
  async function releaseLock() {
    if (lock) { await lock.close(); lock = undefined }
    await fs.unlink(lockPath)
    lockOwned = false
  }
  async function writeStage(stage) {
    record.stage = stage
    record.updatedAt = new Date().toISOString()
    await atomicJournal(journalPath, record)
  }

  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, backupPath })}\n`)
    await lock.sync()
    await assertNoInterruptedBackup(root)
    await fs.mkdir(backupPath, { mode: 0o700 })
    await fs.chmod(backupPath, 0o700)
    created = true
    await fs.mkdir(path.join(backupPath, 'entries'), { mode: 0o700 })
    await writeStage('preparing')
    for (const [index, target] of targets.entries()) {
      let stat
      try { stat = await fs.lstat(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (stat && !stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`Unsupported snapshot entry: ${target}`)
      const entry = { path: target, snapshot: path.join(backupPath, 'entries', String(index)), exists: stat !== undefined,
        type: stat ? entryType(stat) : 'absent',
        mode: stat ? stat.mode & 0o7777 : null }
      record.paths.push(entry)
      if (entry.exists) await fs.cp(target, entry.snapshot, COPY_OPTIONS)
    }
    await writeStage('prepared')
    if (beforeApply) await beforeApply(backupPath)
    await writeStage('applying')
    started = true
    const value = await apply(backupPath)
    await writeStage('committed')
    await releaseLock()
    return { value, backupPath }
  } catch (cause) {
    const rollbackErrors = []
    const add = (target, error) => rollbackErrors.push({ path: target, error: String(error?.message || error) })
    if (started) {
      if (rollback) {
        try { await rollback() } catch (error) { add('<rollback callback>', error) }
      }
      for (const entry of [...record.paths].reverse()) {
        try { await restoreEntry(entry) } catch (error) { add(entry.path, error) }
      }
    }
    // Preparation failure has no installation changes to undo. Never restore
    // partially copied snapshots over untouched original files.
    record.error = String(cause?.message || cause)
    record.preparationFailed = !started
    record.rollbackErrors = rollbackErrors
    if (created) {
      try { await writeStage(rollbackErrors.length ? 'rollback-failed' : 'rolled-back') }
      catch (error) { add(journalPath, error) }
    }
    if (!rollbackErrors.length && lockOwned) {
      try { await releaseLock() }
      catch (error) {
        add(lockPath, error)
        if (created) await writeStage('rollback-failed').catch((journalError) => add(journalPath, journalError))
      }
    }
    // A failed recovery retains the lock, even after this process exits.
    if (lock) { await lock.close().catch((error) => add(lockPath, error)); lock = undefined }
    throw failure(cause, cause?.backupPath || backupPath, started && rollbackErrors.length === 0, rollbackErrors, !started)
  }
}
