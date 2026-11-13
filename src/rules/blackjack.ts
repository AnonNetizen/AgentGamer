import { randomBytes } from "node:crypto";
import type {
  DuelActor as Actor,
  Action,
  GameDefinition,
  GameMatch,
  Json,
  Observation,
} from "../sdk.js";
import { RandomStream } from "./random.js";

export interface Card {
  rank: number;
  suit: number;
}
const other = (seat: Actor): Actor => (seat === "human" ? "agent" : "human");
export const label = (c: Card) =>
  (c.rank === 1
    ? "A"
    : c.rank === 11
      ? "J"
      : c.rank === 12
        ? "Q"
        : c.rank === 13
          ? "K"
          : String(c.rank)) + "♠♥♣♦"[c.suit];
export function total(cards: readonly Card[]): number {
  let value = 0,
    aces = 0;
  for (const card of cards) {
    value += card.rank === 1 ? 11 : Math.min(card.rank, 10);
    if (card.rank === 1) aces++;
  }
  while (value > 21 && aces-- > 0) value -= 10;
  return value;
}
export const natural = (cards: readonly Card[]) =>
  cards.length === 2 && total(cards) === 21;
export class BlackjackMatch implements GameMatch {
  readonly matchId: string;
  revision = 1;
  handNumber = 1;
  dealer: Actor;
  phase = "betting";
  bet = 0;
  lastProfit = 0;
  handResult = "";
  finishReason = "";
  #rng: RandomStream;
  #shoe: Card[] = [];
  #drawn = 0;
  #revealed = false;
  #hands: Record<Actor, Card[]> = { human: [], agent: [] };
  #balances = { human: 1000, agent: 1000 };
  #history: Json[] = [];
  /** Deterministic inputs are test-only library construction, never an RPC/tool option. */
  constructor(
    matchId: string,
    test?: { shoe?: Card[]; dealer?: Actor; seed?: bigint },
  ) {
    this.matchId = matchId;
    this.#rng = new RandomStream(
      test?.seed ?? randomBytes(8).readBigUInt64LE(),
    );
    this.dealer =
      test?.dealer ?? (this.#rng.nextInt(2) === 0 ? "human" : "agent");
    if (test?.shoe) this.#shoe = test.shoe.map((c) => ({ ...c }));
    else this.#shuffle();
  }
  get player() {
    return other(this.dealer);
  }
  balance(seat: Actor) {
    return this.#balances[seat];
  }
  get maximumBet() {
    return (
      Math.floor(
        Math.min(
          this.balance(this.player),
          Math.floor((this.balance(this.dealer) * 2) / 3),
        ) / 10,
      ) * 10
    );
  }
  #shuffle() {
    this.#shoe = [];
    this.#drawn = 0;
    for (let copy = 0; copy < 6; copy++)
      for (let suit = 0; suit < 4; suit++)
        for (let rank = 1; rank <= 13; rank++) this.#shoe.push({ rank, suit });
    for (let i = this.#shoe.length - 1; i > 0; i--) {
      const j = this.#rng.nextInt(i + 1);
      [this.#shoe[i], this.#shoe[j]] = [this.#shoe[j], this.#shoe[i]];
    }
  }
  #draw() {
    if (this.#drawn >= this.#shoe.length) throw new Error("shoe_empty");
    return this.#shoe[this.#drawn++];
  }
  apply(actor: Actor, expectedRevision: number, action: Action): string {
    if (expectedRevision !== this.revision) return "stale_revision";
    if (actor !== this.player) return "not_your_turn";
    if (this.phase === "betting" && action.kind === "bet") {
      const amount = action.amount;
      if (
        typeof amount !== "number" ||
        !Number.isSafeInteger(amount) ||
        amount < 10 ||
        amount % 10 !== 0 ||
        amount > this.maximumBet
      )
        return "bet_range";
      this.bet = amount;
      this.#hands[this.player].push(this.#draw());
      this.#hands[this.dealer].push(this.#draw());
      this.#hands[this.player].push(this.#draw());
      this.#hands[this.dealer].push(this.#draw());
      const playerNatural = natural(this.#hands[this.player]),
        up = this.#hands[this.dealer][0];
      if (
        (up.rank === 1 || Math.min(up.rank, 10) === 10) &&
        natural(this.#hands[this.dealer])
      )
        this.#settle(playerNatural ? 0 : -this.bet, "dealer_blackjack");
      else if (playerNatural) this.#settle((this.bet * 3) / 2, "blackjack");
      else this.phase = "playing";
    } else if (this.phase === "playing" && action.kind === "hit") {
      this.#hands[this.player].push(this.#draw());
      const points = total(this.#hands[this.player]);
      if (points > 21) this.#settle(-this.bet, "player_bust");
      else if (points === 21) this.#playDealer();
    } else if (this.phase === "playing" && action.kind === "stand")
      this.#playDealer();
    else return "illegal_action";
    this.revision++;
    return "";
  }
  #playDealer() {
    this.#revealed = true;
    while (total(this.#hands[this.dealer]) < 17)
      this.#hands[this.dealer].push(this.#draw());
    const d = total(this.#hands[this.dealer]),
      p = total(this.#hands[this.player]);
    this.#settle(
      d > 21 || p > d ? this.bet : p < d ? -this.bet : 0,
      d > 21 ? "dealer_bust" : p === d ? "push" : "points",
    );
  }
  #settle(profit: number, reason: string) {
    this.#revealed = true;
    this.#balances[this.player] += profit;
    this.#balances[this.dealer] -= profit;
    this.lastProfit = profit;
    this.handResult = reason;
    this.#history.push({
      handNumber: this.handNumber,
      dealer: this.dealer,
      bet: this.bet,
      playerProfit: profit,
      reason,
      humanCards: this.#hands.human.map(label),
      agentCards: this.#hands.agent.map(label),
    });
    this.phase = this.handNumber === 10 ? "finished" : "hand_result";
    if (this.phase === "finished") this.finishReason = "ten_hands";
  }
  nextHand(): string {
    if (this.phase !== "hand_result") return "phase";
    this.handNumber++;
    this.dealer = other(this.dealer);
    this.bet = 0;
    this.lastProfit = 0;
    this.handResult = "";
    this.#revealed = false;
    this.#hands = { human: [], agent: [] };
    if (this.maximumBet < 10) {
      this.phase = "finished";
      this.finishReason = "insufficient_chips";
    } else {
      if (this.#drawn >= this.#shoe.length * 0.75) this.#shuffle();
      this.phase = "betting";
    }
    this.revision++;
    return "";
  }
  observe(viewer: Actor): Observation {
    const view = (seat: Actor): Json => {
      const hidden =
        seat === this.dealer && !this.#revealed && this.#hands[seat].length > 0;
      return {
        seat,
        role: seat === this.dealer ? "dealer" : "player",
        balance: this.balance(seat),
        cards: this.#hands[seat].map((c, i) =>
          hidden && i > 0 ? null : label(c),
        ),
        total:
          hidden || this.#hands[seat].length === 0
            ? null
            : total(this.#hands[seat]),
      };
    };
    const actions: Action[] = [];
    if (viewer === this.player) {
      if (this.phase === "betting")
        actions.push({
          kind: "bet",
          minimum: 10,
          maximum: this.maximumBet,
          step: 10,
        });
      if (this.phase === "playing")
        actions.push({ kind: "hit" }, { kind: "stand" });
    }
    return {
      matchId: this.matchId,
      revision: this.revision,
      phase: this.phase,
      handNumber: this.handNumber,
      maxHands: 10,
      bet: this.bet,
      dealer: this.dealer,
      self: view(viewer),
      opponent: view(other(viewer)),
      actions,
      outcome:
        this.phase !== "finished"
          ? "ongoing"
          : this.balance(viewer) > this.balance(other(viewer))
            ? "win"
            : this.balance(viewer) < this.balance(other(viewer))
              ? "loss"
              : "draw",
      handResult: this.handResult,
      playerProfit: this.lastProfit,
      finishReason: this.finishReason,
      history: structuredClone(this.#history),
    };
  }
}
export const BLACKJACK_RULES = `21 点 · 规则 1.0.0
双方起始1000筹码，最多10手，首庄随机，每手交换庄闲。最终筹码较高者胜，同额平局。
闲家下注最低10、步长10。上限为闲家余额与庄家可覆盖3:2赔付额度的较小者，向下取整至10的倍数。下一手无法下注10则提前结束。筹码只在双方间转移。
六副标准牌，无大小王；消耗达到75%后下一手洗牌。A取1或11，J/Q/K为10。初始A+10点牌是Blackjack，闲家净赢3:2；普通胜负1:1，和局不转移筹码。
按闲、庄、闲、庄发牌；庄家第二张为暗牌，完整点数对双方隐藏。庄家明牌为A或10点牌时检查Blackjack并立即结算；双方Blackjack和局，闲家Blackjack胜过庄家普通21。
闲家可hit或stand；21自动停牌，爆牌立即输。庄家不足17补牌，所有17（含软17）停牌。没有加倍、分牌、保险、投降或五小龙。
Agent仅在当闲家时选择bet（amount遵守actions范围）、hit、stand。人类控制下一手、再来一场和返回大厅。没有合法行动时结束模型回合，宿主在需要时唤醒。历史只含已结算公开手牌。`;
export const blackjack: GameDefinition = {
  apiVersion: 1,
  id: "blackjack",
  name: "21 点",
  version: "1.0.1",
  rulesVersion: "1.0.0",
  rules: BLACKJACK_RULES,
  create: (id) => new BlackjackMatch(id),
  projectAgentContext(visible) {
    const history = (
      visible.history as unknown as {
        handNumber: number;
        dealer: string;
        bet: number;
        playerProfit: number;
        reason: string;
      }[]
    ).map((h) => ({
      handNumber: h.handNumber,
      dealer: h.dealer,
      bet: h.bet,
      playerProfit: h.playerProfit,
      reason: h.reason,
    }));
    const self = visible.self as { balance: number },
      opponent = visible.opponent as { balance: number };
    return {
      observation: { ...visible, history },
      summary: {
        hands: visible.handNumber,
        selfBalance: self.balance,
        opponentBalance: opponent.balance,
        netChange: self.balance - 1000,
      },
    };
  },
};
