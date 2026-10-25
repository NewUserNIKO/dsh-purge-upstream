import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyPackageFiles, gitTrackedDirty } from "../lib/update-files.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "purge-update-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: "pipe" });
}

async function repository(t) {
  const root = await fixture(t);
  git(root, "init", "--template=");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  for (const filename of ["scripts/setup.mjs", "presets/example.json", "NOTICE", "custom.txt"]) {
    await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await fs.writeFile(path.join(root, filename), "original");
  }
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  return root;
}

test("clean repositories and untracked files do not count as tracked changes", async (t) => {
  const root = await repository(t);
  assert.equal(gitTrackedDirty(root), false);
  await fs.writeFile(path.join(root, "local-notes.txt"), "untracked");
  assert.equal(gitTrackedDirty(root), false);
});

for (const change of ["unstaged script", "staged preset", "deleted notice", "renamed custom file"]) {
  test(`detects ${change} outside the old update manifest`, async (t) => {
    const root = await repository(t);
    if (change === "unstaged script") await fs.writeFile(path.join(root, "scripts/setup.mjs"), "modified");
    if (change === "staged preset") {
      await fs.writeFile(path.join(root, "presets/example.json"), "modified");
      git(root, "add", "presets/example.json");
    }
    if (change === "deleted notice") await fs.unlink(path.join(root, "NOTICE"));
    if (change === "renamed custom file") git(root, "mv", "custom.txt", "renamed.txt");
    const before = git(root, "status", "--porcelain");
    assert.equal(gitTrackedDirty(root), true);
    assert.equal(git(root, "status", "--porcelain"), before, "preflight must not change repository state");
  });
}

test("fails closed when Git cannot inspect the directory", async (t) => {
  assert.equal(gitTrackedDirty(await fixture(t)), true);
});

test("archive overlay includes every shipped top-level resource and removes stale directory files", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source");
  const dest = path.join(root, "dest");
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const names = ["package.json", ...pkg.files.filter((name) => !name.startsWith("!"))];
  const directories = new Set(["lib", "bin", "docs", "presets", "scripts"]);
  await fs.mkdir(source);
  await fs.mkdir(dest);
  await fs.writeFile(path.join(dest, "local-notes.txt"), "preserve me");
  for (const name of names) {
    if (directories.has(name)) {
      await fs.mkdir(path.join(source, name));
      await fs.mkdir(path.join(dest, name));
      await fs.writeFile(path.join(source, name, "current.txt"), `new ${name}`);
      await fs.writeFile(path.join(dest, name, "stale.txt"), "obsolete");
    } else {
      await fs.writeFile(path.join(source, name), `new ${name}`);
      await fs.writeFile(path.join(dest, name), "old");
    }
  }
  await copyPackageFiles(source, dest);
  for (const name of names) {
    const filename = directories.has(name) ? path.join(name, "current.txt") : name;
    assert.equal(await fs.readFile(path.join(dest, filename), "utf8"), `new ${name}`);
    if (directories.has(name)) assert.deepEqual(await fs.readdir(path.join(dest, name)), ["current.txt"]);
  }
  assert.equal(await fs.readFile(path.join(dest, "local-notes.txt"), "utf8"), "preserve me");
});

test("missing optional resources in an archive do not remove installed resources", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source");
  const dest = path.join(root, "dest");
  await fs.mkdir(source);
  await fs.mkdir(path.join(dest, "presets"), { recursive: true });
  await fs.writeFile(path.join(dest, "presets/keep.json"), "keep");
  await copyPackageFiles(source, dest);
  assert.equal(await fs.readFile(path.join(dest, "presets/keep.json"), "utf8"), "keep");
});
