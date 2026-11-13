import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RANKS,
  classify,
  beats,
  legalPlays,
  type Rank,
} from "../src/rules/doudizhu-cards.js";
import { DoudizhuMatch, SEATS, doudizhu } from "../src/rules/doudizhu.js";
import type { Action, Actor, Observation } from "../src/sdk.js";
const c = (s: string) => s.split(" ") as Rank[];
const play = (m: DoudizhuMatch, actor: Actor, action: Action) =>
  m.apply(actor, m.revision, action);
const cards = (m: DoudizhuMatch, actor: Actor) =>
  (m.observe(actor).self as { cards: Rank[] }).cards;
const fixture = (human: string, agent: string, agent2: string, bottom = "") =>
  new DoudizhuMatch("test", {
    seed: 1n,
    starter: "human",
    hands: { human: c(human), agent: c(agent), agent2: c(agent2) },
    bottom: bottom ? c(bottom) : [],
  });
export function chooseAction(o: Observation): Action {
  const bid = o.actions.find((a) => a.kind === "bid");
  if (bid) return { kind: "bid", score: 3 };
  const move = o.actions.find((a) => a.kind === "play");
  return move
    ? { kind: "play", cards: (move.suggestions as Rank[][])[0] }
    : { kind: "pass" };
}
test("all supported patterns, attachment boundaries and ordering", () => {
  const cases = [
    ["3", "single"],
    ["2 2", "pair"],
    ["A A A", "triple"],
    ["3 3 3 2", "triple_single"],
    ["3 3 3 2 2", "triple_pair"],
    ["10 J Q K A", "straight"],
    ["3 3 4 4 5 5", "pair_run"],
    ["Q Q Q K K K A A A", "plane"],
    ["3 3 3 4 4 4 2 小王", "plane_single"],
    ["3 3 3 4 4 4 5 5 2 2", "plane_pair"],
    ["3 3 3 3 4 4", "four_single"],
    ["3 3 3 3 小王 大王", "four_single"],
    ["3 3 3 3 4 4 A A", "four_pair"],
    ["2 2 2 2", "bomb"],
    ["小王 大王", "rocket"],
  ];
  for (const [input, kind] of cases)
    assert.equal(classify(c(input))?.kind, kind, input);
  for (const invalid of [
    "J Q K A 2",
    "3 4 5 6",
    "A A 2 2 小王 小王",
    "3 3 3 4 4 4 5 5",
    "3 3 3 3 4 4 4 5",
    "3 3 3 3 4 4 4 4",
    "3 3 3 4 4 4 小王 小王",
    "A A A 2 2 2",
    "3 3 3 3 3",
    "7 7 7 7 7 7",
    "bogus",
  ])
    assert.equal(classify(c(invalid)), null, invalid);
  assert.equal(classify([]), null);
  const bigger = (a: string, b: string) =>
    beats(classify(c(a))!, classify(c(b))!);
  assert.ok(bigger("4 4 4 3", "3 3 3 2"));
  assert.ok(bigger("3 3 3 3", "A A A 2 2"));
  assert.ok(bigger("小王 大王", "2 2 2 2"));
  assert.ok(!bigger("2 2 2 2", "小王 大王"));
  assert.ok(!bigger("4 5 6 7 8 9", "3 4 5 6 7"));
  assert.ok(!bigger("A A A 3 3", "K K K 2"));
});
test("bidding, hidden bottom, three isolated views and all-pass redeal", () => {
  const m = new DoudizhuMatch("deal", { seed: 18n, starter: "human" });
  for (const viewer of SEATS) {
    const o = m.observe(viewer),
      seats = o.seats as unknown as {
        seat: Actor;
        count: number;
        cards?: Rank[];
      }[];
    assert.equal(cards(m, viewer).length, 17);
    assert.deepEqual(o.bottom, []);
    assert.equal(seats.filter((s) => s.cards).length, 1);
    assert.equal(seats.find((s) => s.cards)?.seat, viewer);
    assert.equal(
      seats.reduce((n, s) => n + s.count, 0),
      51,
    );
    assert.equal(o.actions.length, viewer === "human" ? 1 : 0);
  }
  assert.equal(play(m, "agent", { kind: "bid", score: 3 }), "not_your_turn");
  for (const score of [-1, 0.5, 4, "3", null])
    assert.equal(play(m, "human", { kind: "bid", score }), "bid_score");
  for (const actor of SEATS)
    assert.equal(play(m, actor, { kind: "bid", score: 0 }), "");
  assert.equal(m.phase, "redeal");
  assert.equal(m.nextHand(), "");
  assert.equal(m.observe("human").turn, "agent");
  assert.equal(play(m, "agent", { kind: "bid", score: 1 }), "");
  assert.equal(play(m, "agent2", { kind: "bid", score: 1 }), "bid_score");
  assert.equal(play(m, "agent2", { kind: "bid", score: 2 }), "");
  assert.equal(play(m, "human", { kind: "bid", score: 0 }), "");
  assert.equal(m.phase, "playing");
  assert.equal(cards(m, "agent2").length, 20);
  const o = m.observe("human");
  assert.equal((o.bottom as Rank[]).length, 3);
  assert.equal(o.landlord, "agent2");
  const all = SEATS.flatMap((s) => cards(m, s));
  assert.equal(all.length, 54);
  for (const [i, rank] of RANKS.entries())
    assert.equal(all.filter((c) => c === rank).length, i >= 13 ? 1 : 4);
  const compressed = doudizhu.projectAgentContext!(m.observe("agent"));
  assert.equal(
    (compressed.observation.seats as unknown as { cards?: Rank[] }[]).filter(
      (s) => s.cards,
    ).length,
    1,
  );
  assert.ok(
    !/"(?:seed|rng|deck|randomState)"/.test(JSON.stringify(compressed)),
  );
});
test("ownership, stale revisions, pass resets and illegal plays never mutate", () => {
  const m = fixture("3 3 4 5", "6 7", "8 9", "10 J Q");
  assert.equal(play(m, "human", { kind: "bid", score: 3 }), "");
  const before = m.observe("human");
  for (const action of [
    { kind: "pass" },
    { kind: "play", cards: ["2"] },
    { kind: "play", cards: ["3", "5"] },
    { kind: "play", cards: [] },
  ] as Action[])
    assert.notEqual(play(m, "human", action), "");
  assert.deepEqual(m.observe("human"), before);
  assert.equal(
    m.apply("human", 1, { kind: "play", cards: ["3"] }),
    "stale_revision",
  );
  assert.equal(play(m, "human", { kind: "play", cards: ["3", "3"] }), "");
  assert.equal(
    play(m, "agent", { kind: "play", cards: ["6"] }),
    "play_too_small",
  );
  assert.equal(play(m, "agent", { kind: "pass" }), "");
  assert.equal(play(m, "agent2", { kind: "pass" }), "");
  assert.equal(m.observe("human").target, null);
  assert.equal(m.observe("human").turn, "human");
  assert.equal(play(m, "human", { kind: "pass" }), "cannot_pass");
});
test("team wins, zero-sum bomb and spring scoring, revealed hands", () => {
  const m = fixture("3 3 3 3", "4", "5");
  play(m, "human", { kind: "bid", score: 3 });
  assert.equal(play(m, "human", { kind: "play", cards: c("3 3 3 3") }), "");
  const result = m.observe("human").result as unknown as {
    spring: string;
    multiplier: number;
    scores: Record<Actor, number>;
  };
  assert.equal(result.spring, "spring");
  assert.equal(result.multiplier, 4);
  assert.deepEqual(result.scores, { human: 24, agent: -12, agent2: -12 });
  assert.equal(
    (m.observe("agent").seats as unknown as { cards?: Rank[] }[]).filter(
      (s) => s.cards,
    ).length,
    3,
  );
  assert.equal(m.observe("agent2").outcome, "loss");
  const n = fixture("3 4", "5", "6");
  play(n, "human", { kind: "bid", score: 2 });
  play(n, "agent", { kind: "bid", score: 0 });
  play(n, "agent2", { kind: "bid", score: 0 });
  play(n, "human", { kind: "play", cards: ["3"] });
  play(n, "agent", { kind: "play", cards: ["5"] });
  assert.equal(n.phase, "finished");
  assert.equal(n.observe("agent2").outcome, "win", "other farmer also wins");
  assert.equal(n.observe("human").outcome, "loss");
  assert.deepEqual((n.observe("human").result as any).scores, {
    human: -8,
    agent: 4,
    agent2: 4,
  });
  assert.equal((n.observe("human").result as any).spring, "reverse_spring");
  assert.equal(
    play(n, "agent2", { kind: "play", cards: ["6"] }),
    "phase_locked",
  );
});
test("candidate generator only uses owned cards; random complete games terminate and conserve cards/scores", () => {
  for (let seed = 0; seed < 40; seed++) {
    const m = new DoudizhuMatch(`random-${seed}`, { seed: BigInt(seed) });
    for (let safety = 0; safety < 200 && m.phase !== "finished"; safety++) {
      const visible = m.observe("human"),
        turn = visible.turn as Actor,
        o = m.observe(turn);
      for (const proposal of legalPlays(
        cards(m, turn),
        (o.target as any)?.pattern ?? null,
      )) {
        assert.ok(classify(proposal));
        const remaining = [...cards(m, turn)];
        for (const rank of proposal) {
          const i = remaining.indexOf(rank);
          assert.ok(i >= 0);
          remaining.splice(i, 1);
        }
      }
      assert.equal(play(m, turn, chooseAction(o)), "");
      const publicCards = (
        m.observe("human").history as unknown as { cards: Rank[] }[]
      ).flatMap((p) => p.cards);
      if (m.phase !== "bidding")
        assert.equal(
          publicCards.length + SEATS.flatMap((s) => cards(m, s)).length,
          54,
        );
    }
    assert.equal(m.phase, "finished");
    assert.equal(
      Object.values(
        (m.observe("human").result as any).scores as Record<string, number>,
      ).reduce((a, b) => a + b, 0),
      0,
    );
  }
});
test("ordinary scoring, rocket over bomb and reverse spring count actual plays", () => {
  const m = fixture("3 7 9", "4 6", "5 8");
  play(m, "human", { kind: "bid", score: 3 });
  for (const [actor, card] of [
    ["human", "3"],
    ["agent", "4"],
    ["agent2", "5"],
    ["human", "7"],
  ] as [Actor, Rank][])
    assert.equal(play(m, actor, { kind: "play", cards: [card] }), "");
  play(m, "agent", { kind: "pass" });
  play(m, "agent2", { kind: "pass" });
  play(m, "human", { kind: "play", cards: ["9"] });
  assert.equal((m.observe("human").result as any).spring, null);
  assert.deepEqual((m.observe("human").result as any).scores, {
    human: 6,
    agent: -3,
    agent2: -3,
  });
  const n = fixture("2 2 2 2 3", "小王 大王 4", "5");
  play(n, "human", { kind: "bid", score: 3 });
  play(n, "human", { kind: "play", cards: c("2 2 2 2") });
  assert.equal(play(n, "agent", { kind: "play", cards: c("小王 大王") }), "");
  play(n, "agent2", { kind: "pass" });
  play(n, "human", { kind: "pass" });
  play(n, "agent", { kind: "play", cards: ["4"] });
  assert.deepEqual((n.observe("human").result as any).scores, {
    human: -48,
    agent: 24,
    agent2: 24,
  });
  assert.equal((n.observe("human").result as any).multiplier, 8);
});
