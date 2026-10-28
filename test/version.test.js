import assert from "node:assert/strict";
import test from "node:test";
import { versionIsNewer } from "../lib/update.js";

// SemVer 2.0.0 section 11: https://semver.org/#spec-item-11
test("orders prereleases by identifier, including numeric fields and equal prefixes", () => {
  const versions = ["alpha", "alpha.1", "alpha.beta", "beta", "beta.2", "beta.11", "rc.1"]
    .map((pre) => `1.0.0-${pre}`).concat("1.0.0");
  for (let i = 0; i < versions.length; i += 1) {
    for (let j = 0; j < versions.length; j += 1) {
      assert.equal(versionIsNewer(versions[i], versions[j]), i > j, `${versions[i]} > ${versions[j]}`);
    }
  }
});

test("numeric prerelease fields compare without floating-point precision loss", () => {
  assert.equal(versionIsNewer("1.2.3-beta.10", "1.2.3-beta.2"), true);
  assert.equal(versionIsNewer("1.2.3-9007199254740993", "1.2.3-9007199254740992"), true);
  assert.equal(versionIsNewer("1.2.3-2", "1.2.3-1a"), false);
});

test("build metadata never changes precedence, including hyphens in build names", () => {
  for (const [a, b] of [
    ["1.2.3+new", "1.2.3+old"],
    ["1.2.3-beta.2+new", "1.2.3-beta.2+old"],
    ["1.2.3+build-one", "1.2.3"],
  ]) {
    assert.equal(versionIsNewer(a, b), false);
    assert.equal(versionIsNewer(b, a), false);
  }
});

test("retains core, v-prefix, stable and missing-version behavior", () => {
  assert.equal(versionIsNewer("v1.10.0", "1.9.99"), true);
  assert.equal(versionIsNewer("1.2.4-alpha", "1.2.3"), true);
  assert.equal(versionIsNewer("1.2.3", "1.2.3-rc.10"), true);
  assert.equal(versionIsNewer("1.2.3", "v1.2.3"), false);
  assert.equal(versionIsNewer("", "1.2.3"), false);
  assert.equal(versionIsNewer("1.2.3", ""), true);
});
