import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractZipArchive } from "../lib/zip-extract.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "purge-zip-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("Node fallback extracts explicit directories, compressed files and empty files", async (t) => {
  const root = await fixture(t);
  const archive = fileURLToPath(new URL("./fixtures/directories.zip", import.meta.url));
  assert.equal(extractZipArchive(archive, root, ["node"]), "node");
  assert.equal((await fs.stat(path.join(root, "bundle/empty"))).isDirectory(), true);
  assert.deepEqual(await fs.readdir(path.join(root, "bundle/empty")), []);
  assert.equal((await fs.stat(path.join(root, "bundle/zero.txt"))).isFile(), true);
  assert.equal(await fs.readFile(path.join(root, "bundle/zero.txt"), "utf8"), "");
  assert.equal(await fs.readFile(path.join(root, "bundle/nested/message.txt"), "utf8"), "hello from the archive\n");
});

test("Node fallback refuses directory entries that escape the destination", async (t) => {
  const root = await fixture(t);
  const archive = fileURLToPath(new URL("./fixtures/traversal.zip", import.meta.url));
  assert.throws(() => extractZipArchive(archive, path.join(root, "dest"), ["node"]), /Invalid zip path/);
  await assert.rejects(fs.stat(path.join(root, "escaped")), { code: "ENOENT" });
});
