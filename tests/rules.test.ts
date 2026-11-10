import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BlackjackMatch,
  total,
  natural,
  type Card,
} from "../src/rules/blackjack.js";
import { RandomStream } from "../src/rules/random.js";
import type { Actor, Action } from "../src/sdk.js";

test("C# golden traces: 80 complete matches, both projections and RNG vectors", () => {
  const reference = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/blackjack-reference.json.gz", import.meta.url),
      ),
    ).toString("utf8"),
  );
  for (const v of reference.vectors) {
    let rng = new RandomStream(BigInt(v.seed));
    assert.deepEqual(
      v.words,
      Array.from({ length: 16 }, () => rng.nextUInt64().toString()),
    );
    rng = new RandomStream(BigInt(v.seed));
    assert.deepEqual(
      v.integers,
      [1, 2, 3, 10, 312, 2147483647].map((n) => rng.nextInt(n)),
    );
  }
  reference.cases.forEach((c: any, n: number) => {
    const match = new BlackjackMatch(
      `reference-${n}`,
      c.seed ? { seed: BigInt(c.seed) } : { shoe: c.shoe, dealer: c.dealer },
    );
    for (const step of c.trace) {
      const error =
        step.operation === "next"
          ? match.nextHand()
          : step.operation === "act"
            ? match.apply(step.actor, match.revision, step.action)
            : "";
      assert.equal(error, step.error);
      assert.deepEqual(match.observe("human"), step.human);
      assert.deepEqual(match.observe("agent"), step.agent);
      assert.equal(match.balance("human") + match.balance("agent"), 2000);
      assert.ok(match.balance("human") >= 0 && match.balance("agent") >= 0);
    }
  });
});
const cards = (...ranks: number[]): Card[] =>
  ranks.map((rank) => ({ rank, suit: 0 }));
test("aces, blackjack, S17, pushes, boundaries and early finish", () => {
  assert.equal(total(cards(1, 1, 9)), 21);
  assert.equal(total(cards(1, 1, 1, 9)), 12);
  assert.equal(natural(cards(1, 13)), true);
  assert.equal(natural(cards(7, 7, 7)), false);
  const game = (shoe: number[]) =>
    new BlackjackMatch("test", { shoe: cards(...shoe), dealer: "agent" });
  let m = game([1, 10, 13, 1]);
  assert.equal(m.apply("human", 1, { kind: "bet", amount: 660 }), "");
  assert.equal(m.balance("human"), 1000);
  m = game([1, 9, 13, 8, 10, 10, 8, 13, 2, 2, 2, 2, 2, 2, 2, 2]);
  m.apply("human", 1, { kind: "bet", amount: 660 });
  assert.equal(m.balance("human"), 1990);
  assert.equal(m.balance("agent"), 10);
  m.nextHand();
  m.apply("agent", m.revision, { kind: "bet", amount: 10 });
  m.apply("agent", m.revision, { kind: "stand" });
  m.nextHand();
  assert.equal(m.phase, "finished");
  m = game([10, 1, 8, 6, 13]);
  m.apply("human", 1, { kind: "bet", amount: 10 });
  const hidden = m.observe("human");
  assert.equal((hidden.opponent as any).total, null);
  assert.equal((hidden.opponent as any).cards[1], null);
  assert.deepEqual(hidden.history, []);
  m.apply("human", 2, { kind: "stand" });
  assert.equal((m.observe("human").opponent as any).cards.length, 2);
  assert.equal(m.lastProfit, 10);
  m = game([10, 10, 8, 8]);
  assert.equal(m.apply("human", 1, { kind: "bet", amount: 670 }), "bet_range");
  assert.equal(m.apply("human", 1, { kind: "bet", amount: 15 }), "bet_range");
  assert.equal(
    m.apply("agent", 1, { kind: "bet", amount: 10 }),
    "not_your_turn",
  );
  assert.equal(m.revision, 1);
  m.apply("human", 1, { kind: "bet", amount: 10 });
  m.apply("human", 2, { kind: "stand" });
  assert.equal(m.lastProfit, 0);
});
test("75% shoe threshold reshuffles only before next hand", () => {
  const m = new BlackjackMatch("reshuffle", {
    shoe: cards(10, 10, 8, 8),
    dealer: "agent",
    seed: 42n,
  });
  m.apply("human", 1, { kind: "bet", amount: 10 });
  m.apply("human", 2, { kind: "stand" });
  assert.equal(m.phase, "hand_result");
  m.nextHand();
  assert.doesNotThrow(() => m.apply("agent", 4, { kind: "bet", amount: 10 }));
});
