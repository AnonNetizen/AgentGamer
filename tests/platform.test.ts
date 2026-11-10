import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentGamerPlatform } from "../src/platform.js";
import { blackjack, BlackjackMatch } from "../src/rules/blackjack.js";
import type { OpponentDriver, Action } from "../src/sdk.js";
test("persistent opponent, idempotency, old matches, chat and module lifecycle", async () => {
  const p = new AgentGamerPlatform();
  let calls = 0,
    disposes = 0;
  const unregister = p.registerGame({
    ...blackjack,
    create: (id) => new BlackjackMatch(id, { dealer: "agent", seed: 1n }),
  });
  const driver: OpponentDriver = {
    sessionId: "dedicated",
    wake: async () => {
      calls++;
    },
    cancel: async () => {},
    selectModel: async () => {},
    dispose: async () => {
      disposes++;
    },
  };
  await p.configure({ provider: "mock", model: "test" }, async () => driver);
  await p.start("blackjack");
  const o = p.snapshot().observation!,
    action: Action = { kind: "bet", amount: 10 };
  const first = p.act("human", o.matchId, o.revision, "a", action);
  assert.equal(first.accepted, true);
  assert.deepEqual(p.act("human", o.matchId, o.revision, "a", action), first);
  assert.deepEqual(
    p.act("human", o.matchId, o.revision, "a", { amount: 10, kind: "bet" }),
    first,
  );
  assert.equal(
    p.act("human", o.matchId, o.revision, "a", { kind: "bet", amount: 20 })
      .error,
    "request_id_reused",
  );
  const revision = p.snapshot().observation!.revision;
  assert.equal(p.say("human", "c", "text", "😀".repeat(500)).accepted, true);
  assert.equal(
    p.say("human", "long", "text", "😀".repeat(501)).error,
    "chat_too_long",
  );
  assert.equal(p.say("human", "blank", "text", " \n").error, "chat_empty");
  assert.equal(
    p.say("human", "blank", "text", "changed").error,
    "request_id_reused",
  );
  assert.equal(
    p.say("human", "family", "text", "👨‍👩‍👧‍👦".repeat(500)).accepted,
    true,
  );
  assert.equal(
    p.say("human", "c", "text", "changed").error,
    "request_id_reused",
  );
  p.say("agent", "reply", "emoji", "👍");
  assert.equal(p.snapshot().unread, 1);
  p.markRead(p.snapshot().chatSequence);
  assert.equal(p.snapshot().unread, 0);
  assert.equal(p.snapshot().observation!.revision, revision);
  await p.settled();
  const previousCalls = calls;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, previousCalls);
  await p.leave();
  await p.start("blackjack");
  assert.equal(p.sessionId, "dedicated");
  assert.equal(
    p.act("human", o.matchId, 99, "old", action).error,
    "match_mismatch",
  );
  assert.deepEqual(p.act("human", o.matchId, o.revision, "a", action), first);
  unregister();
  assert.equal(p.snapshot().game, null);
  assert.match(p.snapshot().error, /卸载/);
  for (let i = 0; i < 1005; i++) p.say("agent", `bulk-${i}`, "text", String(i));
  assert.equal(p.snapshot().messages.length, 1000);
  assert.equal(p.snapshot().truncated, true);
  assert.equal(p.readChat(undefined, undefined, 100).messages.length, 100);
  const page = p.readChat(0, undefined, 100);
  assert.equal(page.messages.length, 100);
  assert.throws(() => p.readChat(0, 3));
  await p.dispose();
  assert.equal(disposes, 1);
});

test("preferences bootstrap once and chat wakes native view wait without game revision", async () => {
  const p = new AgentGamerPlatform();
  p.registerGame({
    ...blackjack,
    create: (id) => new BlackjackMatch(id, { dealer: "agent" }),
  });
  p.initializePreferences({ fontPercent: 125, reduceMotion: true });
  p.initializePreferences({ fontPercent: 100, reduceMotion: false });
  assert.deepEqual(p.snapshot().preferences, {
    fontPercent: 125,
    reduceMotion: true,
  });
  const waiting = p.wait(p.snapshot().cursor);
  p.say("human", "offline-chat", "text", "还未连接也能留言");
  assert.equal((await waiting).chatSequence, 1);
  assert.equal(p.snapshot().observation, null);
  await p.dispose();
});
test("two automatic wakes per unchanged actionable revision, explicit retry and cancellation", async () => {
  const p = new AgentGamerPlatform();
  p.registerGame({
    ...blackjack,
    create: (id) => new BlackjackMatch(id, { dealer: "human" }),
  });
  let wakes = 0,
    cancels = 0;
  await p.configure({ provider: "mock", model: "test" }, async () => ({
    sessionId: "test",
    wake: async () => {
      wakes++;
    },
    selectModel: async () => {},
    cancel: async () => {
      cancels++;
    },
    dispose: async () => {},
  }));
  await p.start("blackjack");
  await p.settled();
  assert.equal(wakes, 2);
  assert.equal(p.snapshot().agentStatus, "error");
  assert.equal(p.snapshot().observation!.revision, 1);
  p.resume();
  await p.settled();
  assert.equal(wakes, 4);
  await p.pause();
  assert.ok(cancels > 0);
  await p.dispose();
});
test("model errors preserve state and do not autoplay", async () => {
  const p = new AgentGamerPlatform();
  p.registerGame({
    ...blackjack,
    create: (id) => new BlackjackMatch(id, { dealer: "human" }),
  });
  await p.configure({ provider: "mock", model: "test" }, async () => ({
    sessionId: "test",
    wake: async () => {
      throw Error("simulated");
    },
    selectModel: async () => {},
    cancel: async () => {},
    dispose: async () => {},
  }));
  await p.start("blackjack");
  await p.settled();
  assert.equal(p.snapshot().agentStatus, "error");
  assert.equal(p.snapshot().observation!.revision, 1);
  await p.dispose();
});
