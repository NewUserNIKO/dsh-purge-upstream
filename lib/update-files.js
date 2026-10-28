import { execFileSync } from "node:child_process";
import fs, { promises as fsp } from "node:fs";
import path from "node:path";

export const PACKAGE_FILES = Object.freeze([
  "lib",
  "bin",
  "docs",
  "presets",
  "scripts",
  "client.js",
  "cordis.patch.yml",
  "screenshots.json",
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "NOTICE",
]);

const HIDDEN = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,
  timeout: 20000,
};

export function gitTrackedDirty(dir) {
  try {
    const out = execFileSync(
      "git",
      ["-C", dir, "status", "--porcelain", "--untracked-files=no"],
      HIDDEN,
    ).trim();
    return Boolean(out);
  } catch {
    return true;
  }
}

export async function copyPackageFiles(source, dest) {
  for (const name of PACKAGE_FILES) {
    const from = path.join(source, name);
    const to = path.join(dest, name);
    if (!fs.existsSync(from)) continue;
    if ((await fsp.stat(from)).isDirectory()) {
      try {
        await fsp.rm(to, { recursive: true, force: true });
      } catch (e) {
        // 删不掉说明文件被进程占用。继续 cp 会写出一半新文件一半旧文件的半升级,
        // 让 host 和插件的版本不一致。宁可抛错让用户彻底退出宿主再重试。
        throw new Error(
          `覆盖 ${to} 失败(${e.message || e})。可能被进程占用,请完全退出宿主后重试。`,
        );
      }
    }
    await fsp.cp(from, to, { recursive: true, force: true });
  }
}
