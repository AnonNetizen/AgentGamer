import assert from "node:assert/strict";
import { build } from "esbuild";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, load, runtime } from "./dsh-fixture.mjs";

const { LlmAdapter, createUserMessage } = await load("@deepseek-ai/dsh-llm");
const { defineTool } = await load("@deepseek-ai/dsh-tools");
const output = await build({
  entryPoints: ["src/rules/blackjack.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
});
const fixtureFile = join(runtime, "agentgamer-check/blackjack-fixture.mjs");
await mkdir(join(runtime, "agentgamer-check"), { recursive: true });
await writeFile(fixtureFile, output.outputFiles[0].text);
const { BlackjackMatch, blackjack } = await import(
  pathToFileURL(fixtureFile).href
);
function shoe() {
  const remaining = [];
  for (let i = 0; i < 6; i++)
    for (let suit = 0; suit < 4; suit++)
      for (let rank = 1; rank <= 13; rank++) remaining.push({ rank, suit });
  const first = [];
  for (let i = 0; i < 10; i++)
    for (const card of [
      { rank: 10, suit: i % 4 },
      { rank: 9, suit: (i + 2) % 4 },
      { rank: 8, suit: i % 4 },
      { rank: 8, suit: (i + 1) % 4 },
    ]) {
      const at = remaining.findIndex(
        (c) => c.rank === card.rank && c.suit === card.suit,
      );
      assert.ok(at >= 0, "fixture must be a valid six-deck shoe");
      first.push(remaining.splice(at, 1)[0]);
    }
  return [...first, ...remaining];
}
function wakeInput(messages) {
  for (const message of [...messages].reverse())
    if (message.role === "user")
      for (const block of message.content || [])
        if (block.type === "text") {
          try {
            const data = JSON.parse(block.text);
            if (Array.isArray(data.humanChat)) return data;
          } catch {}
        }
  return { humanChat: [] };
}
async function setup(tag, hostFile) {
  const f = await fixture(tag, hostFile),
    { ctx, p } = f;
  const state = {
    requests: [],
    mode: "play",
    replied: 0,
    lastSay: null,
    duplicate: false,
    hold: null,
  };
  p.registerGame({
    ...blackjack,
    id: "benchmark-blackjack",
    create: (id) => new BlackjackMatch(id, { dealer: "human", shoe: shoe() }),
  });
  class Model extends LlmAdapter {
    providerInfo() {
      return { id: "token-mock", name: "Token regression simulator" };
    }
    async listModels() {
      return [{ provider: "token-mock", id: "test", name: "test" }];
    }
    async *stream(options) {
      const o = p.observeAgent().observation,
        input = wakeInput(options.messages);
      const serialized = JSON.stringify({
        messages: options.messages,
        tools: options.tools,
      });
      state.requests.push({
        matchId: o?.matchId ?? null,
        hand: o?.handNumber,
        phase: o?.phase,
        bytes: Buffer.byteLength(serialized),
        messages: options.messages.length,
        chatSequences: input.humanChat.map((m) => m.sequence),
      });
      if (state.hold) {
        const hold = state.hold;
        state.hold = null;
        hold.begin();
        await hold.gate;
        options.signal.throwIfAborted();
      }
      assert.ok(!/"(?:shoe|seed|rng|randomState)"\s*:/.test(serialized));
      if (tag !== "baseline") {
        assert.ok(
          !serialized.includes("humanCards"),
          "full hand history leaked into model input",
        );
        if (o)
          assert.equal(
            serialized.split("按闲、庄、闲、庄发牌").length - 1,
            1,
            "rules must appear once",
          );
      }
      if (state.mode === "error") throw Error("simulated provider failure");
      if (state.mode === "wait") {
        options.signal.throwIfAborted();
        await new Promise((r) =>
          options.signal.addEventListener("abort", r, { once: true }),
        );
        options.signal.throwIfAborted();
      }
      let call;
      if (state.mode === "duplicate" && !state.duplicate) {
        state.duplicate = true;
        call = {
          name: tag === "baseline" ? "rushagent_say" : "agentgamer_say",
          arguments: JSON.stringify(state.lastSay),
        };
      } else if (o?.actions.length) {
        const a = o.actions[0];
        call = {
          name: tag === "baseline" ? "rushagent_act" : "agentgamer_act",
          arguments: JSON.stringify({
            matchId: o.matchId,
            expectedRevision: o.revision,
            requestId: crypto.randomUUID(),
            action:
              a.kind === "bet"
                ? { kind: "bet", amount: 10 }
                : { kind: "stand" },
          }),
        };
      } else if ((input.humanChat.at(-1)?.sequence ?? 0) > state.replied) {
        state.replied = input.humanChat.at(-1).sequence;
        state.lastSay = {
          requestId: crypto.randomUUID(),
          kind: "text",
          content: "收到，继续游戏！",
        };
        call = {
          name: tag === "baseline" ? "rushagent_say" : "agentgamer_say",
          arguments: JSON.stringify(state.lastSay),
        };
      }
      if (call) {
        const block = { type: "tool-call", id: crypto.randomUUID(), ...call };
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "block-end", index: 0, block };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  ctx.llm.registerAdapter(["token-mock"], new Model());
  const configured = JSON.parse(
    await f.service.request(
      "configure",
      JSON.stringify({ provider: "token-mock", model: "test" }),
    ),
  );
  assert.equal(configured.accepted, true);
  return { ...f, state };
}
async function play(f) {
  const { p, state } = f;
  await p.start("benchmark-blackjack");
  const matchId = p.snapshot().observation.matchId;
  for (let i = 0; i < 60; i++) {
    await p.settled();
    const o = p.snapshot().observation;
    assert.notEqual(p.snapshot().agentStatus, "error", p.snapshot().error);
    if (o.phase === "finished") break;
    if (o.phase === "hand_result")
      p.next(o.matchId, o.revision, crypto.randomUUID());
    else if (o.actions.length) {
      const a = o.actions[0];
      p.act(
        "human",
        o.matchId,
        o.revision,
        crypto.randomUUID(),
        a.kind === "bet" ? { kind: "bet", amount: 10 } : { kind: "stand" },
      );
    } else throw Error("stalled benchmark");
  }
  const done = p.snapshot().observation;
  assert.equal(done.phase, "finished");
  assert.equal(done.handNumber, 10);
  assert.equal(done.history.length, 10);
  assert.ok(done.history[0].humanCards, "human history must remain complete");
  const calls = state.requests.filter((r) => r.matchId === matchId);
  const metrics = {
    calls: calls.length,
    inputBytes: calls.reduce((n, r) => n + r.bytes, 0),
    peakInputBytes: Math.max(...calls.map((r) => r.bytes)),
    peakMessages: Math.max(...calls.map((r) => r.messages)),
  };
  await p.leave();
  return metrics;
}
const baseline = await setup(
  "baseline",
  resolve("tests/baseline/host-0.1.1.js"),
);
const optimized = await setup("optimized");
try {
  const before = [],
    after = [];
  const session = optimized.p.sessionId;
  for (let i = 0; i < 5; i++) {
    before.push(await play(baseline));
    after.push(await play(optimized));
    assert.equal(optimized.p.sessionId, session);
  }
  assert.deepEqual(
    before.map((r) => r.calls),
    [15, 15, 15, 15, 15],
  );
  assert.deepEqual(
    after.map((r) => r.calls),
    [10, 10, 10, 10, 10],
  );
  assert.ok(
    after[0].inputBytes <= before[0].inputBytes * 0.5,
    "at least 50% serialized input reduction",
  );
  assert.ok(
    after[4].peakInputBytes <= after[3].peakInputBytes * 1.1,
    "bounded context must plateau",
  );
  const { ctx, p, state } = optimized;
  const native = ctx.agents.get(session),
    originalLog = native.session.snapshotEvents().length;
  p.say("human", "first-chat", "text", "聊天应当回复");
  let at = state.requests.length;
  await p.settled();
  assert.equal(
    state.requests.length - at,
    1,
    "chat reply must not require a final empty call",
  );
  state.mode = "duplicate";
  state.duplicate = false;
  p.say("human", "next-chat", "text", "旧的发言回执不算回复新消息");
  at = state.requests.length;
  await p.settled();
  assert.equal(
    state.requests.length - at,
    2,
    "old duplicate say must not terminate a new chat turn",
  );
  state.mode = "play";
  // A game action may finish before the pending chat is answered. Keep the reply opportunity.
  await p.start("benchmark-blackjack");
  p.say("human", "during-action", "text", "行动后也要回复");
  at = state.requests.length;
  await p.settled();
  assert.equal(
    state.requests.length - at,
    3,
    "bet, stand, then public say without empty stop",
  );
  assert.equal(p.snapshot().observation.phase, "hand_result");
  await p.leave();
  let begin, release;
  const started = new Promise((r) => (begin = r)),
    gate = new Promise((r) => (release = r));
  state.hold = { begin, gate };
  at = state.requests.length;
  const expected = [
    p.say("human", "during-think-first", "text", "思考期间继续排队").sequence,
  ];
  await started;
  for (let i = 0; i < 45; i++)
    expected.push(
      p.say("human", "during-think-" + i, "text", String(i)).sequence,
    );
  release();
  await p.settled();
  assert.deepEqual(
    state.requests.slice(at).map((r) => r.chatSequences.length),
    [1, 20, 20, 5],
  );
  assert.deepEqual(
    state.requests.slice(at).flatMap((r) => r.chatSequences),
    expected,
    "all queued chat must be delivered FIFO",
  );
  state.mode = "error";
  p.say("human", "failed-chat", "text", "失败后的原消息");
  await p.settled();
  assert.equal(p.snapshot().agentStatus, "error");
  state.mode = "play";
  p.resume();
  await p.settled();
  assert.equal(p.snapshot().agentStatus, "idle");
  // Pause exactly while the maintenance callback appends its replacement, before followup.
  at = state.requests.length;
  let pausePromise;
  let stopped = false;
  const dispose = ctx.on("session/event", (s, event) => {
    if (
      !stopped &&
      s.id === session &&
      event.type === "user/message" &&
      typeof event.surfaceOp === "object"
    ) {
      stopped = true;
      pausePromise = p.pause();
    }
  });
  p.say("human", "maintenance-cancel", "text", "维护期间取消不能再唤醒");
  await p.settled();
  await pausePromise;
  dispose();
  assert.ok(stopped);
  assert.equal(state.requests.length, at);
  assert.equal(p.snapshot().agentStatus, "paused");
  p.resume();
  await p.settled();
  assert.equal(p.snapshot().agentStatus, "idle");
  const history = await optimized.history(session);
  assert.ok(history.records.length > 20);
  assert.ok(native.session.snapshotEvents().length > originalLog);
  assert.ok(native.session.deriveMessages().length < 15);
  ctx.tools.register(
    defineTool({
      name: "ordinary_sentinel",
      description: "ordinary session",
      parameters: {},
      output: {
        schema: { type: "string" },
        render: (_, v) => [{ type: "text", text: v }],
      },
      execute: async () => "ok",
    }),
  );
  const ordinary = await ctx.agents.create({
    sessionId: "ordinary-token-check",
    meta: { cwd: process.cwd() },
    agentOptions: { provider: "token-mock", model: "test" },
  });
  ordinary.agent.session.append(
    "user/message",
    createUserMessage({
      source: { kind: "user" },
      content: [{ type: "text", text: "普通会话保留" }],
    }),
    { surfaceOp: "append" },
  );
  const ordinarySurface = JSON.stringify(
    ordinary.agent.session.deriveMessages(),
  );
  p.say("human", "one-more", "text", "再次生成检查点");
  await p.settled();
  assert.equal(
    JSON.stringify(ordinary.agent.session.deriveMessages()),
    ordinarySurface,
  );
  assert.ok(ctx.tools.get("ordinary_sentinel", ordinary.agent));
  await ordinary.dispose();
  const report = {
    baselineVersion: "0.1.1",
    version: JSON.parse(await readFile("package.json", "utf8")).version,
    metric: "serialized request UTF-8 bytes; not provider billing tokens",
    baseline: before,
    optimized: after,
    firstMatchInputReduction: 1 - after[0].inputBytes / before[0].inputBytes,
    history: true,
    chatReply: true,
    queuedChat: true,
    duplicateReceipt: true,
    cancellation: true,
    ordinarySession: true,
  };
  await mkdir(".artifacts", { recursive: true });
  await writeFile(
    ".artifacts/token-benchmark.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  console.log("TOKEN_CHECK_OK");
} finally {
  await baseline.close();
  await optimized.close();
}
