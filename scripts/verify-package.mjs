import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
/** Inspect the actual packed archive, including paths omitted by source-only checks. */
export function auditArchive(file, manifest) {
  const data = gunzipSync(readFileSync(file)),
    entries = new Map();
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((n) => n === 0)) break;
    const text = (a, b) =>
      header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const path = [text(345, 500), text(0, 100)].filter(Boolean).join("/");
    const size = parseInt(text(124, 136).trim() || "0", 8),
      type = text(156, 157);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > data.length
    )
      throw Error("Invalid archive size");
    if (!["x", "g"].includes(type)) {
      if (
        !path.startsWith("package/") ||
        path.includes("\\") ||
        path.split("/").includes("..")
      )
        throw Error("Unsafe archive path: " + path);
      if (!["", "0", "5"].includes(type))
        throw Error("Archive contains a link or special file");
      if (type !== "5") {
        const relative = path.slice(8);
        if (
          !/^(?:(?:package\.json|cordis\.patch\.yml|README(?:\.en)?\.md|LICENSE|THIRD_PARTY_NOTICES\.md|CHANGELOG\.md|client\.js|host\.js)$|dist\/|docs\/|rules\/|examples\/counting\/)/.test(
            relative,
          )
        )
          throw Error("Unexpected release file: " + relative);
        if (
          /(?:^|\/)(?:node_modules|\.artifacts|output|\.env[^/]*|report-outbox\.json)(?:\/|$)|\.(?:exe|dll|pck|godot|sln|csproj)$/i.test(
            relative,
          )
        )
          throw Error("Private or standalone file in archive: " + relative);
        if (entries.has(relative))
          throw Error("Duplicate archive file: " + relative);
        entries.set(relative, data.subarray(offset + 512, offset + 512 + size));
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const json = JSON.parse(
    entries.get("package.json")?.toString("utf8") ?? "null",
  );
  if (
    json?.name !== manifest.name ||
    json.version !== manifest.version ||
    json.engines.dsh !== "0.2.2-rc.1"
  )
    throw Error("Release metadata mismatch");
  for (const name of ["README.md", "LICENSE", "cordis.patch.yml"])
    if (!entries.has(name)) throw Error("Missing release file: " + name);
  if (!entries.get("cordis.patch.yml").toString("utf8").includes(`name: ${manifest.name}\n`))
    throw Error("Bundle patch package name mismatch");
  if (manifest.name === "dsh-agentgamer") {
    for (const name of [
      "README.en.md",
      "dist/host.js",
      "dist/client.js",
      "dist/sdk.js",
      "dist/types/sdk.d.ts",
      "docs/companion.md",
      "rules/blackjack.md",
      "rules/liars-dice.md",
    ])
      if (!entries.has(name)) throw Error("Missing release file: " + name);
    const client = entries.get("dist/client.js").toString("utf8");
    if (
      !client.includes(`id:${JSON.stringify(manifest.name)}`) ||
      !client.includes("AgentGamer")
    )
      throw Error("Client brand/module ID mismatch");
    if (/node:crypto|xoshiro|SplitMix64|dsh-pet-7340/.test(client))
      throw Error("Host implementation leaked into client");
    if (!client.includes(".ag {") || client.includes(".ra {"))
      throw Error("Client stylesheet namespace does not match the UI");
  }
  for (const [name, bytes] of entries) {
    if (
      /\.(?:js|map|md|json|ts|yml)$/.test(name) &&
      /[A-Z]:[/\\](?:GameProjects|Users|ProgramHere)|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{24,}/.test(
        bytes.toString("utf8"),
      )
    )
      throw Error("Machine path or credential-shaped content in " + name);
  }
  console.log(
    `PACKAGE_AUDIT_OK ${manifest.name}@${manifest.version} files=${entries.size}`,
  );
  return entries;
}
