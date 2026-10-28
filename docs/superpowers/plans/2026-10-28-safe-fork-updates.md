# Safe Fork Updates Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for parent integration, with independent helper/UI tasks delegated. Track steps below and obtain one fresh-context final review.

**Goal:** Protect personal fork changes from unsafe updates and restore installations after handled failures.
**Architecture:** One source policy; a side-effect-free transaction helper; staged candidate validation and clean fast-forward Git updates; shared panel entrypoints. Update files without applying host patches.
**Tech Stack:** JavaScript ESM, Node >=18, node:test, temporary Git repositories, no new dependencies.
**Spec:** ../specs/2026-10-28-safe-fork-updates.md

## Global Constraints

- Keep the installed plugin disabled and unchanged; never invoke live update/apply/reapply or DSH.
- Fixed repository NewUserNIKO/dsh-purge-upstream, branch codex/reliability-fixes; default update never selects upstream/master/old tags.
- Backups and tests cannot capture credentials or the whole DSH home.
- No host restart, process exit, or downloaded-code execution in the update transaction.

## Review Focus

- Failure on a later destination or final metadata write restores earlier targets as well.
- Local Git commits, tracked edits, and colliding untracked/ignored files cannot be discarded.
- Branch movement during download cannot change the installed/recorded SHA.
- Both panel entrypoints use identical source/preflight/rollback semantics.
- Source/destination symlinks, duplicate/nested targets, failed backup, rollback failure and interrupted locks are handled explicitly.

### Task 1: Protected fork source

**Files:** lib/update-source.js, package.json, test/update-source.test.js.
**Interfaces:** export UPDATE_SOURCE={repository,branch,policyVersion}; archiveUrl(format,shaOrBranch); isProtectedRef(ref); validateUpdatePackage(dir) for candidate metadata/required files/no symlinks.
- [x] Test fork URLs including slash branch and immutable SHA, candidate marker mismatch/missing files/symlinks.
- [x] Run focused tests, observe failures, implement pure policy and package metadata, rerun green.

### Task 2: Backup transaction

**Files:** lib/update-transaction.js, test/update-transaction.test.js.
**Interfaces:** withUpdateRollback({backupRoot,paths,details,rollback}, apply) returns {value,backupPath}; errors expose backupPath,rolledBack,rollbackErrors. Paths are exact package entries/metadata files; rollback callback restores Git heads before snapshot restoration.
- [x] Test successful backups, original absent paths, multi-target mutation then failure, metadata failure, backup failure before apply, concurrent/interrupted lock, rollback failure and symlink snapshots.
- [x] Observe failures, implement backup/journal/lock and reverse restoration, rerun green.

### Task 3: Orchestrate staged updates

**Files:** lib/update.js, lib/update-files.js, new update installation helper if needed, test/update-install.test.js and isolated updater tests.
**Interfaces:** resolve branch once; validate/extract to temporary directory; preflight all targets; fixed-URL Git fetch and clean fast-forward; backup all mutable paths; update profile pins/channel/stamp/history in the same transaction; return filesUpdated/needsApply without reapply/restart.
- [x] Add real fixture tests for dirty/later target, old/diverged Git revisions, untracked collisions, immutable SHA use, profile/state rollback, no fallback and no host execution.
- [x] Run RED, implement integration, rerun GREEN and existing tests.
- [x] Version discovery uses fork commit identity and ignores old source pins/tags; report the selected source and backup path.

### Task 4: Shared panel behavior and delivery

**Files:** lib/redteam/ui.js, lib/redteam/client.js, client.js, docs/safe-fork-updates.md, README.md, focused panel regression tests.
**Interfaces:** redteam update operations delegate to protected main updater; clients show file-update completion and later manual reload/Apply, never auto-restart after file update.
- [x] Test shared routing and absence of legacy npm install/exit/restart behavior, implement truthful UI feedback.
- [x] Document backup location, protected branch, refusal cases, manual Apply and interruption limits.
- [x] Run npm test, syntax/diff checks and package dry-run; obtain independent review, fix material findings with RED→GREEN tests.
- [ ] Commit and update draft PR1, verify CI, preserve verification records and confirm live installation unchanged.
