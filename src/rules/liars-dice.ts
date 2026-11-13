import { randomBytes } from "node:crypto";
import {
  clone,
  type Action,
  type DuelActor as Actor,
  type GameDefinition,
  type GameMatch,
  type Observation,
} from "../sdk.js";
import { RandomStream } from "./random.js";

export type DiceMode = "wild" | "straight";
export interface DiceBid {
  quantity: number;
  face: number;
  mode: DiceMode;
  actor: Actor;
}
export interface BidRange {
  face: number;
  mode: DiceMode;
  minimum: number;
  maximum: number;
}
export interface DiceReroll {
  actor: Actor;
  dice: number[];
}
export interface DiceRoundRecord {
  roundNumber: number;
  starter: Actor;
  bid: DiceBid;
  challenger: Actor;
  winner: Actor;
  actual: number;
  counts: Record<Actor, number>;
  humanDice: number[];
  agentDice: number[];
  bids: DiceBid[];
  rerolls: DiceReroll[];
}
export interface DiceSeat {
  dice: (number | null)[];
  score: number;
}
const other = (actor: Actor): Actor => (actor === "human" ? "agent" : "human");

/** Public counting rules. A pure five-of-a-kind takes priority over a wild combination. */
export function countDice(
  dice: readonly number[],
  face: number,
  mode: DiceMode,
): number {
  if (dice.every((d) => d === face)) return 7;
  if (mode === "wild" && face !== 1 && dice.every((d) => d === face || d === 1))
    return 6;
  return dice.filter(
    (d) => d === face || (mode === "wild" && face !== 1 && d === 1),
  ).length;
}

