These small ZIP fixtures were created with Python's standard `zipfile` module, using a fixed timestamp (2026-01-01), Unix file modes and standard local/central-directory headers. Test execution requires only Node.

- `directories.zip`: stored `bundle/`, deflated `bundle/empty/`, stored empty `bundle/zero.txt`, deflated `bundle/nested/message.txt` containing `hello from the archive\n`, then stored `bundle/nested/` (after its child).
- `traversal.zip`: stored `../escaped/` directory, rejected before creation.
