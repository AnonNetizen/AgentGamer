import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ReportStore } from "../src/reports.js";
import type { CompanionAdapter } from "../src/companion.js";

test("rename migration preserves old receipt text and IDs, copies atomically and never sends", async () => {
  const base = resolve(".artifacts/migration-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "case-"));
  const old = join(dir, "rushagent-outbox.json"),
    next = join(dir, "agentgamer", "report-outbox.json");
  const job = {
    id: "RA-original",
    matchId: "old-match",
    gameId: "blackjack",
    gameName: "21 点",
    companion: {
      entry: "main",
      petId: "fish",
      key: '["dsh_pet","main","fish"]',
      name: "旧伙伴",
      kind: "dsh_pet",
    },
    text: "RushAgent 公开战报（RA-original）",
    createdAt: "2026-11-09T00:00:00.000Z",
    status: "sending",
    error: "",
  };
  const raw = JSON.stringify({ version: 1, jobs: [job] });
  await writeFile(old, raw);
  let sends = 0;
  const adapter: CompanionAdapter = {
    list: async () => [],
    preview: async () => {
      throw Error();
    },
    send: async () => {
      sends++;
      return { text: "reply" };
    },
    findReceipt: async () => null,
  };
  const store = new ReportStore(
    next,
    adapter,
    () => {},
    () => {},
    old,
  );
  await store.ready();
  assert.equal(sends, 0);
  assert.equal(store.list()[0].id, job.id);
  assert.equal(store.list()[0].text, job.text);
  assert.equal(store.list()[0].status, "unknown");
  assert.equal(await readFile(old, "utf8"), raw);
  assert.equal(JSON.parse(await readFile(next, "utf8")).jobs[0].text, job.text);
  await store.dispose();
  // An existing new queue wins even if the old source changes later.
  await writeFile(old, "corrupt legacy file");
  const restarted = new ReportStore(
    next,
    adapter,
    () => {},
    () => {},
    old,
  );
  await restarted.ready();
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.error, "");
  assert.equal(sends, 0);
  await restarted.dispose();
  // A corrupt new queue must never silently fall back and resend an old task.
  await writeFile(next, "corrupt new file");
  await writeFile(old, raw);
  const guarded = new ReportStore(
    next,
    adapter,
    () => {},
    () => {},
    old,
  );
  await guarded.ready();
  assert.ok(guarded.error);
  assert.deepEqual(guarded.list(), []);
  assert.equal(await readFile(next, "utf8"), "corrupt new file");
  assert.equal(sends, 0);
  await guarded.dispose();
});
