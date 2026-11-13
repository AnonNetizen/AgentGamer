import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
if (!process.env.AGENTGAMER_DSH_RUNTIME)
  throw Error(
    "Set AGENTGAMER_DSH_RUNTIME to an isolated DSH 0.2.2-rc.1 runtime.",
  );
for (const script of [
  "native-check.mjs",
  "token-check.mjs",
  "dice-native-check.mjs",
  "doudizhu-native-check.mjs",
]) {
  const result = spawnSync(process.execPath, ["scripts/" + script], {
    stdio: "inherit",
    env: { ...process.env, DSH_HOME: resolve(".artifacts/dsh-native-home") },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
