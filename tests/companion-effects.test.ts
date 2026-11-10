import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  DshPetAdapter,
  companionKey,
  type CompanionAdapter,
  type CompanionReaction,
} from "../src/companion.js";
import { CompanionEffects } from "../src/companion-effects.js";
import { AgentGamerPlatform } from "../src/platform.js";
import { ReportStore } from "../src/reports.js";
import type {
  CompanionDisplay,
  CompanionRef,
  GameDefinition,
  CompanionPreview,
} from "../src/sdk.js";
const ref = { entry: "main", petId: "fish" };
const display = (r = ref): CompanionDisplay => ({
  ...r,
  key: companionKey(r),
  name: "伙伴",
  kind: "dsh_pet",
});
const preview = (r: CompanionRef): CompanionPreview => ({
  display: display(r),
  persona: "陪玩",
  turns: [],
  personaBytes: 6,
  memoryBytes: 2,
  configuredRounds: 0,
  loadedRounds: 0,
  omitted: false,
});

test("native reaction routes: custom animation pools, silent pure-text broadcast, short owned leases and failure cleanup", async () => {
  const posts: { path: string; body: any }[] = [];
  let sleeping = false,
    locked = false,
    deleted = false,
    reduced = false;
  let abortOnBroadcast: AbortController | null = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://test");
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      if (url.pathname.endsWith("/config"))
        res.end(
          JSON.stringify({
            main: {
              pets: deleted ? [] : [{ id: "fish" }],
              animations: {
                clicks: ["自定义挥手"],
                events: {
                  workStatus: [
                    "思考",
                    "忙",
                    "整理",
                    "等待",
                    "自定义胜利",
                    ["自定义失落"],
                  ],
                },
              },
            },
          }),
        );
      else
        res.end(
          JSON.stringify({ pets: { fish: { sleep: { data: { sleeping } } } } }),
        );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    posts.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/lock")) {
      assert.equal(body.ttl, 4000);
      res.end(
        JSON.stringify(
          locked
            ? { ok: false, reason: "locked" }
            : { ok: true, lockId: "our-lease" },
        ),
      );
    } else {
      if (!url.pathname.endsWith("/release"))
        assert.equal(url.searchParams.get("lock"), "our-lease");
      if (url.pathname.endsWith("/broadcast")) {
        assert.equal(body.speak, false);
        assert.equal(body.anim, false);
        assert.equal(body.duration, 10000);
        abortOnBroadcast?.abort();
      }
      if (url.pathname.endsWith("/release"))
        assert.deepEqual(body, { lockId: "our-lease" });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const adapter = new DshPetAdapter(
    () => `http://127.0.0.1:${(server.address() as any).port}`,
  );
  const reaction = async (kind: CompanionReaction["kind"]) =>
    adapter.present(
      ref,
      { kind, text: "原样公开发言😀", reduceMotion: reduced },
      new AbortController().signal,
    );
  try {
    assert.equal((await reaction("connected")).animation, "自定义挥手");
    assert.equal((await reaction("win")).animation, "自定义胜利");
    assert.equal((await reaction("loss")).animation, "自定义失落");
    assert.equal((await reaction("chat")).animation, null);
    reduced = true;
    assert.equal((await reaction("win")).animation, null);
    assert.ok(posts.every((p) => !/\/chat$|\/whisper$|\/config$/.test(p.path)));
    const count = posts.length;
    sleeping = true;
    await assert.rejects(reaction("connected"), /休息/);
    assert.equal(posts.length, count);
    sleeping = false;
    locked = true;
    await assert.rejects(reaction("chat"), /占用/);
    assert.equal(posts.at(-1)!.path, "/dsh-pet-7340/lock");
    locked = false;
    abortOnBroadcast = new AbortController();
    await assert.rejects(
      adapter.present(
        ref,
        { kind: "win", text: "公开结果", reduceMotion: false },
        abortOnBroadcast.signal,
      ),
    );
    assert.equal(posts.at(-1)!.path, "/dsh-pet-7340/lock/release");
    deleted = true;
    await assert.rejects(reaction("chat"), /不存在/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("presentation queue cancels old partners, coalesces pending chat and never reports stale success", async () => {
  const calls: string[] = [];
  const adapter = {
    present: async (r, event, signal) => {
      calls.push(r.petId + ":" + event.text);
      if (r.petId === "fish")
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(Error("cancelled")), {
            once: true,
          }),
        );
      return { animation: null };
    },
  } as CompanionAdapter;
  const effects = new CompanionEffects(adapter, () => {});
  effects.select(display());
  effects.emit(display(), {
    kind: "chat",
    text: "旧伙伴",
    reduceMotion: false,
  });
  await new Promise((r) => setImmediate(r));
  const b = display({ entry: "main", petId: "b" });
  effects.select(b);
  effects.emit(b, { kind: "chat", text: "过时气泡", reduceMotion: false });
  effects.emit(b, { kind: "chat", text: "最新气泡", reduceMotion: false });
  await effects.settled();
  assert.deepEqual(calls, ["fish:旧伙伴", "b:最新气泡"]);
  assert.equal(effects.snapshot().state, "sent");
  await effects.dispose();
});

test("platform reactions: agent-only public chat, idempotency, one settlement cue, preferences and failure isolation", async () => {
  const events: CompanionReaction[] = [];
  let failing = false;
  let wakes = 0;
  const adapter: CompanionAdapter = {
    list: async () => [],
    preview: async (r) => preview(r),
    send: async () => ({ text: "" }),
    findReceipt: async () => null,
    present: async (_r, event) => {
      if (failing) throw Error("来源离线");
      events.push(event);
      return { animation: null };
    },
  };
  const dir = resolve(".artifacts/effect-tests");
  await mkdir(dir, { recursive: true });
  const p = new AgentGamerPlatform();
  p.attachCompanions(
    adapter,
    new ReportStore(
      join(await mkdtemp(join(dir, "case-")), "outbox.json"),
      adapter,
      () => {},
      () => {},
    ),
  );
  const game: GameDefinition = {
    apiVersion: 1,
    id: "reaction_test",
    name: "测试",
    version: "1",
    rulesVersion: "1",
    rules: "公开规则",
    create: (matchId) => {
      let revision = 0;
      return {
        observe: () => ({
          matchId,
          revision,
          phase: revision ? "finished" : "play",
          outcome: revision ? "win" : "",
          actions: [],
        }),
        apply: () => {
          revision++;
          return "";
        },
        nextHand: () => "phase",
      };
    },
  };
  p.registerGame(game);
  await p.configure(
    { provider: "mock", model: "test" },
    async () => ({
      sessionId: "test",
      selectModel: async () => {},
      cancel: async () => {},
      dispose: async () => {},
      wake: async () => {
        wakes++;
      },
    }),
    { companion: ref },
  );
  await p.effectsSettled();
  assert.deepEqual(
    events.map((e) => e.kind),
    ["connected"],
  );
  await p.start(game.id);
  const revision = p.snapshot().observation!.revision;
  p.say("human", "human", "text", "玩家消息不投喂");
  await p.settled();
  p.say("agent", "public", "emoji", "😀");
  p.say("agent", "public", "emoji", "😀");
  await p.effectsSettled();
  assert.equal(events.filter((e) => e.kind === "chat").length, 1);
  assert.equal(events.at(-1)!.text, "😀");
  assert.equal(p.snapshot().observation!.revision, revision);
  p.setPreferences({ fontPercent: 125, reduceMotion: true });
  const o = p.snapshot().observation!;
  p.act("human", o.matchId, o.revision, "finish", { kind: "finish" });
  p.act("human", o.matchId, o.revision, "finish", { kind: "finish" });
  p.markRead(p.snapshot().chatSequence);
  await p.effectsSettled();
  assert.equal(events.filter((e) => e.kind === "win").length, 1);
  assert.equal(events.at(-1)!.reduceMotion, true);
  const oldWakes = wakes;
  failing = true;
  p.testCompanionReaction();
  await p.effectsSettled();
  assert.equal(p.snapshot().companionFeedback!.state, "error");
  assert.equal(p.snapshot().error, "");
  assert.equal(p.snapshot().observation!.phase, "finished");
  assert.equal(wakes, oldWakes);
  await p.dispose();
});
