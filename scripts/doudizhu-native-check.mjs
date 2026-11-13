import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { fixture, load } from "./dsh-fixture.mjs";
const { LlmAdapter } = await load("@deepseek-ai/dsh-llm");
const { defineTool } = await load("@deepseek-ai/dsh-tools");
const f = await fixture("doudizhu-native"),
  { ctx, p } = f;
const counts = { agent: 0, agent2: 0 },
  replies = { agent: 0, agent2: 0 },
  batches = { agent: [], agent2: [] };
let faulty = null,
  holds = new Map(),
  injectionChecked = 0;
const packet = (messages) => {
  for (const m of [...messages].reverse())
    for (const b of m.role === "user" ? m.content : []) {
      if (b.type !== "text") continue;
      try {
        const o = JSON.parse(b.text);
        if (Array.isArray(o.humanChat)) return o;
      } catch {}
    }
  throw Error("missing wake packet");
};
function validate(value, seat) {
  if (!value || typeof value !== "object") return;
  if (
    value.viewer &&
    Array.isArray(value.seats) &&
    value.phase !== "finished"
  ) {
    assert.equal(value.viewer, seat);
    assert.equal(value.seats.filter((s) => s.cards).length, 1);
    assert.equal(value.seats.find((s) => s.cards)?.seat, seat);
  }
  for (const v of Object.values(value)) validate(v, seat);
}
function action(o) {
  const bid = o.actions.find((a) => a.kind === "bid"),
    play = o.actions.find((a) => a.kind === "play");
  return bid
    ? { kind: "bid", score: Math.max(...bid.scores) }
    : play
      ? { kind: "play", cards: play.suggestions[0] }
      : o.actions[0];
}
try {
  ctx.tools.register(
    defineTool({
      name: "unrelated_tool",
      description: "must remain absent in both game scopes",
      parameters: {},
      output: {
        schema: { type: "string" },
        render: (_a, value) => [{ type: "text", text: value }],
      },
      execute: async () => {
        throw Error("scope_escape");
      },
    }),
  );
  class Model extends LlmAdapter {
    constructor(seat) {
      super();
      this.seat = seat;
    }
    providerInfo() {
      return { id: "ddz-" + this.seat, name: this.seat + " simulator" };
    }
    async listModels() {
      return [
        {
          provider: "ddz-" + this.seat,
          id: this.seat + "-model",
          name: this.seat,
        },
      ];
    }
    async *stream(options) {
      const seat = this.seat,
        input = packet(options.messages),
        view = p.observeAgent(seat),
        o = view.observation;
      counts[seat]++;
      assert.equal(input.seat, seat, "wrong model called for seat");
      const raw = JSON.stringify({
        system: options.system,
        messages: options.messages,
        tools: options.tools,
      });
      assert.ok(!/"(?:seed|rng|deck|randomState)"\s*:/.test(raw));
      assert.deepEqual(options.tools.map((t) => t.name).sort(), [
        "agentgamer_act",
        "agentgamer_observe",
        "agentgamer_read_rules",
        "agentgamer_say",
      ]);
      for (const m of options.messages)
        for (const b of m.content ?? []) {
          if (b.type === "text") {
            try {
              validate(JSON.parse(b.text), seat);
            } catch (e) {
              if (e instanceof assert.AssertionError) throw e;
            }
          }
          if (b.type === "tool-result")
            for (const t of b.content ?? [])
              if (t.type === "text") {
                try {
                  validate(JSON.parse(t.text), seat);
                } catch (e) {
                  if (e instanceof assert.AssertionError) throw e;
                }
              }
        }
      if (holds.has(seat)) {
        const h = holds.get(seat);
        holds.delete(seat);
        h.begin();
        await Promise.race([
          h.gate,
          new Promise((r) =>
            options.signal.addEventListener("abort", r, { once: true }),
          ),
        ]);
        options.signal.throwIfAborted();
      }
      if (faulty === seat) throw Error("simulated failure");
      let call;
      if (o?.actions.length)
        call = {
          name: "agentgamer_act",
          arguments: JSON.stringify({
            matchId: o.matchId,
            expectedRevision: o.revision,
            requestId: crypto.randomUUID(),
            action: { ...action(o), seat: "human" },
          }),
        };
      else if (input.humanChat.some((m) => m.sequence > replies[seat])) {
        const fresh = input.humanChat.filter((m) => m.sequence > replies[seat]);
        replies[seat] = fresh.at(-1).sequence;
        batches[seat].push(fresh.map((m) => m.sequence));
        call = {
          name: "agentgamer_say",
          arguments: JSON.stringify({
            requestId: crypto.randomUUID(),
            kind: "text",
            content: seat + "：收到全桌消息😀",
          }),
        };
      }
      assert.ok(call, "extra observe/wait model request");
      injectionChecked++;
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id: crypto.randomUUID(), ...call },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }
  }
  for (const seat of ["agent", "agent2"]) {
    ctx.llm.registerAdapter(["ddz-" + seat], new Model(seat));
    const result = JSON.parse(
      await ctx.agentgamer.request(
        "configure",
        JSON.stringify({
          seat,
          provider: "ddz-" + seat,
          model: seat + "-model",
        }),
      ),
    );
    assert.ok(result.accepted);
  }
  const sessions = p.snapshot().opponents.map((s) => s.sessionId);
  assert.equal(new Set(sessions).size, 2);
  const games = [];
  for (let n = 0; n < 2; n++) {
    await p.start("doudizhu");
    p.say("human", "hello-" + n, "text", "大家好，我们用公开信息配合。");
    for (let safety = 0; safety < 200; safety++) {
      await p.settled();
      const o = p.snapshot().observation;
      assert.notEqual(p.snapshot().agentStatus, "error", p.snapshot().error);
      if (o.phase === "finished") break;
      assert.ok(o.actions.length, "stalled table");
      assert.ok(
        p.act("human", o.matchId, o.revision, crypto.randomUUID(), action(o))
          .accepted,
      );
    }
    const o = p.snapshot().observation;
    assert.equal(o.phase, "finished");
    assert.equal(
      Object.values(o.result.scores).reduce((a, b) => a + b, 0),
      0,
    );
    games.push({
      matchId: o.matchId,
      revisions: o.revision,
      scores: o.result.scores,
    });
    if (n === 0) {
      const legacy = o;
      await p.leave();
      await p.start("doudizhu");
      await p.settled();
      assert.equal(
        p.act("agent2", legacy.matchId, legacy.revision, "old-match", {
          kind: "pass",
        }).error,
        "match_mismatch",
      );
      await p.leave();
    } else await p.leave();
  }
  assert.deepEqual(
    p.snapshot().opponents.map((s) => s.sessionId),
    sessions,
  );
  // Chat while both real Agents are active: separate cursors and no cross-reply loop.
  await p.start("doudizhu");
  await p.pause();
  const started = [],
    releases = [];
  for (const seat of ["agent", "agent2"]) {
    started.push(
      new Promise((begin) => {
        const gate = new Promise((resolve) => releases.push(resolve));
        holds.set(seat, { begin, gate });
      }),
    );
  }
  p.say("human", "queued-first", "text", "现在同时对话");
  p.resume();
  await Promise.all(started);
  const queued = [];
  for (let i = 0; i < 25; i++)
    queued.push(
      p.say("human", `during-${i}`, "text", `排队消息 ${i}`).sequence,
    );
  releases.forEach((r) => r());
  await p.settled();
  for (const seat of ["agent", "agent2"]) {
    const got = batches[seat].flat();
    assert.deepEqual(
      got.filter((s) => queued.includes(s)),
      queued,
    );
    assert.equal(new Set(got).size, got.length);
  }
  faulty = "agent2";
  p.say("human", "fault", "text", "重试验证");
  await p.settled();
  assert.equal(p.snapshot().opponents[1].status, "error");
  assert.notEqual(p.snapshot().opponents[0].status, "error");
  const match = p.snapshot().observation.matchId;
  faulty = null;
  p.resume("agent2");
  await p.settled();
  assert.equal(p.snapshot().observation.matchId, match);
  const histories = await Promise.all(sessions.map((id) => f.history(id)));
  for (const h of histories)
    assert.ok(JSON.stringify(h).includes("agentgamer_act"));
  await p.pause();
  await p.leave();
  const before = { ...counts };
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(counts, before);
  // Existing two-player game uses only the first session.
  await p.start("liars_dice");
  await p.settled();
  assert.equal(p.observeAgent("agent2").observation, null);
  assert.equal(counts.agent2, before.agent2);
  assert.ok(ctx.tools.get("unrelated_tool"), "ordinary tool registry changed");
  await p.leave();
  const result = {
    target: "DSH 0.2.2-rc.1 real AgentLoop + two independent simulated models",
    games,
    requests: counts,
    batches,
    scopedRequests: injectionChecked,
    historyReadable: histories.length,
  };
  await mkdir(".artifacts", { recursive: true });
  await writeFile(
    ".artifacts/doudizhu-native.json",
    JSON.stringify(result, null, 2),
  );
  console.log("DOUDIZHU_NATIVE_OK", JSON.stringify(result));
} finally {
  await f.close();
}
