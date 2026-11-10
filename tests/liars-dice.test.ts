import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countDice,
  liarsDice,
  LiarsDiceMatch,
  type BidRange,
  type DiceRoundRecord,
} from "../src/rules/liars-dice.js";
import { AgentGamerPlatform } from "../src/platform.js";
import { projectAgentContext } from "../src/agent-memory.js";
import type { Actor, Action, Observation } from "../src/sdk.js";
const rolls = () =>
  Array.from({ length: 5 }, () => [
    [6, 6, 6, 6, 6],
    [2, 2, 2, 2, 2],
  ]).flat();
const match = (starter: Actor = "human") =>
  new LiarsDiceMatch("dice-test", { starter, rolls: rolls(), seed: 1n });
const submit = (m: LiarsDiceMatch, action: Action, actor = m.turn) =>
  m.apply(actor, m.revision, action);
const bid = (quantity: number, face: number, mode = "wild"): Action => ({
  kind: "bid",
  quantity,
  face,
  mode,
});
const ranges = (o: Observation) =>
  (o.actions.find((a) => a.kind === "bid")?.options ??
    []) as unknown as BidRange[];

test("dice counting: ones, straight, mixed six, pure seven, all ones and exact fourteen", () => {
  assert.equal(countDice([1, 2, 2, 3, 4], 2, "wild"), 3);
  assert.equal(countDice([1, 2, 2, 3, 4], 2, "straight"), 2);
  assert.equal(countDice([1, 2, 2, 2, 2], 2, "wild"), 6);
  assert.equal(countDice([1, 2, 2, 2, 2], 2, "straight"), 4);
  for (const mode of ["wild", "straight"] as const)
    assert.equal(countDice([2, 2, 2, 2, 2], 2, mode), 7);
  assert.equal(countDice([1, 1, 1, 1, 1], 6, "wild"), 6);
  assert.equal(countDice([1, 1, 1, 1, 1], 6, "straight"), 0);
  assert.equal(countDice([1, 1, 1, 1, 1], 1, "straight"), 7);
  const m = new LiarsDiceMatch("fourteen", {
    starter: "human",
    rolls: [
      [6, 6, 6, 6, 6],
      [6, 6, 6, 6, 6],
    ],
  });
  assert.equal(submit(m, bid(14, 6, "straight")), "");
  assert.deepEqual(m.observe("agent").actions, [{ kind: "challenge" }]);
  assert.equal(submit(m, { kind: "challenge" }), "");
  const result = m.observe("human").result as unknown as DiceRoundRecord;
  assert.equal(result.actual, 14);
  assert.equal(result.winner, "human");
});

test("opening bids, priority, forced straight ones and flying boundaries", () => {
  const m = match();
  assert.equal(submit(m, { kind: "challenge" }), "nothing_to_challenge");
  for (const invalid of [
    bid(2, 2),
    bid(1, 2, "straight"),
    bid(15, 2),
    bid(3.5, 2),
    bid(3, 0),
    bid(3, 7),
    bid(3, 2, "bad"),
  ]) {
    assert.equal(submit(m, invalid), "bid_range");
    assert.equal(m.revision, 1);
  }
  assert.equal(submit(m, bid(3, 6)), "");
  assert.equal(submit(m, bid(3, 6, "straight")), "bid_range");
  assert.equal(submit(m, bid(2, 6)), "bid_range");
  assert.equal(submit(m, bid(4, 2)), "");
  assert.equal(submit(m, bid(4, 3, "straight")), "");
  assert.equal(submit(m, bid(7, 6)), "bid_range");
  assert.equal(submit(m, bid(8, 2)), "");
  const n = match();
  assert.equal(submit(n, bid(2, 1)), "");
  assert.equal((n.observe("human").bid as any).mode, "straight");
  assert.equal(submit(n, bid(2, 2, "straight")), "");
  assert.equal(submit(n, bid(4, 2)), "");
});

test("advertised compact ranges and validation agree for every bid after mode transitions", () => {
  const prefixes = [
    [],
    [bid(3, 2)],
    [bid(2, 1, "straight")],
    [bid(7, 6, "straight")],
    [bid(14, 6, "straight")],
  ];
  for (const prefix of prefixes) {
    const base = match();
    prefix.forEach((a) => assert.equal(submit(base, a), ""));
    const available = ranges(base.observe(base.turn));
    assert.ok(available.length <= 11);
    for (const mode of ["wild", "straight"] as const)
      for (let face = 1; face <= 6; face++)
        for (let quantity = 1; quantity <= 15; quantity++) {
          const m = match();
          prefix.forEach((a) => submit(m, a));
          const effective = face === 1 ? "straight" : mode;
          const legal = available.some(
            (r) =>
              r.face === face &&
              r.mode === effective &&
              quantity >= r.minimum &&
              quantity <= r.maximum,
          );
          assert.equal(
            submit(m, bid(quantity, face, mode)) === "",
            legal,
            JSON.stringify({ prefix, quantity, face, mode }),
          );
        }
  }
});

