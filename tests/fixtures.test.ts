import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
test("synthetic golden data and frozen historical benchmark match their provenance hashes", () => {
  const root = new URL("./", import.meta.url);
  const golden = JSON.parse(readFileSync(new URL("fixtures/provenance.json", root), "utf8"));
  const raw = gunzipSync(readFileSync(new URL("fixtures/blackjack-reference.json.gz", root)));
  assert.equal(createHash("sha256").update(raw).digest("hex"), golden.uncompressedSha256);
  assert.equal(JSON.parse(raw.toString("utf8")).cases.length, golden.matches);
  const baseline = JSON.parse(readFileSync(new URL("baseline/provenance.json", root), "utf8"));
  assert.equal(createHash("sha256").update(readFileSync(new URL("baseline/host-0.1.1.js", root))).digest("hex"), baseline.hostSha256);
});
