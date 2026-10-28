import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'
import { pathToFileURL } from 'node:url'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-runtime-test-'))
const sha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const calls = []
const home = path.join(root, 'home')
const dest = path.join(root, 'installed')
const source = path.join(root, 'candidate')
const profile = path.join(home, 'profiles', 'desktop')
const mode = process.argv[2]
let spawned = 0
let failedMetadata = false
let commitQueries = 0
try {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  fs.mkdirSync(source)
  for (const file of ['package.json', ...pkg.files.filter((file) => !file.startsWith('!'))]) {
    fs.cpSync(new URL('../../' + file, import.meta.url), path.join(source, file), { recursive: true })
  }
  fs.cpSync(source, dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'README.md'), 'old installation')
  fs.mkdirSync(profile, { recursive: true })
  const profileFile = path.join(profile, 'package.json')
  const oldProfile = JSON.stringify({ dependencies: { 'dsh-purge': 'https://example.invalid/old.tgz' } })
  fs.writeFileSync(profileFile, oldProfile)
  fs.mkdirSync(path.join(home, 'dsh-purge'))
  const channelFile = path.join(home, 'dsh-purge/channel.json')
  const oldChannel = JSON.stringify({ channel: 'beta', pin: 'v1.1.73' })
  fs.writeFileSync(channelFile, oldChannel)

  function request(input, options, callback) {
    const url = String(input)
    calls.push(url)
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.destroy = (error) => { if (error) req.emit('error', error) }
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter()
      res.headers = {}
      res.statusCode = 200
      res.resume = () => {}
      res.destroy = (error) => res.emit('error', error)
      let body
      if (url.includes('/commits/') && !url.endsWith('.atom')) {
        commitQueries += 1
        body = JSON.stringify({ sha: commitQueries === 1 ? sha : otherSha })
      } else if (url.includes('/compare/')) body = JSON.stringify({ status: 'behind' })
      else if (url.endsWith('.atom')) body = `<id>tag:github.com,2008:Grit::Commit/${sha}</id>`
      else if (url.includes('codeload.github.com/')) body = 'fixture archive bytes'
      else if (url.includes('package.json')) body = JSON.stringify(pkg)
      else { res.statusCode = 404; body = '{}' }
      callback(res)
      res.emit('data', Buffer.from(body))
      res.emit('end')
    })
    return req
  }
  const core = {
    findDshHome: () => home,
    atomicWriteSync(file, value) {
      if (mode === 'metadata-failure' && file.endsWith('installed-rev') && !failedMetadata) {
        failedMetadata = true
        throw new Error('fixture stamp write failed')
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file + '.fixture-tmp', value)
      fs.renameSync(file + '.fixture-tmp', file)
    },
  }
  const context = createContext({ process, Buffer, URL, console, setTimeout, clearTimeout })
  const updater = new SourceTextModule(fs.readFileSync(new URL('../../lib/update.js', import.meta.url), 'utf8'), {
    context, initializeImportMeta(meta) { meta.url = pathToFileURL(path.join(dest, 'lib/update.js')).href },
  })
  await updater.link(async (specifier) => {
    let namespace
    if (specifier === './core.js') namespace = core
    else if (specifier === 'node:http' || specifier === 'node:https') namespace = { default: { request } }
    else if (specifier === 'node:child_process') namespace = {
      ...(await import(specifier)), spawnSync: () => { spawned += 1; throw new Error('host execution forbidden') },
    }
    else if (specifier === './zip-extract.js') namespace = { extractZipArchive: (_zip, output) => {
      fs.cpSync(source, path.join(output, 'archive-root'), { recursive: true })
    } }
    else namespace = await import(specifier.startsWith('.') ? new URL('../../lib/' + specifier.slice(2), import.meta.url).href : specifier)
    return new SyntheticModule(Object.keys(namespace), function () {
      for (const [key, value] of Object.entries(namespace)) this.setExport(key, value)
    }, { context })
  })
  await updater.evaluate()
  if (mode === 'invalid-ref') {
    await assert.rejects(updater.namespace.applyUpdate([{ kind: 'zip', dir: dest }], { ref: 'master' }))
    assert.equal(calls.length, 0)
    assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), 'old installation')
  } else if (mode === 'archive-rollback') {
    fs.writeFileSync(path.join(home, 'dsh-purge/installed-rev'), JSON.stringify({ repository: 'NewUserNIKO/dsh-purge-upstream', branch: 'codex/reliability-fixes', sha: otherSha }))
    await assert.rejects(updater.namespace.applyUpdate([{ kind: 'zip', dir: dest }]), /回退|分叉|快进/)
    assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), 'old installation')
    assert.ok(!calls.some((url) => url.includes('codeload.github.com/')))
  } else if (mode === 'check') {
    fs.writeFileSync(path.join(home, 'dsh-purge/installed-rev'), JSON.stringify({ repository: 'NewUserNIKO/dsh-purge-upstream', branch: 'codex/reliability-fixes', sha: otherSha }))
    const result = await updater.namespace.checkUpdate()
    assert.equal(result.hasUpdate, true, 'same package version with a new fork commit must be visible')
    assert.equal(result.sourceRef, 'codex/reliability-fixes')
    assert.equal(result.pin, '')
    assert.equal(fs.readFileSync(channelFile, 'utf8'), oldChannel, 'read-only discovery must not rewrite channel state')
  } else {
    const pending = updater.namespace.applyUpdate([{ kind: 'dsh', dir: dest, profileDir: profile }])
    if (mode === 'metadata-failure') {
      await assert.rejects(pending, (error) => error.rolledBack === true)
      assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), 'old installation')
      assert.equal(fs.readFileSync(profileFile, 'utf8'), oldProfile)
      assert.equal(fs.readFileSync(channelFile, 'utf8'), oldChannel)
      assert.equal(fs.existsSync(path.join(home, 'dsh-purge/installed-rev')), false)
    } else {
      const result = await pending
      assert.equal(result.ok, true)
      assert.equal(result.filesUpdated, true)
      assert.equal(result.needsApply, true)
      assert.equal(result.restartAfter, false)
      assert.equal(result.applied, false)
      assert.ok(fs.statSync(result.backupPath).isDirectory())
      assert.equal(JSON.parse(fs.readFileSync(profileFile)).dependencies['dsh-purge'], `https://codeload.github.com/NewUserNIKO/dsh-purge-upstream/tar.gz/${sha}`)
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'dsh-purge/installed-rev'))).sha, sha)
      assert.ok(calls.includes(`https://codeload.github.com/NewUserNIKO/dsh-purge-upstream/zip/${sha}`))
      assert.equal(commitQueries, 1, 'branch is resolved once; no post-copy head lookup')
    }
  }
  assert.equal(spawned, 0, 'updating files must never execute reapply or restart a host')
  assert.ok(calls.every((url) => url.includes('NewUserNIKO/dsh-purge-upstream')), 'every request stays in the personal fork')
  process.stdout.write(JSON.stringify({ mode, passed: true }))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
