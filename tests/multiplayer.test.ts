import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentGamerPlatform } from "../src/platform.js";
import { doudizhu, DoudizhuMatch } from "../src/rules/doudizhu.js";
import { blackjack, BlackjackMatch } from "../src/rules/blackjack.js";
import type {
  Action,
  AgentSeat,
  AgentWakePayload,
  OpponentDriver,
} from "../src/sdk.js";
const move = (packet: AgentWakePayload): Action => {
  const o = packet.observation!,
    bid = o.actions.find((a) => a.kind === "bid"),
    play = o.actions.find((a) => a.kind === "play");
  return bid
    ? { kind: "bid", score: (bid.scores as number[]).at(-1)! }
    : play
      ? { kind: "play", cards: (play.suggestions as any)[0] }
      : { kind: "pass" };
};
const setup = () => {
  const p = new AgentGamerPlatform();
  p.registerGame({
    ...doudizhu,
    create: (id) => new DoudizhuMatch(id, { seed: 55n, starter: "human" }),
  });
  p.registerGame({
    ...blackjack,
    create: (id) => new BlackjackMatch(id, { seed: 1n, dealer: "agent" }),
  });
  return p;
};
test("two independent sessions, hidden views, seat-bound idempotency and two continuous games", async () => {
  const p = setup(),
    wakes: Record<AgentSeat, AgentWakePayload[]> = { agent: [], agent2: [] };
  const canceled = new Set(),
    disposed = new Set();
  const driver = (seat: AgentSeat): OpponentDriver => ({
    sessionId: seat + "-session",
    selectModel: async () => {},
    cancel: async () => {
      canceled.add(seat);
    },
    dispose: async () => {
      disposed.add(seat);
    },
    wake: async (raw) => {
      const packet = JSON.parse(raw) as AgentWakePayload;
      wakes[seat].push(packet);
      assert.equal(packet.seat, seat);
      const o = packet.observation;
      if (o) {
        assert.equal(o.viewer, seat);
        if (o.phase !== "finished") {
          const seats = o.seats as unknown as {
            seat: string;
            cards?: string[];
          }[];
          assert.equal(seats.filter((s) => s.cards).length, 1);
          assert.equal(seats.find((s) => s.cards)?.seat, seat);
        }
        if (o.actions.length) {
          const action = move(packet),
            requestId = `move-${o.matchId}-${o.revision}`;
          const receipt = p.act(seat, o.matchId, o.revision, requestId, action);
          assert.ok(receipt.accepted, receipt.error);
          assert.deepEqual(
            p.act(seat, o.matchId, o.revision, requestId, action),
            receipt,
          );
          assert.equal(
            p.act(seat, o.matchId, o.revision, requestId, { kind: "garbage" })
              .error,
            "request_id_reused",
          );
          assert.equal(receipt.observation!.viewer, seat);
        }
      }
      if (packet.humanChat.length)
        p.say(seat, `reply-${packet.chatSequence}`, "text", `${seat} 收到`);
    },
  });
  await p.configure({ provider: "provider1", model: "model1" }, async () =>
    driver("agent"),
  );
  assert.equal((await p.start("doudizhu")).error, "second_model_required");
  await p.configureSecond(
    { provider: "provider2", model: "model2" },
    async () => driver("agent2"),
  );
  const sessions = p.snapshot().opponents!.map((s) => s.sessionId);
  assert.equal(new Set(sessions).size, 2);
  let old: any;
  for (let game = 0; game < 2; game++) {
    assert.equal((await p.start("doudizhu")).accepted, true);
    assert.equal(
      (
        await p.configureSecond({ provider: "p", model: "changed" }, async () =>
          driver("agent2"),
        )
      ).error,
      "model_locked",
    );
    const before = p.snapshot().observation!;
    p.say("human", `hello-${game}`, "text", "大家加油😀");
    await p.settled();
    assert.equal(
      p.snapshot().observation!.revision,
      before.revision,
      "chat doesn't advance game",
    );
    const afterReplies = wakes.agent.length + wakes.agent2.length;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      wakes.agent.length + wakes.agent2.length,
      afterReplies,
      "agent replies don't wake each other",
    );
    for (let i = 0; i < 180; i++) {
      await p.settled();
      const o = p.snapshot().observation!;
      assert.notEqual(p.snapshot().agentStatus, "error", p.snapshot().error);
      if (o.phase === "finished") break;
      assert.ok(o.actions.length, "must stop at human decision");
      const packet = { observation: o } as AgentWakePayload,
        action = move(packet),
        requestId = crypto.randomUUID();
      const receipt = p.act("human", o.matchId, o.revision, requestId, action);
      assert.ok(receipt.accepted, receipt.error);
      old ??= { o, action, requestId, receipt };
    }
    assert.equal(p.snapshot().observation!.phase, "finished");
    const messages = p.snapshot().messages;
    assert.ok(
      messages.some((m) => m.sender === "agent" && m.senderName === "对手 1"),
    );
    assert.ok(
      messages.some((m) => m.sender === "agent2" && m.senderName === "对手 2"),
    );
    await p.leave();
  }
  assert.deepEqual(
    p.snapshot().opponents!.map((s) => s.sessionId),
    sessions,
  );
  assert.equal(
    p.act("human", old.o.matchId, 999, "old", old.action).error,
    "match_mismatch",
  );
  assert.deepEqual(
    p.act("human", old.o.matchId, old.o.revision, old.requestId, old.action),
    old.receipt,
  );
  const secondCalls = wakes.agent2.length;
  await p.start("blackjack");
  assert.equal(p.observeAgent("agent2").observation, null);
  assert.equal(
    p.act("agent2", p.snapshot().observation!.matchId, 1, "inactive", {
      kind: "bet",
      amount: 10,
    }).error,
    "seat_inactive",
  );
  assert.equal(
    p.say("agent2", "inactive-chat", "text", "不应发送").error,
    "seat_inactive",
  );
  await p.settled();
  assert.equal(wakes.agent2.length, secondCalls);
  await p.dispose();
  assert.equal(canceled.size, 2);
  assert.equal(disposed.size, 2);
});
test("one model error pauses only its seat; retry keeps both seats and the match", async () => {
  const p = setup();
  let fault = true,
    primaryWakes = 0,
    secondWakes = 0;
  await p.configure({ provider: "p", model: "one" }, async () => ({
    sessionId: "one",
    selectModel: async () => {},
    cancel: async () => {},
    dispose: async () => {},
    wake: async () => {
      primaryWakes++;
      p.say("agent", `a${primaryWakes}`, "text", "主席位正常");
    },
  }));
  await p.configureSecond({ provider: "p", model: "two" }, async () => ({
    sessionId: "two",
    selectModel: async () => {},
    cancel: async () => {},
    dispose: async () => {},
    wake: async () => {
      secondWakes++;
      if (fault) throw Error("private-model-detail");
      p.say("agent2", `b${secondWakes}`, "text", "恢复");
    },
  }));
  await p.start("doudizhu");
  const before = p.snapshot().observation!;
  p.say("human", "error-chat", "text", "你好");
  await p.settled();
  assert.equal(p.snapshot().opponents![0].status, "idle");
  assert.equal(p.snapshot().opponents![1].status, "error");
  assert.equal(p.observeAgent("agent").paused, false);
  assert.equal(p.observeAgent("agent2").paused, true);
  assert.ok(!JSON.stringify(p.snapshot()).includes("private-model-detail"));
  fault = false;
  p.resume("agent2");
  await p.settled();
  assert.equal(secondWakes, 2);
  assert.equal(primaryWakes, 1);
  assert.equal(p.snapshot().agentStatus, "idle");
  assert.deepEqual(p.snapshot().observation, before);
  await p.pause();
  p.resume("agent2");
  p.say("human", "only-two", "text", "只恢复对手2");
  await p.settled();
  assert.equal(p.observeAgent("agent").paused, true);
  assert.equal(primaryWakes, 1);
  assert.equal(secondWakes, 3);
  p.resume("agent");
  await p.settled();
  assert.equal(primaryWakes, 2);
  await p.dispose();
});
test("both chat models run independently and leave cancels both without deferred wakes", async () => {
  const p = setup(),
    began = new Set<AgentSeat>();
  const gates = new Map<AgentSeat, () => void>();
  let calls = 0;
  const create = (seat: AgentSeat): OpponentDriver => ({
    sessionId: seat,
    selectModel: async () => {},
    dispose: async () => {
      gates.get(seat)?.();
    },
    cancel: async () => {
      gates.get(seat)?.();
    },
    wake: async () => {
      calls++;
      began.add(seat);
      await new Promise<void>((r) => gates.set(seat, r));
      throw Error("cancelled");
    },
  });
  await p.configure({ provider: "p", model: "a" }, async () => create("agent"));
  await p.configureSecond({ provider: "p", model: "b" }, async () =>
    create("agent2"),
  );
  await p.start("doudizhu");
  p.say("human", "first", "text", "同时聊天");
  while (began.size < 2) await new Promise((r) => setTimeout(r, 1));
  p.say("human", "queued", "text", "思考时继续说");
  await p.leave();
  await p.settled();
  assert.equal(p.snapshot().observation, null);
  assert.equal(p.snapshot().error, "");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2);
  await p.dispose();
});
test("connecting the second seat retries interrupted first-seat chat without losing the batch", async () => {
  const p = setup();
  let calls = 0,
    release = () => {},
    began = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    began = r;
  });
  await p.configure({ provider: "p", model: "a" }, async () => ({
    sessionId: "a",
    selectModel: async () => {},
    dispose: async () => {},
    cancel: async () => {
      release();
    },
    wake: async (raw) => {
      calls++;
      if (calls === 1) {
        began();
        await gate;
        throw Error("cancelled");
      }
      assert.equal(JSON.parse(raw).humanChat[0].content, "连接期间也要保留");
      p.say("agent", "eventual-reply", "text", "已收到");
    },
  }));
  p.say("human", "during-configure", "text", "连接期间也要保留");
  await started;
  await p.configureSecond({ provider: "p", model: "b" }, async () => ({
    sessionId: "b",
    selectModel: async () => {},
    cancel: async () => {},
    dispose: async () => {},
    wake: async () => {
      throw Error("inactive second seat");
    },
  }));
  await p.settled();
  assert.equal(calls, 2);
  assert.equal(
    p.snapshot().messages.filter((m) => m.sender === "agent").length,
    1,
  );
  await p.dispose();
});
