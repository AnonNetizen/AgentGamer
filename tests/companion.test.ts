import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  DshPetAdapter,
  CompanionError,
  companionKey,
  type CompanionAdapter,
} from "../src/companion.js";
import { makeReport, ReportStore } from "../src/reports.js";
import { AgentGamerPlatform } from "../src/platform.js";
import {
  boundedMemory,
  checkpointText,
  MEMORY_BYTES,
} from "../src/agent-memory.js";
import { liarsDice, LiarsDiceMatch } from "../src/rules/liars-dice.js";
import type {
  CompanionPreview,
  CompanionRef,
  CompanionTurn,
  Observation,
  OpponentDriver,
  PublicReport,
} from "../src/sdk.js";
const a = { entry: "main", petId: "a" },
  b = { entry: "cat", petId: "b" };
const context = (ref = a, persona = "温和的大肥鱼"): CompanionPreview => ({
  display: {
    ...ref,
    key: companionKey(ref),
    name: "同名伙伴",
    kind: "dsh_pet",
  },
  persona,
  turns: [
    { role: "user", content: ref.petId + "的日常秘密", ts: 1 },
    { role: "assistant", content: "只属于" + ref.petId, ts: 1 },
  ],
  configuredRounds: 5,
  loadedRounds: 1,
  omitted: false,
  personaBytes: Buffer.byteLength(persona),
  memoryBytes: 100,
});
async function file() {
  const dir = resolve(".artifacts/companion-tests");
  await mkdir(dir, { recursive: true });
  return join(await mkdtemp(join(dir, "case-")), "outbox.json");
}
const report = (): PublicReport => ({
  id: "AG-test",
  matchId: "m1",
  gameId: "liars_dice",
  gameName: "吹牛骰",
  companion: context().display,
  text: "AgentGamer 公开战报（AG-test）比分3:1",
  createdAt: new Date().toISOString(),
});

