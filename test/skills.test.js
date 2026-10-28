import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importFromPath } from "../lib/skills.js";

const skill = "---\nname: sample-skill\ndescription: Fixture skill\n---\nKeep this content.\n";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "purge-skills-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const installed = path.join(home, "skills", "sample-skill");
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, "SKILL.md"), skill);
  await fs.writeFile(path.join(installed, "notes.txt"), "original attachment");
  return { root, home, installed };
}

for (const alias of [false, true]) {
  test(`rejects ${alias ? "symlinked" : "direct"} installed skill before mutation`, async (t) => {
    const { root, home, installed } = await fixture(t);
    const source = alias ? path.join(root, "alias") : installed;
    if (alias) await fs.symlink(installed, source, "junction");
    await assert.rejects(importFromPath(home, source), /Cannot import from \$DSH_HOME\/skills/);
    assert.equal(await fs.readFile(path.join(installed, "SKILL.md"), "utf8"), skill);
    assert.equal(await fs.readFile(path.join(installed, "notes.txt"), "utf8"), "original attachment");
    await assert.rejects(fs.stat(path.join(home, "dsh-purge-backups")), { code: "ENOENT" });
  });
}

test("imports an external skill through a symlink", async (t) => {
  const { root, home } = await fixture(t);
  const source = path.join(root, "external");
  const alias = path.join(root, "external-alias");
  const content = skill.replace("sample-skill", "external-skill");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), content);
  await fs.symlink(source, alias, "junction");
  await importFromPath(home, alias);
  assert.equal(await fs.readFile(path.join(home, "skills", "external-skill", "SKILL.md"), "utf8"), content);
});
