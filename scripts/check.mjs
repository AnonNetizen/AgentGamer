import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 9))
  throw Error(
    "AgentGamer development checks require Node >=24.9. Put the matching node executable on PATH.",
  );
process.chdir(root);
for (const args of [
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  [
    "node_modules/tsx/dist/cli.mjs",
    "--test",
    ...readdirSync("tests")
      .filter((n) => n.endsWith(".test.ts"))
      .map((n) => "tests/" + n),
  ],
  ["scripts/build.mjs"],
  ["--check", "examples/counting/host.js"],
  ["--check", "examples/counting/client.js"],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
