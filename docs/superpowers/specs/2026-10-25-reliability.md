# Reliability fixes for the personal fork

Use the original-author fork at ca848d76 (1.1.73, DSH target 0.2.1-rc.2) as the conservative baseline. The other personal forks contain 1.1.71 and 1.1.72. Upstream 1.1.78 adds useful lifecycle changes but also an installation hook that writes profile activation configuration; a wholesale upgrade is outside this change.

Fix demonstrated defects: skill imports through symlinks must reject source/destination overlap before mutation; the Node ZIP fallback must preserve explicit directories and empty files; version ordering must follow SemVer prerelease precedence and ignore build metadata; non-forced Git updates must detect every tracked edit; ZIP updates must copy all shipped resources, replacing stale directory contents. Correct the release notes claiming an absent bundled skill.

Keep runtime dependencies unchanged and compatibility with Node >=18 for these helpers. Do not modify prompts, patch policy, host detection, plugin activation, or the installed application. All tests use temporary directories and local Git fixtures; no host CLI, update/apply/reapply, or network operations in tests. No release/version bump. Changes remain on a dedicated branch for review.