test("dsh-pet HTTP adapter: explicit identity, persona fallback, paired recent memory and no writes on preview", async () => {
  const paths: string[] = [];
  let posted = "";
  let config: any = {
    main: {
      whisperPrompt: "种类人设",
      chatMemoryRounds: 5,
      pets: [{ id: "a", name: "同名", whisperPrompt: "实例人设" }],
    },
    cat: {
      whisperPrompt: "猫人设",
      chatMemoryRounds: 0,
      pets: [{ id: "b", name: "同名", whisperPrompt: "  " }],
    },
  };
  const messages: any[] = [
    {
      role: "user",
      content: "不调用文件工具",
      ts: 1,
      image: { attachmentId: "private" },
    },
    {
      role: "assistant",
      content: "记住了",
      ts: 1,
      action: "walk",
      meme: "pic",
    },
  ];
  const server = createServer(async (req, res) => {
    paths.push(req.method + " " + req.url);
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, "http://local");
    if (url.pathname.endsWith("/config")) {
      res.end(JSON.stringify(config));
      return;
    }
    if (req.method === "GET") {
      res.end(JSON.stringify({ ok: true, messages }));
      return;
    }
    assert.equal(
      url.searchParams.get("surface"),
      "any",
      "0.4.7 requires an explicit surface on POST /chat",
    );
    let body = "";
    for await (const chunk of req) body += chunk;
    posted = JSON.parse(body).text;
    messages.push(
      { role: "user", content: posted, ts: 2 },
      { role: "assistant", content: "战报回应", ts: 2 },
    );
    res.end(JSON.stringify({ ok: true, text: "战报回应" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const adapter = new DshPetAdapter(
    () => `http://127.0.0.1:${(server.address() as any).port}`,
  );
  try {
    const pets = await adapter.list();
    assert.equal(pets.length, 2);
    assert.notEqual(pets[0].key, pets[1].key);
    const x = await adapter.preview(a);
    assert.equal(x.persona, "实例人设");
    assert.equal(x.loadedRounds, 1);
    assert.equal("image" in x.turns[0], false);
    const before = paths.length;
    const y = await adapter.preview(b);
    assert.equal(y.persona, "猫人设");
    assert.deepEqual(y.turns, []);
    assert.equal(paths.length, before + 1, "zero rounds must not read history");
    assert.ok(paths.every((p) => p.startsWith("GET ")));
    assert.equal(posted, "");
    config.main.pets[0].whisperPrompt = "";
    assert.equal((await adapter.preview(a)).persona, "种类人设");
    config.main.chatMemoryRounds = 200;
    messages.push(
      { role: "user", content: "中".repeat(5000), ts: 3 },
      { role: "assistant", content: "过大", ts: 3 },
    );
    const bounded = await adapter.preview(a);
    assert.ok(bounded.memoryBytes <= 4096);
    assert.ok(bounded.omitted);
    assert.equal(bounded.turns.length % 2, 0);
    assert.ok(paths.some((p) => p.endsWith("rounds=10")));
    assert.equal(await adapter.findReceipt(a, "missing"), null);
    assert.deepEqual(await adapter.send(a, "战报"), { text: "战报回应" });
    assert.deepEqual(await adapter.findReceipt(a, "战报"), {
      text: "战报回应",
    });
    config.main.pets = [];
    await assert.rejects(adapter.preview(a), /不存在/);
    await assert.rejects(adapter.send(a, "不能发给首只"), /不存在/);
    assert.equal(posted, "战报");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await assert.rejects(
    new DshPetAdapter(() => "https://example.com").list(),
    /本机/,
  );
});

test("missing or incompatible pet routes do not prevent ordinary opponents", async () => {
  let missing = true;
  const server = createServer((_req, res) => {
    res.writeHead(missing ? 404 : 200, { "content-type": "application/json" });
    res.end(missing ? "{}" : JSON.stringify({ incompatible: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const adapter = new DshPetAdapter(
    () => `http://127.0.0.1:${(server.address() as any).port}`,
  );
  const p = new AgentGamerPlatform();
  p.attachCompanions(
    adapter,
    new ReportStore(
      await file(),
      adapter,
      () => {},
      () => {},
    ),
  );
  try {
    await assert.rejects(p.listCompanions(), /未找到/);
    missing = false;
    await assert.rejects(p.listCompanions(), /不兼容/);
    const result = await p.configure(
      { provider: "mock", model: "test" },
      async () => ({
        sessionId: "ordinary-without-pet",
        selectModel: async () => {},
        cancel: async () => {},
        dispose: async () => {},
        wake: async () => {},
      }),
      { companion: null },
    );
    assert.equal(result.accepted, true);
    assert.equal(p.snapshot().companion, null);
  } finally {
    await p.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("companion memory shares the strict 12 KiB checkpoint and drops complete pairs", () => {
  const turns: CompanionTurn[] = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "记".repeat(500),
    ts: Math.floor(i / 2) * 1000,
  }));
  const memory = boundedMemory([], 0, [], undefined, turns);
  assert.ok(Buffer.byteLength(checkpointText(memory)) <= MEMORY_BYTES);
  assert.equal(memory.companion!.length % 2, 0);
  assert.equal(memory.companion![0].role, "user");
});

test("partner sessions and chat/result memory are isolated, labels freeze and source reload cannot change a live match", async () => {
  const p = new AgentGamerPlatform(),
    inputs: any[] = [],
    names: string[] = [];
  let persona = "A的人设";
  let offline = false;
  let created = 0;
  const adapter: CompanionAdapter = {
    list: async () => [context(a).display, context(b).display],
    preview: async (ref) => {
      if (offline) throw new CompanionError("来源离线");
      return context(ref, ref.petId === "a" ? persona : "B的人设");
    },
    send: async () => ({ text: "" }),
    findReceipt: async () => null,
  };
  const store = new ReportStore(
    await file(),
    adapter,
    () => {},
    () => {},
  );
  p.attachCompanions(adapter, store);
  p.registerGame({
    ...liarsDice,
    create: (id) =>
      new LiarsDiceMatch(id, {
        starter: "human",
        rolls: Array.from({ length: 5 }, () => [
          [6, 6, 6, 6, 6],
          [2, 2, 2, 2, 2],
        ]).flat(),
      }),
  });
  const factory = async (): Promise<OpponentDriver> => ({
    sessionId: "session-" + ++created,
    selectModel: async () => {},
    cancel: async () => {},
    dispose: async () => {},
    wake: async (raw) => {
      inputs.push(JSON.parse(raw));
      const o = p.observeAgent().observation;
      if (o?.actions.some((a) => a.kind === "challenge"))
        p.act("agent", o.matchId, o.revision, crypto.randomUUID(), {
          kind: "challenge",
        });
    },
  });
  assert.equal(
    (
      await p.configure(
        { provider: "mock", model: "test", reasoningEffort: "high" },
        factory,
        { companion: a },
      )
    ).accepted,
    true,
  );
  const first = p.sessionId;
  p.say("human", "a-chat", "text", "A私聊内容");
  await p.settled();
  await p.start("liars_dice");
  persona = "新的A人设";
  assert.ok(p.companionPrompt.includes("A的人设"));
  assert.ok(!p.companionPrompt.includes(persona));
  assert.equal(
    (
      await p.configure({ provider: "mock", model: "test" }, factory, {
        companion: b,
      })
    ).error,
    "model_locked",
  );
  while (p.snapshot().observation!.phase !== "finished") {
    await p.settled();
    const o = p.snapshot().observation!;
    if (o.phase === "round_result")
      p.next(o.matchId, o.revision, crypto.randomUUID());
    else if (o.actions.length)
      p.act("human", o.matchId, o.revision, crypto.randomUUID(), {
        kind: "bid",
        quantity: 14,
        face: 6,
        mode: "straight",
      });
  }
  const publicReport = p.snapshot().report!;
  assert.ok(publicReport);
  assert.ok(!publicReport.text.includes("A私聊内容"));
  assert.equal(p.sessionId, first);
  offline = true;
  assert.equal((await p.start("liars_dice", true)).accepted, false);
  assert.equal(p.snapshot().observation!.phase, "finished");
  offline = false;
  await p.configure({ provider: "mock", model: "test" }, factory, {
    companion: b,
  });
  assert.notEqual(p.sessionId, first);
  assert.equal(
    p.snapshot().observation,
    null,
    "finished table must not enter another partner's context",
  );
  p.say("human", "b-chat", "text", "B新消息");
  await p.settled();
  assert.ok(!JSON.stringify(inputs.at(-1)).includes("A私聊内容"));
  assert.ok(!JSON.stringify(inputs.at(-1)).includes("a的日常秘密"));
  assert.equal(inputs.at(-1).memory.results.length, 0);
  p.publishReportReply({
    ...publicReport,
    status: "written",
    error: "",
    reply: "A的战报回应",
  });
  assert.equal(
    p.snapshot().messages.at(-1)!.senderName,
    publicReport.companion.name,
  );
  assert.equal(
    p.snapshot().messages.at(-1)!.companionKey,
    context(a).display.key,
  );
  await p.configure({ provider: "mock", model: "test" }, factory, {
    companion: a,
  });
  assert.ok(p.companionPrompt.includes("新的A人设"));
  assert.ok(p.snapshot().messages.some((m) => m.content === "A私聊内容"));
  assert.equal(
    (
      await p.configure({ provider: "mock", model: "test" }, factory, {
        companion: a,
        personaOverride: "中".repeat(3000),
      })
    ).accepted,
    false,
  );
  assert.equal(
    (
      await p.configure({ provider: "mock", model: "test" }, factory, {
        companion: a,
        personaOverride: "短人设",
      })
    ).accepted,
    true,
  );
  assert.ok(p.companionPrompt.includes("短人设"));
  await p.dispose();
});

test("disposing during companion discovery never creates a late session", async () => {
  const p = new AgentGamerPlatform();
  let release!: (v: CompanionPreview) => void;
  let creates = 0;
  const adapter: CompanionAdapter = {
    list: async () => [],
    preview: () => new Promise((r) => (release = r)),
    send: async () => ({ text: "" }),
    findReceipt: async () => null,
  };
  p.attachCompanions(
    adapter,
    new ReportStore(
      await file(),
      adapter,
      () => {},
      () => {},
    ),
  );
  const pending = p.configure(
    { provider: "mock", model: "test" },
    async () => {
      creates++;
      throw Error();
    },
    { companion: a },
  );
  await p.dispose();
  release(context());
  await pending;
  assert.equal(creates, 0);
  assert.equal(p.sessionId, null);
  assert.equal(p.snapshot().game, null);
});

test("reports allowlist scores and balances and never serialize private game fields", () => {
  const o = {
    matchId: "safe",
    revision: 1,
    phase: "finished",
    outcome: "win",
    actions: [],
    score: { human: 2, agent: 3 },
    seed: "secret",
    shoe: [1, 2, 3],
    history: [{ humanDice: [1, 2, 3] }],
  } as Observation;
  const r = makeReport(liarsDice, o, context().display)!;
  assert.ok(r.text.includes("玩家 2，伙伴 3"));
  assert.ok(!/secret|shoe|humanDice/.test(r.text));
  assert.ok(r.text.length <= 2000);
  assert.equal(
    makeReport(liarsDice, { ...o, phase: "bidding" }, context().display),
    null,
  );
  assert.equal(makeReport(liarsDice, o, context().display)!.id, r.id);
});

test("durable manual report outbox: duplicate click, lost receipt, restart check and no automatic resends", async () => {
  const path = await file();
  let sends = 0,
    replyPublishes = 0,
    committed = false;
  const adapter: CompanionAdapter = {
    list: async () => [],
    preview: async () => context(),
    send: async () => {
      sends++;
      committed = true;
      throw new CompanionError("回复丢失", true);
    },
    findReceipt: async () => (committed ? { text: "我记住了" } : null),
  };
  const store = new ReportStore(
    path,
    adapter,
    () => {},
    () => replyPublishes++,
  );
  const r = report();
  await Promise.all([store.enqueue(r), store.enqueue(r)]);
  await store.settled();
  assert.equal(sends, 1);
  assert.equal(store.list()[0].status, "written");
  assert.equal(replyPublishes, 1);
  const restarted = new ReportStore(
    path,
    adapter,
    () => {},
    () => replyPublishes++,
  );
  await restarted.ready();
  await restarted.enqueue(r);
  await restarted.settled();
  assert.equal(sends, 1);
  assert.equal(replyPublishes, 1);
  await store.dispose();
  await restarted.dispose();
  const unknownPath = await file();
  committed = false;
  const unknown = new ReportStore(
    unknownPath,
    {
      ...adapter,
      send: async () => {
        sends++;
        throw new CompanionError("中断", true);
      },
    },
    () => {},
    () => {},
  );
  await unknown.enqueue(r);
  await unknown.settled();
  assert.equal(unknown.list()[0].status, "unknown");
  await assert.rejects(unknown.retry(r.id), /不能重试/);
  await unknown.check(r.id);
  assert.equal(unknown.list()[0].status, "unknown");
  const total = sends;
  await unknown.dispose();
  const checkOnly = new ReportStore(
    unknownPath,
    adapter,
    () => {},
    () => {},
  );
  await checkOnly.ready();
  await checkOnly.settled();
  assert.equal(sends, total);
  committed = true;
  await checkOnly.check(r.id);
  assert.equal(checkOnly.list()[0].status, "written");
  assert.equal(sends, total);
  await checkOnly.dispose();
});

test("explicit report failures retry safely and storage corruption never overwrites history", async () => {
  let calls = 0,
    fail = true;
  const adapter: CompanionAdapter = {
    list: async () => [],
    preview: async () => context(),
    send: async () => {
      calls++;
      if (fail) throw new CompanionError("模型不可用");
      return { text: "好了" };
    },
    findReceipt: async () => null,
  };
  const path = await file(),
    store = new ReportStore(
      path,
      adapter,
      () => {},
      () => {},
    );
  await store.enqueue(report());
  await store.settled();
  assert.equal(store.list()[0].status, "failed");
  fail = false;
  await store.retry(report().id);
  await store.settled();
  assert.equal(calls, 2);
  assert.equal(store.list()[0].status, "written");
  await store.dispose();
  const corrupt = await file();
  await writeFile(corrupt, "broken history", "utf8");
  const guarded = new ReportStore(
    corrupt,
    adapter,
    () => {},
    () => {},
  );
  await guarded.ready();
  await assert.rejects(guarded.enqueue(report()));
  assert.equal(await readFile(corrupt, "utf8"), "broken history");
  assert.equal(calls, 2);
  await guarded.dispose();
});