test("scatter rerolls are public while final opponent rolls stay private in both views", () => {
  const m = new LiarsDiceMatch("private", {
    starter: "human",
    rolls: [
      [1, 2, 3, 4, 5],
      [3, 3, 4, 5, 6],
      [2, 3, 4, 5, 6],
      [2, 2, 3, 4, 5],
    ],
  });
  for (const actor of ["human", "agent"] as const) {
    const o = m.observe(actor),
      compact = projectAgentContext(liarsDice, o).observation;
    assert.deepEqual((o.opponent as any).dice, [null, null, null, null, null]);
    assert.equal(o.result, null);
    assert.deepEqual(o.history, []);
    assert.equal((o.rerolls as any[]).length, 2);
    assert.deepEqual(compact.rerolls, o.rerolls);
    assert.deepEqual((compact.opponent as any).dice, [
      null,
      null,
      null,
      null,
      null,
    ]);
    assert.ok(
      !/"(?:seed|rng|randomState|actual|counts|humanDice|agentDice)"\s*:/.test(
        JSON.stringify(compact),
      ),
    );
  }
  submit(m, bid(3, 2));
  submit(m, { kind: "challenge" });
  assert.deepEqual((m.observe("human").opponent as any).dice, [2, 2, 3, 4, 5]);
  assert.deepEqual((m.observe("agent").opponent as any).dice, [3, 3, 4, 5, 6]);
  const compact = projectAgentContext(liarsDice, m.observe("agent"));
  assert.ok(!JSON.stringify(compact).includes("humanDice"));
  assert.ok(!JSON.stringify(compact).includes("agentDice"));
  assert.equal((m.observe("human").history as any[]).length, 1);
});

test("best of five scores, loser starts, revisions and completed games cannot advance", () => {
  for (const winners of [
    ["human", "human", "human"],
    ["human", "agent", "human", "human"],
    ["human", "agent", "agent", "human", "human"],
  ] as Actor[][]) {
    const m = match();
    winners.forEach((winner, index) => {
      const first = m.turn,
        before = m.revision;
      assert.equal(
        m.apply(first, before - 1, bid(2, 6, "straight")),
        "stale_revision",
      );
      assert.equal(
        submit(
          m,
          bid(
            first === winner ? 2 : 14,
            winner === "human" ? 6 : 2,
            "straight",
          ),
        ),
        "",
      );
      assert.equal(submit(m, { kind: "challenge" }), "");
      const o = m.observe("human"),
        result = o.result as unknown as DiceRoundRecord;
      assert.equal(result.winner, winner);
      assert.equal(o.revision, before + 2);
      assert.equal(submit(m, bid(3, 2)), "phase");
      if (index < winners.length - 1) {
        assert.equal(m.nextHand(), "");
        assert.equal(m.turn, winner === "human" ? "agent" : "human");
        assert.deepEqual((m.observe("human").opponent as any).dice, [
          null,
          null,
          null,
          null,
          null,
        ]);
      }
    });
    assert.equal(m.phase, "finished");
    assert.equal(m.roundNumber, winners.length);
    assert.equal(m.observe("human").outcome, "win");
    assert.equal(m.observe("agent").outcome, "loss");
    assert.equal(m.nextHand(), "phase");
  }
});

test("Host dice receipts keep perspectives, request deduplication, chat and old match isolation", async () => {
  const p = new AgentGamerPlatform();
  p.registerGame({
    ...liarsDice,
    create: (id) =>
      new LiarsDiceMatch(id, { starter: "human", rolls: rolls() }),
  });
  await p.configure({ provider: "test", model: "test" }, async () => ({
    sessionId: "same",
    wake: async () => {},
    cancel: async () => {},
    dispose: async () => {},
    selectModel: async () => {},
  }));
  await p.start("liars_dice");
  let o = p.snapshot().observation!;
  const first = p.act("human", o.matchId, o.revision, "bid", bid(3, 2));
  assert.equal(first.accepted, true);
  assert.deepEqual(
    p.act("human", o.matchId, o.revision, "bid", bid(3, 2)),
    first,
  );
  const agent = p.observeAgent().observation!;
  assert.deepEqual((agent.opponent as any).dice, [
    null,
    null,
    null,
    null,
    null,
  ]);
  const rev = agent.revision;
  const invalid = p.act("agent", agent.matchId, rev, "bad-bid", bid(999, 6));
  assert.equal(invalid.error, "bid_range");
  assert.deepEqual((invalid.observation!.opponent as any).dice, [
    null,
    null,
    null,
    null,
    null,
  ]);
  assert.equal(invalid.observation!.result, null);
  p.say("human", "chat", "text", "你敢开吗？😀");
  assert.equal(p.observeAgent().observation!.revision, rev);
  assert.equal(
    p.act("agent", agent.matchId, rev, "challenge", { kind: "challenge" })
      .accepted,
    true,
  );
  assert.equal(
    (p.observeAgent().observation!.result as any).humanDice,
    undefined,
  );
  await p.leave();
  await p.start("liars_dice");
  assert.equal(
    p.act("agent", o.matchId, rev, "late", { kind: "challenge" }).error,
    "match_mismatch",
  );
  const current = p.snapshot().observation!;
  assert.deepEqual(
    p.act("human", o.matchId, o.revision, "bid", bid(3, 2)),
    first,
  );
  assert.equal(p.snapshot().observation!.revision, current.revision);
  await p.dispose();
});
