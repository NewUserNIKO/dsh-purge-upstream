# Safe personal-fork updates

The user selected fork-aware updates with preflight, backup and failure rollback. Continue in the existing review branch; do not update the live installation, activate the plugin, start DSH, apply host patches, or merge the PR.

Use the personal repository `NewUserNIKO/dsh-purge-upstream` and protected branch `codex/reliability-fixes`. The fork's master and inherited tags do not contain this work. A single immutable commit must identify the downloaded package, Git changes, profile pins and update records. Candidate packages must declare the same fork update policy and contain the shipped entrypoints/resources. Old source pins, upstream tags and source-less candidate packages must not silently replace this build.

Before modifying any installation, validate every destination, candidate and Git checkout. Refuse dirty Git trees, revision rollback/divergence, overlapping destinations, archive symlinks, and missing required resources. Git fetches use the fixed fork URL; Git errors must never fall back to archive overwrite. Preserve the user's current branch; only fast-forward clean checkouts.

Back up every affected package path and update metadata before the first installation change. Handle failures by restoring all destinations and metadata; preserve the backup and accurately report incomplete rollback. Keep a journal and prevent another update from running across an interrupted transaction. This is rollback for caught errors, not a promise of atomic recovery from power loss or arbitrary concurrent edits.

Update files independently of host Apply. The updater must not execute downloaded plugin code, reapply host patches, restart or exit the host. Report successful file updates as requiring the user's later reload/Apply. Route both panel update entrypoints through the same protected workflow, with accurate UI text.

Keep upstream attribution, Node >=18, and dependency-free tests. Validate with temporary filesystem/Git fixtures and isolated module/network adapters; no real installer or host process is used. Deliver through existing draft PR1 after independent review and Linux/macOS × Node18/24 CI.

Chosen approach: one protected fork branch and a journaled rollback transaction. Merely replacing the repository constant would leave old branch/tag paths and the second updater exposed. A transaction including every host patch would be substantially broader, so host Apply remains separate.