export class LiarsDiceMatch implements GameMatch {
  readonly matchId: string;
  revision = 1;
  roundNumber = 1;
  phase: "bidding" | "round_result" | "finished" = "bidding";
  turn: Actor;
  #starter: Actor;
  #rng: RandomStream;
  #fixtures: number[][];
  #dice: Record<Actor, number[]> = { human: [], agent: [] };
  #score: Record<Actor, number> = { human: 0, agent: 0 };
  #bids: DiceBid[] = [];
  #rerolls: DiceReroll[] = [];
  #history: DiceRoundRecord[] = [];
  /** Deterministic fixtures are library-only; no Remote or Agent tool accepts them. */
  constructor(
    matchId: string,
    test?: { seed?: bigint; starter?: Actor; rolls?: number[][] },
  ) {
    this.matchId = matchId;
    this.#rng = new RandomStream(
      test?.seed ?? randomBytes(8).readBigUInt64LE(),
    );
    this.#fixtures = clone(test?.rolls ?? []);
    this.#starter = test?.starter ?? (this.#rng.nextInt(2) ? "agent" : "human");
    this.turn = this.#starter;
    this.#roll();
  }
  #roll() {
    this.#rerolls = [];
    for (const actor of ["human", "agent"] as const) {
      for (;;) {
        const dice =
          this.#fixtures.shift() ??
          Array.from({ length: 5 }, () => this.#rng.nextInt(6) + 1);
        if (
          dice.length !== 5 ||
          dice.some((d) => !Number.isInteger(d) || d < 1 || d > 6)
        )
          throw new Error("dice_fixture");
        if (new Set(dice).size === 5)
          this.#rerolls.push({ actor, dice: [...dice] });
        else {
          this.#dice[actor] = [...dice];
          break;
        }
      }
    }
  }
  #ranges(): BidRange[] {
    const previous = this.#bids.at(-1),
      ranges: BidRange[] = [];
    for (const mode of ["wild", "straight"] as const) {
      for (let face = mode === "wild" ? 2 : 1; face <= 6; face++) {
        const minimum = !previous
          ? mode === "wild"
            ? 3
            : 2
          : previous.mode === "straight" && mode === "wild"
            ? previous.quantity * 2
            : previous.quantity + (face > previous.face ? 0 : 1);
        if (minimum <= 14) ranges.push({ face, mode, minimum, maximum: 14 });
      }
    }
    return ranges;
  }
  apply(actor: Actor, expectedRevision: number, action: Action): string {
    if (expectedRevision !== this.revision) return "stale_revision";
    if (this.phase !== "bidding") return "phase";
    if (actor !== this.turn) return "not_your_turn";
    if (action.kind === "bid") {
      const { quantity, face } = action;
      // Calling ones is always straight, even if a caller supplied the normal-mode label.
      const mode = face === 1 ? "straight" : action.mode;
      if (
        !Number.isInteger(quantity) ||
        !Number.isInteger(face) ||
        (mode !== "wild" && mode !== "straight")
      )
        return "bid_range";
      const range = this.#ranges().find(
        (r) => r.face === face && r.mode === mode,
      );
      if (
        !range ||
        Number(quantity) < range.minimum ||
        Number(quantity) > range.maximum
      )
        return "bid_range";
      this.#bids.push({
        actor,
        quantity: Number(quantity),
        face: Number(face),
        mode,
      });
      this.turn = other(actor);
    } else if (action.kind === "challenge") {
      const bid = this.#bids.at(-1);
      if (!bid) return "nothing_to_challenge";
      const counts = {
        human: countDice(this.#dice.human, bid.face, bid.mode),
        agent: countDice(this.#dice.agent, bid.face, bid.mode),
      };
      const actual = counts.human + counts.agent,
        winner = actual >= bid.quantity ? bid.actor : actor;
      this.#score[winner]++;
      this.#history.push(
        clone({
          roundNumber: this.roundNumber,
          starter: this.#starter,
          bid,
          challenger: actor,
          winner,
          actual,
          counts,
          humanDice: this.#dice.human,
          agentDice: this.#dice.agent,
          bids: this.#bids,
          rerolls: this.#rerolls,
        }),
      );
      this.phase = this.#score[winner] === 3 ? "finished" : "round_result";
    } else return "illegal_action";
    this.revision++;
    return "";
  }
  nextHand(): string {
    if (this.phase !== "round_result") return "phase";
    this.#starter = other(this.#history.at(-1)!.winner);
    this.turn = this.#starter;
    this.roundNumber++;
    this.#bids = [];
    this.#roll();
    this.phase = "bidding";
    this.revision++;
    return "";
  }
  observe(viewer: Actor): Observation {
    const revealed = this.phase !== "bidding";
    return clone({
      matchId: this.matchId,
      revision: this.revision,
      phase: this.phase,
      outcome:
        this.phase === "finished"
          ? this.#score[viewer] === 3
            ? "win"
            : "loss"
          : "ongoing",
      roundNumber: this.roundNumber,
      targetWins: 3,
      maximumRounds: 5,
      turn: this.turn,
      starter: this.#starter,
      score: this.#score,
      self: { dice: this.#dice[viewer], score: this.#score[viewer] },
      opponent: {
        dice: revealed
          ? this.#dice[other(viewer)]
          : [null, null, null, null, null],
        score: this.#score[other(viewer)],
      },
      bid: this.#bids.at(-1) ?? null,
      mode: this.#bids.at(-1)?.mode ?? "wild",
      bids: this.#bids,
      rerolls: this.#rerolls,
      history: this.#history,
      result: revealed ? this.#history.at(-1)! : null,
      actions:
        this.phase === "bidding" && this.turn === viewer
          ? [
              ...(this.#ranges().length
                ? [{ kind: "bid", options: this.#ranges() }]
                : []),
              ...(this.#bids.length ? [{ kind: "challenge" }] : []),
            ]
          : [],
    }) as unknown as Observation;
  }
}

export const diceRules = `双人吹牛骰 · 规则 1.0.0
五局三胜，每局双方各5颗六面骰，胜者得1分，先到3分立即结束。首局随机首叫，之后败方首叫；人类控制下一局和再来一场。
双方只看自己的有效骰子。五颗点数互不相同是散骰，公开弃用骰面后自动重摇。
叫点表示全场至少有N个D点。普通首叫至少3个，斋首叫至少2个。普通模式1可代替2至6任意点数；叫1自动为斋。斋模式1只算1。
数量优先：数量增加时可降低点数，数量相同必须提高点数；改叫斋也不能重复相同数量与点数。斋后可继续叫斋，或叫飞恢复普通；叫飞数量至少翻倍，点数只能2至6。数量最多14。
普通模式五颗全为所叫点数或1，混有万能1的围骰算6个；五颗实际全为所叫点数的全围算7个，斋时仍算7个。全1普通叫其他点数算6个，叫1斋算7个。其他情况按符合条件的实际颗数计数。
只有轮到自己且已有叫点才能开盅质疑。双方揭骰后，有效数量大于或等于叫点数量，叫点者胜；否则质疑者胜。每局均重新使用5颗骰子，不扣骰，无平局，无连开、劈、投降或惩罚倍数。
行动：bid包含quantity、face及mode（wild或straight）；challenge无其他参数。以actions中的点数、模式及数量范围为准。聊天是公开发言，不改变骰面或胜负。`;

const compactRecord = (r: DiceRoundRecord) => ({
  roundNumber: r.roundNumber,
  bid: r.bid,
  challenger: r.challenger,
  actual: r.actual,
  winner: r.winner,
});
export const liarsDice: GameDefinition = {
  apiVersion: 1,
  id: "liars_dice",
  name: "双人吹牛骰",
  version: "1.0.0",
  rulesVersion: "1.0.0",
  rules: diceRules,
  create: (id) => new LiarsDiceMatch(id),
  projectAgentContext(visible) {
    const history = (visible.history as unknown as DiceRoundRecord[]).map(
      compactRecord,
    );
    return {
      observation: {
        ...visible,
        history,
        result: visible.result
          ? compactRecord(visible.result as unknown as DiceRoundRecord)
          : null,
      } as unknown as Observation,
      summary: {
        rounds: visible.roundNumber,
        score: visible.score,
        outcome: visible.outcome,
      },
    };
  },
};
