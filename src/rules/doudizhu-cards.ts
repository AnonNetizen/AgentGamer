/** Public card algebra only. This module is safe to use in a client; it has no deck or RNG. */
export const RANKS = [
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
  "2",
  "小王",
  "大王",
] as const;
export type Rank = (typeof RANKS)[number];
export interface Pattern {
  kind:
    | "single"
    | "pair"
    | "triple"
    | "triple_single"
    | "triple_pair"
    | "straight"
    | "pair_run"
    | "plane"
    | "plane_single"
    | "plane_pair"
    | "four_single"
    | "four_pair"
    | "bomb"
    | "rocket";
  high: number;
  size: number;
}
export const PATTERN_NAMES: Record<Pattern["kind"], string> = {
  single: "单张",
  pair: "对子",
  triple: "三张",
  triple_single: "三带一",
  triple_pair: "三带一对",
  straight: "顺子",
  pair_run: "连对",
  plane: "飞机",
  plane_single: "飞机带单牌",
  plane_pair: "飞机带对子",
  four_single: "四带二",
  four_pair: "四带两对",
  bomb: "炸弹",
  rocket: "王炸",
};
export const rankIndex = (rank: string) =>
  (RANKS as readonly string[]).indexOf(rank);
export const sortCards = (cards: readonly string[]): Rank[] =>
  [...cards].sort((a, b) => rankIndex(a) - rankIndex(b)) as Rank[];
const consecutive = (ranks: number[]) =>
  ranks.at(-1)! <= 11 && ranks.every((r, i) => !i || r === ranks[i - 1] + 1);
export function classify(cards: readonly string[]): Pattern | null {
  if (!cards.length || cards.length > 20) return null;
  const counts = Array<number>(15).fill(0);
  for (const card of cards) {
    const r = rankIndex(card);
    if (r < 0 || ++counts[r] > (r >= 13 ? 1 : 4)) return null;
  }
  const ranks = counts.flatMap((n, r) => (n ? [r] : [])),
    size = cards.length;
  const result = (kind: Pattern["kind"], high = ranks.at(-1)!): Pattern => ({
    kind,
    high,
    size,
  });
  if (size === 2 && counts[13] === 1 && counts[14] === 1)
    return result("rocket");
  if (ranks.length === 1)
    return result(
      (["", "single", "pair", "triple", "bomb"] as const)[
        size
      ] as Pattern["kind"],
    );
  const triple = counts.indexOf(3),
    four = counts.indexOf(4);
  if (size === 4 && triple >= 0) return result("triple_single", triple);
  if (size === 5 && triple >= 0 && ranks.length === 2)
    return result("triple_pair", triple);
  if (size >= 5 && ranks.length === size && consecutive(ranks))
    return result("straight");
  if (
    size >= 6 &&
    ranks.length * 2 === size &&
    ranks.every((r) => counts[r] === 2) &&
    consecutive(ranks)
  )
    return result("pair_run");
  if (
    size >= 6 &&
    ranks.length * 3 === size &&
    ranks.every((r) => counts[r] === 3) &&
    consecutive(ranks)
  )
    return result("plane");
  if (size === 6 && four >= 0) return result("four_single", four); // the two kickers may form a pair
  if (
    size === 8 &&
    four >= 0 &&
    ranks.length === 3 &&
    ranks.filter((r) => r !== four).every((r) => counts[r] === 2)
  )
    return result("four_pair", four);
  for (const wing of [1, 2]) {
    const length = size / (3 + wing);
    if (!Number.isInteger(length) || length < 2) continue;
    for (let start = 0; start + length <= 12; start++) {
      const body = Array.from({ length }, (_, i) => start + i);
      if (!body.every((r) => counts[r] === 3)) continue;
      const rest = ranks.filter((r) => !body.includes(r));
      if (rest.length === length && rest.every((r) => counts[r] === wing))
        return result(wing === 1 ? "plane_single" : "plane_pair", body.at(-1)!);
    }
  }
  return null;
}
export function beats(candidate: Pattern, target: Pattern | null): boolean {
  if (!target) return true;
  if (target.kind === "rocket") return false;
  if (candidate.kind === "rocket") return true;
  if (candidate.kind === "bomb" && target.kind !== "bomb") return true;
  return (
    candidate.kind === target.kind &&
    candidate.size === target.size &&
    candidate.high > target.high
  );
}
function choose(items: number[], n: number): number[][] {
  const out: number[][] = [];
  const walk = (at: number, selected: number[]) => {
    if (selected.length === n) {
      out.push(selected);
      return;
    }
    for (let i = at; i <= items.length - (n - selected.length); i++)
      walk(i + 1, [...selected, items[i]]);
  };
  walk(0, []);
  return out;
}
/** Host and human hints share these candidates. The validator accepts every legal play, not just suggestions. */
export function legalPlays(
  hand: readonly string[],
  target: Pattern | null,
): Rank[][] {
  const counts = RANKS.map((r) => hand.filter((c) => c === r).length),
    out = new Map<string, Rank[]>();
  const add = (ranks: number[]) => {
    const cards = sortCards(ranks.map((r) => RANKS[r])),
      p = classify(cards);
    if (p && beats(p, target)) out.set(cards.join(","), cards);
  };
  for (let r = 0; r < 15; r++) {
    for (let n = 1; n <= counts[r]; n++) {
      add(Array(n).fill(r));
      if (n === 3)
        for (let k = 0; k < 15; k++)
          if (k !== r) {
            if (counts[k] >= 1) add([r, r, r, k]);
            if (counts[k] >= 2) add([r, r, r, k, k]);
          }
    }
    if (counts[r] === 4) {
      const rest = counts.flatMap((n, i) => (i !== r && n ? [i] : []));
      for (const pair of choose(rest, 2)) add([r, r, r, r, ...pair]);
      for (const k of rest) if (counts[k] >= 2) add([r, r, r, r, k, k]);
      for (const pair of choose(
        rest.filter((i) => counts[i] >= 2),
        2,
      ))
        add([r, r, r, r, ...pair.flatMap((i) => [i, i])]);
    }
  }
  if (counts[13] && counts[14]) add([13, 14]);
  for (const copies of [1, 2, 3])
    for (let start = 0; start < 12; start++)
      for (let end = start; end < 12 && counts[end] >= copies; end++) {
        const length = end - start + 1,
          minimum = copies === 1 ? 5 : copies === 2 ? 3 : 2;
        if (length < minimum || length * copies > hand.length) continue;
        const body = Array.from({ length }, (_, i) => start + i),
          cards = body.flatMap((r) => Array(copies).fill(r));
        add(cards);
        if (copies === 3)
          for (const wing of [1, 2]) {
            if (length * (3 + wing) > hand.length) continue;
            const rest = counts.flatMap((n, r) =>
              !body.includes(r) && n >= wing ? [r] : [],
            );
            for (const chosen of choose(rest, length))
              add([...cards, ...chosen.flatMap((r) => Array(wing).fill(r))]);
          }
      }
  return [...out.values()].sort(
    (a, b) =>
      b.length - a.length ||
      classify(a)!.high - classify(b)!.high ||
      a.join().localeCompare(b.join()),
  );
}
