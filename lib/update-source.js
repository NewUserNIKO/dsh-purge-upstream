import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PACKAGE_FILES } from './update-files.js'

export const UPDATE_SOURCE = Object.freeze({
  repository: 'NewUserNIKO/dsh-purge-upstream',
  branch: 'codex/reliability-fixes',
  policyVersion: 1,
})

export function isProtectedRef(ref) {
  return typeof ref === 'string'
    && (ref === UPDATE_SOURCE.branch || /^[0-9a-f]{40}$/i.test(ref))
}

export function archiveUrl(format, ref) {
  if (format !== 'zip' && format !== 'tar.gz') throw new Error('不支持的更新归档格式')
  if (!isProtectedRef(ref)) throw new Error('更新 ref 必须是受保护分支或完整提交号')
  const target = ref === UPDATE_SOURCE.branch
    ? `refs/heads/${encodeURIComponent(ref)}`
    : ref.toLowerCase()
  return `https://codeload.github.com/${UPDATE_SOURCE.repository}/${format}/${target}`
}

const PACKAGE_DIRECTORIES = new Set(['lib', 'bin', 'docs', 'presets', 'scripts'])
const REQUIRED_EXPORTS = ['.', './client', './redteam', './redteam/store', './redteam/ui', './redteam/tools', './package.json']

function invalid(detail) {
  return new Error(`更新包校验失败：${detail}`)
}

async function inspect(file) {
  let stat
  try { stat = await fs.lstat(file) } catch (error) {
    if (error.code === 'ENOENT') throw invalid(`缺少 ${file}`)
    throw error
  }
  if (stat.isSymbolicLink()) throw invalid(`不允许符号链接：${file}`)
  if (!stat.isDirectory() && !stat.isFile()) throw invalid(`不允许特殊文件：${file}`)
  return stat
}

async function inspectTree(file) {
  const stat = await inspect(file)
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(file)) await inspectTree(path.join(file, name))
  }
  return stat
}

function validVersion(value) {
  if (typeof value !== 'string') return false
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  return Boolean(match && (!match[4] || match[4].split('.').every(
    (id) => !/^\d+$/.test(id) || id === '0' || !id.startsWith('0'),
  )))
}

async function validateEntrypoint(dir, value, label, exportTarget = false) {
  if (typeof value !== 'string' || !value || (exportTarget && !value.startsWith('./'))
    || value.includes('\\') || value.includes(':') || value.startsWith('/')) {
    throw invalid(`无效入口 ${label}`)
  }
  const relative = value.replace(/^\.\//, '')
  const pieces = relative.split('/')
  if (pieces.some((piece) => !piece || piece === '.' || piece === '..')
    || !PACKAGE_FILES.includes(pieces[0])) throw invalid(`入口不在随包资源内：${label}`)
  if (!(await inspect(path.join(dir, relative))).isFile()) throw invalid(`入口不是文件：${label}`)
}

async function validateExport(dir, value, label) {
  if (typeof value === 'string') return validateEntrypoint(dir, value, label, true)
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) {
    throw invalid(`无效 export 导出：${label}`)
  }
  for (const [condition, target] of Object.entries(value)) {
    await validateExport(dir, target, `${label}.${condition}`)
  }
}

/** Inspect staged package data only: never import candidate code or run scripts. */
export async function validateUpdatePackage(dir) {
  if (!(await inspect(dir)).isDirectory()) throw invalid('更新包根不是目录')
  // The installed policy defines the complete required set. Candidate.files
  // cannot make omitted resources or symlinked entrypoints acceptable.
  for (const name of PACKAGE_FILES) {
    const stat = await inspectTree(path.join(dir, name))
    if (PACKAGE_DIRECTORIES.has(name) ? !stat.isDirectory() : !stat.isFile()) {
      throw invalid(`随包资源类型错误：${name}`)
    }
  }
  let pkg
  try { pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) } catch {
    throw invalid('package.json 不是有效 JSON')
  }
  if (!pkg || typeof pkg !== 'object' || pkg.name !== 'dsh-purge') throw invalid('包名必须为 dsh-purge')
  if (!validVersion(pkg.version)) throw invalid('version 必须为有效 SemVer 版本')
  const policy = pkg.dshPurgeUpdate
  if (!policy || typeof policy !== 'object' || Object.keys(policy).length !== Object.keys(UPDATE_SOURCE).length
    || Object.entries(UPDATE_SOURCE).some(([key, value]) => policy[key] !== value)) {
    throw invalid('fork 更新策略不匹配，拒绝旧来源或未标记的构建')
  }
  for (const name of ['preinstall', 'install', 'postinstall']) {
    if (Object.hasOwn(pkg.scripts ?? {}, name)) throw invalid(`不允许安装脚本 lifecycle：${name}`)
  }
  await validateEntrypoint(dir, pkg.main, 'main')
  if (!pkg.exports || typeof pkg.exports !== 'object' || Array.isArray(pkg.exports)
    || REQUIRED_EXPORTS.some((key) => !Object.hasOwn(pkg.exports, key))) {
    throw invalid('缺少必要的 export 导出')
  }
  for (const [name, target] of Object.entries(pkg.exports)) await validateExport(dir, target, `exports.${name}`)
  if (!pkg.bin || typeof pkg.bin !== 'object' || !Object.hasOwn(pkg.bin, 'dsh-purge')) {
    throw invalid('缺少 dsh-purge bin 命令入口')
  }
  for (const [name, target] of Object.entries(pkg.bin)) await validateEntrypoint(dir, target, `bin.${name}`)
  await validateEntrypoint(dir, pkg.dsh?.bundle?.patch, 'dsh.bundle.patch')
  return pkg
}
