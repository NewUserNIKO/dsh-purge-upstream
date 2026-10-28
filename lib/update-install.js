import { execFileSync } from 'node:child_process'
import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { PACKAGE_FILES, copyPackageFiles, gitTrackedDirty } from './update-files.js'
import { UPDATE_SOURCE, validateUpdatePackage } from './update-source.js'
import { withUpdateRollback } from './update-transaction.js'

function git(dir, args, hooksDir) {
  return execFileSync('git', ['-C', dir,
    ...(hooksDir ? ['-c', `core.hooksPath=${hooksDir}`] : []),
    '-c', 'submodule.recurse=false', '-c', 'merge.autoStash=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000,
  })
}

function overlaps(a, b) {
  const rel = path.relative(a, b)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

async function normalizeJobs(jobs, sourceDir) {
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('没有可更新的插件目录')
  const unique = new Map()
  for (const job of jobs) {
    if (!job?.dir) throw new Error('更新目标缺少目录')
    const dir = await fsp.realpath(job.dir)
    if (overlaps(dir, sourceDir) || overlaps(sourceDir, dir)) throw new Error('更新源和目标目录重叠')
    if (unique.has(dir)) continue
    for (const previous of unique.keys()) {
      if (overlaps(previous, dir) || overlaps(dir, previous)) throw new Error('更新目标存在嵌套或重叠目录')
    }
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    if (pkg.name !== 'dsh-purge') throw new Error(`更新目标不是 dsh-purge package: ${dir}`)
    // A checkout never becomes an archive destination after a Git error.
    const isGit = fs.existsSync(path.join(dir, '.git'))
    if (job.kind === 'git' && !isGit) throw new Error(`Git 目录已丢失: ${dir}`)
    unique.set(dir, { dir, kind: isGit ? 'git' : 'zip' })
  }
  return [...unique.values()]
}

function preflightGit(job, sha) {
  const { dir } = job
  if (gitTrackedDirty(dir)) throw new Error(`本地插件文件有未提交修改，未覆盖: ${dir}`)
  for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const statePath = path.resolve(dir, git(dir, ['rev-parse', '--git-path', state]).trim())
    if (fs.existsSync(statePath)) throw new Error(`Git 操作未完成: ${dir}`)
  }
  const before = git(dir, ['rev-parse', 'HEAD']).trim()
  try { git(dir, ['merge-base', '--is-ancestor', before, sha]) }
  catch { throw new Error(`只允许快进更新；本地提交领先、分叉或目标提交不可用: ${dir}`) }
  const targetPackage = JSON.parse(git(dir, ['show', `${sha}:package.json`]))
  if (targetPackage.name !== 'dsh-purge' || Object.entries(UPDATE_SOURCE).some(([key, value]) => targetPackage.dshPurgeUpdate?.[key] !== value)) {
    throw new Error('Git 候选提交不属于受保护的 fork 更新策略')
  }
  const entries = git(dir, ['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean)
  if (entries.some((entry) => entry.startsWith('160000 '))) throw new Error('暂不支持含子模块的插件更新')
  const targetFiles = entries.map((entry) => entry.slice(entry.indexOf('\t') + 1))
  const localFiles = [
    ...git(dir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
    ...git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean)
  if (localFiles.some((local) => targetFiles.some((target) =>
    local === target || local.startsWith(`${target}/`) || target.startsWith(`${local}/`)))) {
    throw new Error(`更新会覆盖未跟踪或忽略的本地文件，已拒绝: ${dir}`)
  }
  const roots = [...new Set([before, sha].flatMap((rev) => git(dir, ['ls-tree', '--name-only', '-z', rev]).split('\0').filter(Boolean)))]
  if (roots.some((name) => name === '.git' || path.basename(name) !== name)) throw new Error('Git 候选路径无效')
  return { ...job, before, roots }
}

/** Install already downloaded, immutable source. No network or host code runs here. */
export async function installPreparedUpdate({ sourceDir, sha, jobs, backupRoot, metadataFiles = [], writeMetadata = async () => {} }) {
  if (!/^[a-f0-9]{40}$/i.test(String(sha))) throw new Error('更新必须固定到完整提交 SHA')
  const pkg = await validateUpdatePackage(sourceDir)
  const source = await fsp.realpath(sourceDir)
  const normalized = await normalizeJobs(jobs, source)
  const prepared = normalized.map((job) => job.kind === 'git' ? preflightGit(job, sha) : job)
  const paths = prepared.flatMap((job) => (job.kind === 'git' ? job.roots : PACKAGE_FILES).map((name) => path.join(job.dir, name)))
  const attempted = []
  let hooksDir
  return withUpdateRollback({
    backupRoot, paths: [...paths, ...metadataFiles],
    details: { source: UPDATE_SOURCE, sha, jobs: prepared.map(({ dir, kind, before }) => ({ dir, kind, before })) },
    beforeApply: async () => {
      for (const job of prepared.filter((item) => item.kind === 'git')) {
        if (gitTrackedDirty(job.dir) || git(job.dir, ['rev-parse', 'HEAD']).trim() !== job.before) throw new Error('备份期间 Git 状态发生变化，已停止更新')
      }
    },
    rollback: async () => {
      const errors = []
      for (const job of [...attempted].reverse()) {
        try { git(job.dir, ['reset', '--hard', job.before], hooksDir) }
        catch (error) { errors.push(`${job.dir}: ${error.message}`) }
      }
      if (errors.length) throw new Error(errors.join('\n'))
    },
  }, async (backupPath) => {
    hooksDir = path.join(backupPath, 'empty-hooks')
    await fsp.mkdir(hooksDir)
    for (const job of prepared) {
      if (job.kind === 'git') {
        attempted.push(job)
        git(job.dir, ['merge', '--ff-only', '--no-edit', '--no-autostash', '--no-overwrite-ignore', sha], hooksDir)
      } else await copyPackageFiles(source, job.dir)
    }
    await writeMetadata({ sha, pkg, jobs: prepared, backupPath })
    return { sha, version: pkg.version, destinations: prepared.map((job) => job.dir) }
  })
}
