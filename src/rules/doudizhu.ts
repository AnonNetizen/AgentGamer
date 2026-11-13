import { randomBytes } from "node:crypto";
import {
  clone,
  type Actor,
  type Action,
  type GameDefinition,
  type GameMatch,
  type Observation,
} from "../sdk.js";
import { RandomStream } from "./random.js";
import {
  RANKS,
  beats,
  classify,
  legalPlays,
  sortCards,
  type Pattern,
  type Rank,
} from "./doudizhu-cards.js";

export const SEATS: Actor[] = ["human", "agent", "agent2"];
const nextSeat = (seat: Actor) => SEATS[(SEATS.indexOf(seat) + 1) % 3];
export interface PublicPlay {
  seat: Actor;
  cards: Rank[];
  pattern: Pattern | null;
  pass: boolean;
  trick: number;
}
export interface DoudizhuResult {
  winner: Actor;
  team: "landlord" | "farmers";
  base: number;
  bombs: number;
  spring: "spring" | "reverse_spring" | null;
  multiplier: number;
  scores: Record<Actor, number>;
}
export class DoudizhuMatch implements GameMatch {
  readonly matchId: string;
  revision = 1;
  phase: "bidding" | "redeal" | "playing" | "finished" = "bidding";
  #rng: RandomStream;
  #hands: Record<Actor, Rank[]> = { human: [], agent: [], agent2: [] };
  #bottom: Rank[] = [];
  #starter: Actor;
  #turn: Actor;
  #landlord: Actor | null = null;
  #highest = 0;
  #bids: { seat: Actor; score: number }[] = [];
  #history: PublicPlay[] = [];
  #target: { seat: Actor; cards: Rank[]; pattern: Pattern } | null = null;
  #passes = 0;
  #trick = 1;
  #dealNumber = 1;
  #bombs = 0;
  #played: Record<Actor, number> = { human: 0, agent: 0, agent2: 0 };
  #result: DoudizhuResult | null = null;
  /** Fixtures are library-only; the plugin never accepts a deck, seed or hand over Remote. */
  constructor(
    id: string,
    test?: {
      seed?: bigint;
      starter?: Actor;
      hands?: Record<Actor, Rank[]>;
      bottom?: Rank[];
    },
  ) {
    this.matchId = id;
    this.#rng = new RandomStream(
      test?.seed ?? randomBytes(8).readBigUInt64LE(),
    );
    this.#starter = test?.starter ?? SEATS[this.#rng.nextInt(3)];
    this.#turn = this.#starter;
    this.#deal();
    if (test?.hands) {
      this.#hands = clone(test.hands);
      this.#bottom = clone(test.bottom ?? []);
      const all = [...Object.values(this.#hands).flat(), ...this.#bottom];
      if (
        all.some((r) => !RANKS.includes(r)) ||
        RANKS.some(
          (r, i) => all.filter((c) => c === r).length > (i >= 13 ? 1 : 4),
        )
      )
        throw Error("fixture_cards");
    }
  }
  #deal() {
    const deck: Rank[] = RANKS.flatMap((r, i) =>
      Array(i >= 13 ? 1 : 4).fill(r),
    );
    for (let i = deck.length - 1; i > 0; i--) {
      const j = this.#rng.nextInt(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    for (let s = 0; s < 3; s++)
      this.#hands[SEATS[s]] = sortCards(deck.slice(s * 17, (s + 1) * 17));
    this.#bottom = deck.slice(51);
  }
  apply(actor: Actor, expectedRevision: number, action: Action): string {
    if (expectedRevision !== this.revision) return "stale_revision";
    if (this.phase !== "bidding" && this.phase !== "playing")
      return "phase_locked";
    if (actor !== this.#turn) return "not_your_turn";
    if (this.phase === "bidding") {
      const score = action.score;
      if (
        action.kind !== "bid" ||
        typeof score !== "number" ||
        !Number.isInteger(score) ||
        score < 0 ||
        score > 3 ||
        (score !== 0 && score <= this.#highest)
      )
        return "bid_score";
      this.#bids.push({ seat: actor, score });
      if (score > 0) {
        this.#highest = score;
        this.#landlord = actor;
      }
      if (score === 3 || this.#bids.length === 3) {
        if (!this.#landlord) this.phase = "redeal";
        else {
          this.#hands[this.#landlord] = sortCards([
            ...this.#hands[this.#landlord],
            ...this.#bottom,
          ]);
          this.#turn = this.#landlord;
          this.phase = "playing";
        }
      } else this.#turn = nextSeat(actor);
    } else if (action.kind === "pass") {
      if (!this.#target || this.#target.seat === actor) return "cannot_pass";
      if (++this.#passes === 2) {
        this.#turn = this.#target.seat;
        this.#target = null;
        this.#passes = 0;
        this.#trick++;
      } else this.#turn = nextSeat(actor);
      this.#history.push({
        seat: actor,
        cards: [],
        pattern: null,
        pass: true,
        trick: this.#trick - (this.#target ? 0 : 1),
      });
    } else if (action.kind === "play") {
      if (
        !Array.isArray(action.cards) ||
        action.cards.some((c) => typeof c !== "string")
      )
        return "play_cards";
      const cards = action.cards as string[],
        pattern = classify(cards);
      if (!pattern) return "play_pattern";
      if (!beats(pattern, this.#target?.pattern ?? null))
        return "play_too_small";
      const remaining = [...this.#hands[actor]];
      for (const card of cards) {
        const index = remaining.indexOf(card as Rank);
        if (index === -1) return "cards_not_owned";
        remaining.splice(index, 1);
      }
      this.#hands[actor] = remaining;
      this.#target = { seat: actor, cards: sortCards(cards), pattern };
      this.#history.push({
        ...clone(this.#target),
        pass: false,
        trick: this.#trick,
      });
      this.#played[actor]++;
      if (pattern.kind === "bomb" || pattern.kind === "rocket") this.#bombs++;
      this.#passes = 0;
      if (!remaining.length) this.#finish(actor);
      else this.#turn = nextSeat(actor);
    } else return "action_kind";
    this.revision++;
    return "";
  }
  #finish(winner: Actor) {
    const landlord = this.#landlord!,
      landlordWon = winner === landlord;
    const spring =
      landlordWon &&
      SEATS.filter((s) => s !== landlord).every((s) => this.#played[s] === 0)
        ? "spring"
        : !landlordWon && this.#played[landlord] === 1
          ? "reverse_spring"
          : null;
    const multiplier = 2 ** (this.#bombs + (spring ? 1 : 0)),
      unit = this.#highest * multiplier;
    const scores = Object.fromEntries(
      SEATS.map((s) => [
        s,
        s === landlord
          ? (landlordWon ? 2 : -2) * unit
          : (landlordWon ? -1 : 1) * unit,
      ]),
    ) as Record<Actor, number>;
    this.#result = {
      winner,
      team: landlordWon ? "landlord" : "farmers",
      base: this.#highest,
      bombs: this.#bombs,
      spring,
      multiplier,
      scores,
    };
    this.phase = "finished";
  }
  nextHand(): string {
    if (this.phase !== "redeal") return "phase_locked";
    this.#deal();
    this.#dealNumber++;
    this.#starter = nextSeat(this.#starter);
    this.#turn = this.#starter;
    this.#bids = [];
    this.#highest = 0;
    this.#landlord = null;
    this.phase = "bidding";
    this.revision++;
    return "";
  }
  observe(viewer: Actor): Observation {
    const own = this.#hands[viewer],
      revealed = this.phase === "finished";
    const role = (s: Actor) =>
      this.#landlord === null
        ? "unknown"
        : s === this.#landlord
          ? "landlord"
          : "farmer";
    const actions: Action[] = [];
    if (this.#turn === viewer) {
      if (this.phase === "bidding")
        actions.push({
          kind: "bid",
          scores: [0, 1, 2, 3].filter((s) => s === 0 || s > this.#highest),
        });
      else if (this.phase === "playing") {
        const options = legalPlays(own, this.#target?.pattern ?? null);
        if (options.length)
          actions.push({
            kind: "play",
            suggestions: options.slice(0, 24),
            otherLegalCombinations: true,
          });
        if (this.#target) actions.push({ kind: "pass" });
      }
    }
    return clone({
      matchId: this.matchId,
      revision: this.revision,
      phase: this.phase,
      outcome: revealed
        ? this.#result!.scores[viewer] > 0
          ? "win"
          : "loss"
        : "ongoing",
      viewer,
      turn: this.#turn,
      landlord: this.#landlord,
      base: this.#highest,
      dealNumber: this.#dealNumber,
      trick: this.#trick,
      bids: this.#bids,
      bottom: this.#landlord ? this.#bottom : [],
      self: { seat: viewer, role: role(viewer), cards: own, count: own.length },
      seats: SEATS.map((seat) => ({
        seat,
        role: role(seat),
        count: this.#hands[seat].length,
        ...(seat === viewer || revealed ? { cards: this.#hands[seat] } : {}),
      })),
      target: this.#target,
      history: this.#history,
      bombs: this.#bombs,
      result: this.#result,
      actions,
    }) as unknown as Observation;
  }
}
export const DOUDIZHU_RULES = `斗地主 · 规则 1.0.0
一名玩家对阵两个独立模型对手。叫分选地主，单局结算，支持炸弹、王炸和春天。
三人单局：human是玩家，agent是对手1，agent2是对手2。你只控制唤醒seat指明的自己的席位。农民共同胜负，但不能读取或假设队友手牌。
54张牌，每人17张、底牌3张；3<4<5<6<7<8<9<10<J<Q<K<A<2<小王<大王，花色无大小。随机首叫，human→agent→agent2循环；每人叫一次0(不叫)或超过最高分的1/2/3，3立即定地主。全不叫由玩家点重新发牌。地主获得并公开底牌、先出；任一农民先出完两农民共同胜。
bid格式{kind:"bid",score:N}；play格式{kind:"play",cards:["3","3"]}；pass格式{kind:"pass"}。actions的suggestions仅为合法示例，可自行组成其他合法牌；不能指定其他席位。无合法行动时结束回合。
单张、对子、三张、三带一、三带一对、至少5张顺子、至少3对连对、至少2组三张飞机(不带/带等量单牌/带等量对子)、四带二单牌、四带两对、炸弹、王炸。顺/连对/飞机主体不含2和王。飞机单翼点数各异、对翼为不同点数对子，翅膀不与主体同点。大小王可分别作单翼。四带二单牌允许对子，四带两对须不同点数；四带二不是炸弹。
相同牌型和张数按主体点数比较；炸弹压普通牌，王炸最大。连续两家不出，由最后出牌者重新领出；领出不得不出。
基础分为地主叫分，每个打出的炸弹/王炸倍率×2；地主胜且农民均未出牌为春天，农民胜且地主仅出一次牌为反春天，再×2。地主±2单位、每农民∓1单位，单位=基础分×倍率。结算后公开剩余手牌。聊天面向全桌，不泄露自己的未打出手牌，也不冒充其他席位发言。`;
export const doudizhu: GameDefinition = {
  apiVersion: 1,
  id: "doudizhu",
  name: "斗地主",
  version: "1.0.0",
  rulesVersion: "1.0.0",
  agentSeats: 2,
  rules: DOUDIZHU_RULES,
  create: (id) => new DoudizhuMatch(id),
  projectAgentContext(visible) {
    const history = visible.history as unknown as PublicPlay[];
    const played = SEATS.map((seat) => ({
      seat,
      cards: sortCards(
        history.filter((p) => p.seat === seat).flatMap((p) => p.cards),
      ),
    }));
    return {
      observation: {
        ...visible,
        history:
          visible.history instanceof Array ? visible.history.slice(-9) : [],
        played,
      },
      summary: {
        landlord: visible.landlord,
        base: visible.base,
        outcome: visible.outcome,
        result: visible.result,
      },
    };
  },
};
