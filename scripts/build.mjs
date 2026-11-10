import { build } from "esbuild";
import { mkdir, writeFile, cp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const output = resolve(root, "dist");
if (dirname(output) !== root) throw new Error("Invalid build directory");
await rm(output, { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const external = ["@deepseek-ai/*", "react", "react-dom", "react/*", "zod"];
await build({
  entryPoints: ["src/host.ts", "src/sdk.ts"],
  bundle: true,
  outdir: "dist",
  platform: "node",
  target: "node24",
  format: "esm",
  external,
  sourcemap: true,
});
const client = await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  write: false,
  platform: "browser",
  target: "es2022",
  format: "cjs",
  external: ["@deepseek-ai/cordis", "react", "react-dom", "react/*"],
  loader: { ".css": "text" },
  jsx: "automatic",
});
await writeFile(
  "dist/client.js",
  `window.__ModuleLoader__.load({id:"dsh-plugin-agentgamer",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`,
);
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "--project", "tsconfig.build.json"],
  { stdio: "inherit" },
);
await cp("src/sdk.ts", "dist/sdk-source.ts");
console.log("Built Host, DSH client module, SDK and declarations.");
