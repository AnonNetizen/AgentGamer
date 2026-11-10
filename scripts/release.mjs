import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { auditArchive } from "./verify-package.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const example = JSON.parse(
  readFileSync("examples/counting/package.json", "utf8"),
);
if (example.version !== manifest.version)
  throw Error("Example version must match the release.");
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(process.execPath, ["scripts/check.mjs"]);
const manager = process.env.npm_execpath;
if (!manager || !existsSync(manager))
  throw Error("Run this script with pnpm release:local.");
const pack = (cwd) =>
  /\.(?:c?js|mjs)$/i.test(manager)
    ? run(
        process.execPath,
        [manager, "pack", "--pack-destination", resolve("release")],
        cwd,
      )
    : run(manager, ["pack", "--pack-destination", resolve("release")], cwd);
mkdirSync("release", { recursive: true });
pack(root);
pack(resolve("examples/counting"));
const files = [manifest, example].map((p) => `${p.name}-${p.version}.tgz`);
for (const [index, file] of files.entries())
  auditArchive(resolve("release", file), index === 0 ? manifest : example);
writeFileSync(
  "release/SHA256SUMS.txt",
  files
    .map(
      (file) =>
        `${createHash("sha256")
          .update(readFileSync(resolve("release", file)))
          .digest("hex")}  ${file}`,
    )
    .join("\n") + "\n",
);
console.log(
  `AgentGamer ${manifest.version}: validated packages and SHA256SUMS.txt in release/`,
);
