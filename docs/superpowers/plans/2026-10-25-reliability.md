# Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prevent unsafe imports, incomplete updates, and incorrect version ordering in the personal fork.
**Architecture:** Keep existing entrypoints; use Node built-in tests and real temporary filesystem fixtures. Extract updater filesystem helpers into a small module that can be tested without network or host updates.
**Tech Stack:** JavaScript ESM, Node >=18, node:test, Git fixture repositories.
**Spec:** ../specs/2026-10-25-reliability.md

## Global Constraints

- Keep runtime dependencies unchanged and compatibility with Node >=18 for these helpers.
- No changes to activation, prompts, host patches, installed application, or release version.
- Tests must not run update/apply/reapply, host CLI, or access the network.

## Review Focus

- Symlink aliases to installed skills must fail before backups/deletion (Task 1).
- ZIP empty directories and empty regular files remain distinct (Task 2).
- Numeric prerelease identifiers, prefix ordering, and build metadata (Task 3).
- Staged/deleted/renamed tracked files outside the old manifest block non-forced updates (Task 4).
- Stale resources in presets/scripts must disappear on overlay while unrelated local files survive (Task 4).

### Task 1: Skill import overlap protection

**Files:** lib/skills.js, test/skills.test.js, package.json.
**Interfaces:** Public importFromPath(home, source) remains unchanged; add npm test using node --test test/*.test.js.
- [ ] Add real directory/symlink fixtures: self import rejected without backup/mutation; external import succeeds.
- [ ] Run node --test test/skills.test.js; observe the symlink failure.
- [ ] Import the missing fs binding used by pathsOverlap.
- [ ] Run the test and commit the fix and regression cases.

### Task 2: ZIP directory extraction

**Files:** lib/zip-extract.js, test/zip-extract.test.js, test/fixtures/directories.zip.
**Interfaces:** extractZipArchive(zip, dest, ["node"]) retains its API and return value.
- [ ] Add a standard ZIP fixture containing explicit nested/empty directories, an empty regular file, and a compressed file; test extraction and traversal rejection.
- [ ] Run node --test test/zip-extract.test.js; observe directory extraction failure.
- [ ] Create directory entries as directories after existing validation; preserve file extraction.
- [ ] Run the test and commit the fix and fixture.

### Task 3: Version precedence

**Files:** lib/update.js, test/version.test.js.
**Interfaces:** versionIsNewer(remote, local) remains boolean and accepts existing v-prefixed versions.
- [ ] Test SemVer's prerelease sequence, numeric >9 identifiers, numeric versus text, equal builds, stable/core versions, and missing inputs.
- [ ] Run node --test test/version.test.js; observe ordering failures.
- [ ] Strip build metadata, compare prerelease identifiers individually, with numeric identifiers below textual ones and shorter equal prefixes below longer ones.
- [ ] Run the test and commit the comparator fix.

### Task 4: Update resource and local-edit protection

**Files:** lib/update-files.js, lib/update.js, test/update-files.test.js, release-notes.md, .github/workflows/test.yml.
**Interfaces:** New internal gitTrackedDirty(dir) returns boolean (errors fail closed); copyPackageFiles(source, dest) overlays shipped resources without network or host access.
- [ ] First extract existing manifest/copy/dirty helpers unchanged; test temporary repositories with staged/unstaged/removed/renamed edits, plus packaged resources and stale directory removal.
- [ ] Run node --test test/update-files.test.js; observe missing-resource and excluded-edit failures.
- [ ] Complete the manifest, inspect all tracked changes, and replace every shipped directory rather than only lib/docs/bin.
- [ ] Correct both absent-skill release-note claims and add dependency-free CI on Linux/macOS with Node 18/24.
- [ ] Run npm test and git diff --check; commit, then request an independent whole-branch review.
