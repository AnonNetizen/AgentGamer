import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, load } from "./dsh-fixture.mjs";
const { LlmAdapter } = await load("@deepseek-ai/dsh-llm");
const f = await fixture("dice-native"),
  { ctx, p } = f;
const requests = [],
  batches = [];
let replied = 0,
  fault = false,
  hold = null;
function packet(messages) {
  for (const m of [...messages].reverse())
    for (const b of m.role === "user" ? m.content : []) {
      if (b.type !== "text") continue;
      try {
        const v = JSON.parse(b.text);
        if (Array.isArray(v.humanChat)) return v;
      } catch {}
    }
  return { humanChat: [] };
}
function action(o) {
  if (o.actions.some((a) => a.kind === "challenge"))
    return { kind: "challenge" };
  const a = o.actions[0];
  if (a.kind === "bid") {
    const r = a.options[0];
    return { kind: "bid", quantity: r.minimum, face: r.face, mode: r.mode };
  }
  return a.kind === "bet"
    ? { kind: "bet", amount: 10 }
    : a.kind === "add"
      ? { kind: "add", amount: 1 }
      : { kind: "stand" };
}
try {
  class Model extends LlmAdapter {
    providerInfo() {
      return { id: "dice-mock", name: "Dice native simulator" };
    }
    async listModels() {
      return [{ provider: "dice-mock", id: "test", name: "test" }];
    }
    async *stream(options) {
      const input = packet(options.messages),
        view = p.observeAgent(),
        o = view.observation;
      const raw = JSON.stringify({
        messages: options.messages,
        tools: options.tools,
      });
      requests.push({
        game: view.game?.id,
        revision: o?.revision,
        bytes: Buffer.byteLength(raw),
      });
      if (hold) {
        const h = hold;
        hold = null;
        h.begin();
        await Promise.race([
          h.gate,
          new Promise((r) =>
            options.signal.addEventListener("abort", r, { once: true }),
          ),
        ]);
        options.signal.throwIfAborted();
      }
      if (fault) throw Error("simulated_model_failure");
      assert.ok(!/"(?:seed|rng|randomState)"\s*:/.test(raw));
      assert.deepEqual(options.tools.map((t) => t.name).sort(), [
        "agentgamer_act",
        "agentgamer_observe",
        "agentgamer_read_rules",
        "agentgamer_say",
      ]);
      if (view.game?.id === "liars_dice") {
        assert.ok(!raw.includes("humanCards"));
        assert.ok(
          !raw.includes("humanDice"),
          "full round history reached model",
        );
        assert.ok(!raw.includes("按闲、庄、闲、庄发牌"));
        if (o.phase === "bidding") {
          assert.deepEqual(o.opponent.dice, [null, null, null, null, null]);
          assert.equal(o.result, null);
        }
      }
      let call;
      if (o?.actions.length)
        call = {
          name: "agentgamer_act",
          arguments: JSON.stringify({
            matchId: o.matchId,
            expectedRevision: o.revision,
            requestId: crypto.randomUUID(),
            action: action(o),
          }),
        };
      else if (input.humanChat.some((m) => m.sequence > replied)) {
        const fresh = input.humanChat.filter((m) => m.sequence > replied);
        batches.push(fresh.map((m) => m.sequence));
        replied = Math.max(...fresh.map((m) => m.sequence));
        call = {
          name: "agentgamer_say",
          arguments: JSON.stringify({
            requestId: crypto.randomUUID(),
            kind: "text",
            content: "收到，继续吹牛骰！😀",
          }),
        };
      }
      assert.ok(call, "unexpected extra model wait/observe request");
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id: crypto.randomUUID(), ...call },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }
  }
  ctx.llm.registerAdapter(["dice-mock"], new Model());
  assert.equal(
    JSON.parse(
      await ctx.agentgamer.request(
        "configure",
        JSON.stringify({ provider: "dice-mock", model: "test" }),
      ),
    ).accepted,
    true,
  );
  const session = p.sessionId,
    games = [];
  for (let n = 0; n < 2; n++) {
    const first = requests.length;
    assert.equal((await p.start("liars_dice")).accepted, true);
    for (let safety = 0; safety < 50; safety++) {
      await p.settled();
      const o = p.snapshot().observation;
      assert.notEqual(p.snapshot().agentStatus, "error", p.snapshot().error);
      if (o.phase === "finished") break;
      if (o.phase === "round_result")
        assert.equal(
          p.next(o.matchId, o.revision, crypto.randomUUID()).accepted,
          true,
        );
      else if (o.actions.length)
        assert.equal(
          p.act("human", o.matchId, o.revision, crypto.randomUUID(), action(o))
            .accepted,
          true,
        );
      else throw Error("stalled_dice_game");
    }
    const o = p.snapshot().observation;
    assert.equal(o.phase, "finished");
    assert.equal(
      requests.length - first,
      o.roundNumber,
      "one request per Agent decision, no observe/wait request",
    );
    games.push({
      rounds: o.roundNumber,
      requests: requests.length - first,
      score: o.score,
    });
    await p.leave();
    assert.equal(p.sessionId, session);
  }
  // Queue chat while the model is actually in stream(), then verify bounded batches.
  let begin, release;
  const started = new Promise((r) => (begin = r)),
    gate = new Promise((r) => (release = r));
  hold = { begin, gate };
  p.say("human", "first-chat", "text", "先收到这条");
  await started;
  for (let i = 0; i < 45; i++)
    p.say("human", "queued-" + i, "text", "排队消息" + i);
  release();
  await p.settled();
  assert.deepEqual(
    batches.map((b) => b.length),
    [1, 20, 20, 5],
  );
  const revision = p.snapshot().observation?.revision;
  fault = true;
  p.say("human", "retry-chat", "text", "错误后重试");
  await p.settled();
  assert.equal(p.snapshot().agentStatus, "error");
  fault = false;
  p.resume();
  await p.settled();
  assert.equal(p.snapshot().agentStatus, "idle");
  assert.equal(p.snapshot().observation?.revision, revision);
  // Chat delivered with an actionable wake survives concludeTurn after the action.
  await p.pause();
  await p.start("liars_dice");
  await p.pause();
  let o = p.snapshot().observation;
  if (o.actions.length)
    p.act("human", o.matchId, o.revision, crypto.randomUUID(), action(o));
  p.say("human", "with-action", "text", "叫完也要回复我");
  const chats = p
    .snapshot()
    .messages.filter((m) => m.sender === "agent").length;
  p.resume();
  await p.settled();
  assert.ok(
    p.snapshot().messages.filter((m) => m.sender === "agent").length > chats,
  );
  // Cancel while waiting in the model and prove no delayed action after leave.
  const gate2 = new Promise((r) => (release = r)),
    started2 = new Promise((r) => (begin = r));
  hold = { begin, gate: gate2 };
  p.say("human", "cancel-chat", "text", "等待取消");
  await started2;
  await p.leave();
  release();
  await p.settled();
  assert.equal(p.snapshot().game, null);
  // Cross-game rules and legacy SDK view without changing the session.
  const extension = await ctx.plugin(
    await import(pathToFileURL(resolve("examples/counting/host.js")).href),
  );
  for (const game of ["blackjack", "counting", "liars_dice"]) {
    await p.start(game);
    for (let safety = 0; safety < 100; safety++) {
      await p.settled();
      o = p.snapshot().observation;
      assert.notEqual(p.snapshot().agentStatus, "error", p.snapshot().error);
      if (o.phase === "finished") break;
      if (o.phase === "hand_result" || o.phase === "round_result")
        p.next(o.matchId, o.revision, crypto.randomUUID());
      else if (o.actions.length)
        p.act("human", o.matchId, o.revision, crypto.randomUUID(), action(o));
      else throw Error("stalled_" + game);
    }
    assert.equal(p.snapshot().observation.phase, "finished");
    await p.leave();
    assert.equal(p.sessionId, session);
  }
  const history = await f.history(session);
  assert.ok(history.records.length);
  assert.ok(JSON.stringify(history.records).includes("liars_dice"));
  await extension.dispose();
  const report = {
    games,
    queuedBatches: batches.slice(0, 4).map((b) => b.length),
    history: true,
    sessionReused: true,
    chatReply: true,
    recovery: true,
    cancellation: true,
    crossGame: true,
    requests: requests.length,
  };
  await writeFile(
    ".artifacts/dice-native-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("DICE_NATIVE_CHECK_OK", JSON.stringify(report));
} finally {
  await f.close();
}
