import React, { useEffect, useRef, useState } from "react";
import type { Actor, GameHistoryProps, GameViewProps } from "./sdk.js";
import {
  beats,
  classify,
  PATTERN_NAMES,
  type Pattern,
  type Rank,
} from "./rules/doudizhu-cards.js";
import type { DoudizhuResult, PublicPlay } from "./rules/doudizhu.js";

interface TableSeat {
  seat: Actor;
  role: string;
  count: number;
  cards?: Rank[];
}
interface TableObservation {
  phase: string;
  turn: Actor;
  landlord: Actor | null;
  base: number;
  trick: number;
  dealNumber: number;
  bottom: Rank[];
  self: TableSeat & { cards: Rank[] };
  seats: TableSeat[];
  bids: { seat: Actor; score: number }[];
  history: PublicPlay[];
  target: { seat: Actor; cards: Rank[]; pattern: Pattern } | null;
  result: DoudizhuResult | null;
  bombs: number;
}
const roleName = (role: string) =>
  role === "landlord" ? "地主" : role === "farmer" ? "农民" : "待定";
function RankCard({ rank, small = false }: { rank: Rank; small?: boolean }) {
  return (
    <span
      className={`ag-ddz-card ${small ? "ag-ddz-card-small" : ""} ${rank === "大王" ? "ag-ddz-red" : ""}`}
    >
      <b>{rank}</b>
      <span aria-hidden="true">
        {rank === "大王" || rank === "小王" ? "★" : "♠"}
      </span>
    </span>
  );
}
function Cards({ cards }: { cards: Rank[] }) {
  return (
    <div className="ag-ddz-public-cards">
      {cards.map((rank, i) => (
        <RankCard key={i} rank={rank} small />
      ))}
    </div>
  );
}
export function DoudizhuView({
  observation,
  busy,
  reduceMotion,
  act,
  next,
  rematch,
  leave,
  opponentNames,
}: GameViewProps) {
  const o = observation as unknown as TableObservation;
  const names: Record<Actor, string> = {
    human: "你",
    agent: opponentNames?.agent ?? "对手 1",
    agent2: opponentNames?.agent2 ?? "对手 2",
  };
  const [selected, setSelected] = useState<number[]>([]),
    [hintIndex, setHintIndex] = useState(0);
  const submitting = useRef(false);
  const handKey = o.self.cards.join(","),
    ownTurn = o.turn === "human",
    playing = o.phase === "playing";
  useEffect(() => {
    setSelected([]);
    setHintIndex(0);
  }, [handKey, o.dealNumber]);
  const cards = selected.map((i) => o.self.cards[i]),
    pattern = classify(cards);
  const canPlay =
    playing &&
    ownTurn &&
    !!pattern &&
    beats(pattern, o.target?.pattern ?? null);
  const canPass = observation.actions.some((a) => a.kind === "pass");
  const bidScores = observation.actions.find((a) => a.kind === "bid")
    ?.scores as number[] | undefined;
  const suggestions = (observation.actions.find((a) => a.kind === "play")
    ?.suggestions ?? []) as Rank[][];
  const submit = async (action: Parameters<typeof act>[0]) => {
    if (submitting.current || busy) return;
    submitting.current = true;
    try {
      await act(action);
    } finally {
      submitting.current = false;
    }
  };
  const hint = () => {
    if (!suggestions.length) return;
    const proposal = suggestions[hintIndex % suggestions.length],
      available = [...o.self.cards],
      slots: number[] = [];
    for (const rank of proposal) {
      const i = available.indexOf(rank);
      slots.push(i);
      available[i] = "" as Rank;
    }
    setSelected(slots);
    setHintIndex((i) => i + 1);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key !== "Enter" ||
        e.repeat ||
        e.isComposing ||
        e.keyCode === 229 ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        e.shiftKey
      )
        return;
      const target = e.target as HTMLElement;
      if (
        target.closest(
          'input,textarea,select,button,[contenteditable="true"],[role="dialog"],[role="menu"],.ag-chat,.ag-history',
        ) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (canPlay && !busy) {
        e.preventDefault();
        void submit({ kind: "play", cards });
      } else if (o.phase === "redeal" && !busy) {
        e.preventDefault();
        void next();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [observation.revision, selected, busy]);
  return (
    <section
      className={`ag-ddz ${reduceMotion ? "ag-ddz-static" : ""}`}
      aria-label="斗地主牌桌"
    >
      <div className="ag-ddz-opponents">
        {o.seats
          .filter((s) => s.seat !== "human")
          .map((seat) => {
            const bid = o.bids.find((b) => b.seat === seat.seat),
              last = [...o.history]
                .reverse()
                .find((p) => p.seat === seat.seat && p.trick === o.trick);
            return (
              <section
                className={`ag-ddz-opponent ${o.turn === seat.seat && o.phase !== "finished" ? "ag-ddz-active" : ""}`}
                key={seat.seat}
                aria-label={`${names[seat.seat]}席位`}
              >
                <div className="ag-ddz-seat-heading">
                  <strong>{names[seat.seat]}</strong>
                  <span
                    className={`ag-badge ${seat.role === "landlord" ? "ag-ddz-landlord" : ""}`}
                  >
                    {roleName(seat.role)}
                  </span>
                  <small>剩余 {seat.count} 张</small>
                </div>
                {seat.cards ? (
                  <Cards cards={seat.cards} />
                ) : (
                  <div className="ag-ddz-hidden" aria-label="未公开手牌">
                    <i>♠</i>
                    <span>手牌仅该席位可见</span>
                  </div>
                )}
                <div className="ag-ddz-last-play">
                  {last ? (
                    last.pass ? (
                      <small>不出</small>
                    ) : (
                      <>
                        <small>{PATTERN_NAMES[last.pattern!.kind]}</small>
                        <Cards cards={last.cards} />
                      </>
                    )
                  ) : bid ? (
                    <small>{bid.score ? `叫 ${bid.score} 分` : "不叫"}</small>
                  ) : (
                    <small>
                      {o.turn === seat.seat ? "等待行动" : "等待轮次"}
                    </small>
                  )}
                </div>
              </section>
            );
          })}
      </div>
      <div className="ag-ddz-center" aria-live="polite">
        <div className="ag-ddz-round-meta">
          <span>第 {o.dealNumber} 次发牌 · 单局结算</span>
          <span>
            底分 {o.base || "—"} · 炸弹 {o.bombs}
          </span>
        </div>
        {o.bottom.length > 0 && (
          <div className="ag-ddz-bottom">
            <small>公开底牌</small>
            <Cards cards={o.bottom} />
          </div>
        )}
        {o.phase === "finished" && o.result ? (
          <div className="ag-ddz-result">
            <h2>
              {observation.outcome === "win" ? "你方获胜" : "你方落败"} ·{" "}
              {o.result.team === "landlord" ? "地主胜" : "农民胜"}
            </h2>
            <p>
              {names[o.result.winner]}先出完手牌
              {o.result.spring === "spring"
                ? " · 春天"
                : o.result.spring === "reverse_spring"
                  ? " · 反春天"
                  : ""}{" "}
              · {o.result.base} 底分 × {o.result.multiplier} 倍
            </p>
            <div className="ag-ddz-scores">
              {o.seats.map((s) => (
                <span key={s.seat}>
                  {names[s.seat]}{" "}
                  <b
                    className={
                      o.result!.scores[s.seat] > 0 ? "ag-profit" : "ag-loss"
                    }
                  >
                    {o.result!.scores[s.seat] > 0 ? "+" : ""}
                    {o.result!.scores[s.seat]}
                  </b>
                </span>
              ))}
            </div>
          </div>
        ) : o.phase === "redeal" ? (
          <>
            <h2>本轮全员不叫</h2>
            <p>点击重新发牌，首叫顺延一位。</p>
          </>
        ) : (
          <>
            <h2>
              {o.phase === "bidding"
                ? ownTurn
                  ? "轮到你叫分"
                  : `等待${names[o.turn]}叫分`
                : ownTurn
                  ? o.target
                    ? "轮到你出牌"
                    : "由你领出"
                  : `等待${names[o.turn]}出牌`}
            </h2>
            {playing && o.target && (
              <div className="ag-ddz-target">
                <small>
                  需要压过 {names[o.target.seat]} ·{" "}
                  {PATTERN_NAMES[o.target.pattern.kind]}
                </small>
                <Cards cards={o.target.cards} />
              </div>
            )}
            {playing && !o.target && (
              <p className="ag-hint">
                {o.history.length
                  ? "上轮两家不出，领出任意合法牌型。"
                  : "地主先出，选择任意合法牌型。"}
              </p>
            )}
          </>
        )}
      </div>
      <div
        className={`ag-ddz-human ${ownTurn && o.phase !== "finished" ? "ag-ddz-active" : ""}`}
      >
        <div className="ag-ddz-seat-heading">
          <strong>你的手牌</strong>
          <span className="ag-badge">{roleName(o.self.role)}</span>
          <small>{o.self.count} 张 · 点选组牌</small>
        </div>
        <div className="ag-ddz-hand" role="group" aria-label="选择出牌">
          {o.self.cards.map((rank, i) => (
            <button
              key={i}
              className={`ag-ddz-hand-card ${selected.includes(i) ? "ag-ddz-selected" : ""}`}
              aria-label={`手牌 ${i + 1} ${rank}`}
              aria-pressed={selected.includes(i)}
              disabled={busy || o.phase === "finished"}
              onClick={() =>
                setSelected((v) =>
                  v.includes(i) ? v.filter((n) => n !== i) : [...v, i],
                )
              }
            >
              <RankCard rank={rank} />
            </button>
          ))}
        </div>
      </div>
      <div className="ag-ddz-controls">
        {o.phase === "bidding" ? (
          <>
            <p>
              {ownTurn
                ? "叫分越高，地主底分越高"
                : "你可先整理手牌，等待自己的轮次。"}
            </p>
            <div>
              {[0, 1, 2, 3].map((score) => (
                <button
                  key={score}
                  className={score === 3 ? "ag-primary" : ""}
                  disabled={busy || !bidScores?.includes(score)}
                  onClick={() => void submit({ kind: "bid", score })}
                >
                  {score ? `${score} 分` : "不叫"}
                </button>
              ))}
            </div>
          </>
        ) : playing ? (
          <>
            <p role="status">
              {cards.length
                ? `${cards.length} 张 · ${pattern ? PATTERN_NAMES[pattern.kind] : "未组成合法牌型"}${pattern && !beats(pattern, o.target?.pattern ?? null) ? " · 压不过当前出牌" : ""}`
                : ownTurn && !suggestions.length
                  ? "没有可压过的牌，请选择不出"
                  : "点选手牌，或使用提示选择一组合法牌"}
            </p>
            <div>
              <button
                disabled={busy || !ownTurn || !suggestions.length}
                onClick={hint}
              >
                提示
              </button>
              <button
                disabled={busy || !selected.length}
                onClick={() => setSelected([])}
              >
                清空选择
              </button>
              <button
                disabled={busy || !canPass}
                onClick={() => void submit({ kind: "pass" })}
              >
                不出
              </button>
              <button
                className="ag-primary"
                disabled={busy || !canPlay}
                onClick={() => void submit({ kind: "play", cards })}
              >
                出牌
              </button>
            </div>
          </>
        ) : o.phase === "redeal" ? (
          <button
            className="ag-primary"
            disabled={busy}
            onClick={() => void next()}
          >
            重新发牌
          </button>
        ) : (
          <div>
            <button disabled={busy} onClick={() => void leave()}>
              返回大厅
            </button>
            <button
              className="ag-primary"
              disabled={busy}
              onClick={() => void rematch()}
            >
              再来一局
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
export function DoudizhuHistory({
  observation,
  close,
  opponentNames,
}: GameHistoryProps) {
  const o = observation as unknown as TableObservation;
  const name = (s: Actor) =>
    s === "human"
      ? "你"
      : (opponentNames?.[s] ?? (s === "agent" ? "对手 1" : "对手 2"));
  return (
    <aside className="ag-history">
      <div className="ag-modal-title">
        <h2>本局公开记录</h2>
        <button aria-label="关闭记录" onClick={close}>
          ×
        </button>
      </div>
      {o.bids.map((b, i) => (
        <article key={`bid:${i}`}>
          <strong>{name(b.seat)}</strong>
          <p>{b.score ? `叫 ${b.score} 分` : "不叫"}</p>
        </article>
      ))}
      {o.history.map((p, i) => (
        <article key={`play:${i}`}>
          <strong>
            {name(p.seat)} · 第 {p.trick} 轮
          </strong>
          <small>{p.pass ? "不出" : PATTERN_NAMES[p.pattern!.kind]}</small>
          {!p.pass && <p>{p.cards.join(" · ")}</p>}
        </article>
      ))}
      {!o.bids.length && (
        <p className="ag-hint">叫分和出牌后会显示公开记录。</p>
      )}
    </aside>
  );
}
