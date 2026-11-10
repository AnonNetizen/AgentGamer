import React, { useEffect, useRef, useState } from "react";
import type { GameHistoryProps, GameViewProps } from "./sdk.js";
import type {
  BidRange,
  DiceBid,
  DiceMode,
  DiceReroll,
  DiceRoundRecord,
  DiceSeat,
} from "./rules/liars-dice.js";

export const bidText = (bid: DiceBid) =>
  `${bid.quantity} 个 ${bid.face}${bid.mode === "straight" ? " · 斋" : " · 普通"}`;
const pips: Record<number, number[][]> = {
  1: [[30, 30]],
  2: [
    [16, 16],
    [44, 44],
  ],
  3: [
    [16, 16],
    [30, 30],
    [44, 44],
  ],
  4: [
    [16, 16],
    [44, 16],
    [16, 44],
    [44, 44],
  ],
  5: [
    [16, 16],
    [44, 16],
    [30, 30],
    [16, 44],
    [44, 44],
  ],
  6: [
    [16, 15],
    [44, 15],
    [16, 30],
    [44, 30],
    [16, 45],
    [44, 45],
  ],
};
function Die({
  value,
  reduceMotion = true,
}: {
  value: number | null;
  reduceMotion?: boolean;
}) {
  const previous = useRef(value),
    [enter, setEnter] = useState(!reduceMotion),
    [flip, setFlip] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setEnter(false), 200);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (reduceMotion) {
      setEnter(false);
      setFlip(false);
    }
  }, [reduceMotion]);
  useEffect(() => {
    if (previous.current === null && value !== null && !reduceMotion) {
      setFlip(true);
      const timer = setTimeout(() => setFlip(false), 220);
      previous.current = value;
      return () => clearTimeout(timer);
    }
    previous.current = value;
  }, [value, reduceMotion]);
  return (
    <svg
      className={`ag-die ${value === null ? "ag-die-hidden" : ""} ${enter ? "ag-die-enter" : ""} ${flip ? "ag-die-reveal" : ""}`}
      viewBox="0 0 60 60"
      role="img"
      aria-label={value === null ? "未揭示的骰子" : `骰子 ${value} 点`}
    >
      <rect x="2" y="2" width="56" height="56" rx="12" />
      {value === null ? (
        <text x="30" y="38" textAnchor="middle">
          ?
        </text>
      ) : (
        pips[value]?.map(([cx, cy], i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={5}
            className={value === 1 ? "ag-pip-one" : ""}
          />
        ))
      )}
    </svg>
  );
}
export function LiarsDiceView({
  observation: o,
  busy,
  reduceMotion,
  act,
  next,
  rematch,
  leave,
  opponentName = "Agent",
}: GameViewProps) {
  const who = (actor: string) => (actor === "human" ? "玩家" : opponentName);
  const roundKey = `${o.matchId}:${o.roundNumber}`;
  const [key, setKey] = useState(roundKey),
    [draft, setDraft] = useState({
      quantity: "3",
      face: 2,
      mode: "wild" as DiceMode,
    });
  if (key !== roundKey) {
    setKey(roundKey);
    setDraft({ quantity: "3", face: 2, mode: "wild" });
  }
  const human = o.self as unknown as DiceSeat,
    agent = o.opponent as unknown as DiceSeat;
  const options = (o.actions.find((a) => a.kind === "bid")?.options ??
    []) as unknown as BidRange[];
  const selected = options.find(
    (r) => r.face === draft.face && r.mode === draft.mode,
  );
  const quantity = Number(draft.quantity);
  const valid =
    !!selected &&
    draft.quantity !== "" &&
    Number.isInteger(quantity) &&
    quantity >= selected.minimum &&
    quantity <= selected.maximum;
  const canChallenge = o.actions.some((a) => a.kind === "challenge");
  const result = o.result as unknown as DiceRoundRecord | null,
    bid = o.bid as unknown as DiceBid | null;
  const rerolls = o.rerolls as unknown as DiceReroll[];
  const send = () => {
    if (valid && !busy)
      void act({ kind: "bid", quantity, face: draft.face, mode: draft.mode });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key !== "Enter" ||
        e.repeat ||
        e.isComposing ||
        e.keyCode === 229 ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        e.shiftKey ||
        busy ||
        document.querySelector(".ag-modal")
      )
        return;
      if (
        (e.target as HTMLElement)?.closest(
          'input,textarea,select,button,[contenteditable="true"],[role="dialog"],[role="menu"],.ag-chat',
        )
      )
        return;
      if (o.phase === "round_result") {
        e.preventDefault();
        void next();
      } else if (valid) {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [o, busy, draft, valid]);
  const seat = (value: DiceSeat, actor: "human" | "agent") => (
    <section
      className={`ag-dice-seat ag-dice-seat-${actor}`}
      aria-label={`${who(actor)}骰区`}
    >
      <div className="ag-seat-meta">
        <span className="ag-avatar">{actor === "human" ? "你" : "A"}</span>
        <strong>{who(actor)}</strong>
        <svg
          className="ag-dice-cup"
          viewBox="0 0 40 40"
          role="img"
          aria-label={`${who(actor)}骰盅`}
        >
          <path d="M10 7h20l5 26H5z" />
          <path d="M6 33h28M14 12h12" />
        </svg>
        <span className="ag-role">
          {o.phase === "bidding" && o.turn === actor
            ? "正在叫点"
            : `${value.score} 胜`}
        </span>
        <span
          className="ag-dice-wins"
          aria-label={`${who(actor)} ${value.score} 胜`}
        >
          {[0, 1, 2].map((i) => (
            <i key={i} className={i < value.score ? "ag-win-filled" : ""} />
          ))}
        </span>
      </div>
      <div className="ag-dice-row">
        {value.dice.map((die, i) => (
          <Die
            key={`${roundKey}:${actor}:${i}`}
            value={die}
            reduceMotion={reduceMotion}
          />
        ))}
      </div>
      <small>
        {actor === "agent" && o.phase === "bidding"
          ? "骰盅未揭示 · 5 颗"
          : "每局固定 5 颗骰子"}
      </small>
    </section>
  );
  return (
    <div className="ag-dice-game">
      <div className="ag-dice-board">
        <div className="ag-dice-match">
          <span>
            第 <b>{Number(o.roundNumber)}</b> / 5 局
          </span>
          <strong>五局三胜</strong>
          <span>
            玩家 {human.score} : {agent.score} {opponentName}
          </span>
        </div>
        {seat(agent, "agent")}
        <section className="ag-dice-call" aria-live="polite">
          <span
            className={`ag-badge ${o.mode === "straight" ? "ag-straight-badge" : ""}`}
          >
            {o.mode === "straight" ? "斋 · 1 只算 1" : "普通 · 1 作万能点"}
          </span>
          <h2>{bid ? bidText(bid) : "等待首叫"}</h2>
          <p>
            {o.phase === "bidding"
              ? `${who(String(o.turn))}回合${bid ? ` · 上次由${who(bid.actor)}叫点` : ` · ${who(String(o.starter))}先叫`}`
              : result &&
                `${who(result.challenger)}开盅 · 实际有效 ${result.actual} 个，叫点${result.actual >= result.bid.quantity ? "成立" : "不足"}`}
          </p>
        </section>
        {seat(human, "human")}
      </div>
      {result && (
        <section
          className={`ag-dice-result ${result.winner === "human" ? "ag-dice-result-win" : ""}`}
          role="status"
        >
          <div>
            <strong>
              {o.phase === "finished"
                ? o.outcome === "win"
                  ? "本场获胜"
                  : "本场落败"
                : `${who(result.winner)}赢下本局`}
            </strong>
            <p>
              玩家有效 {result.counts.human} 个 + {opponentName} 有效{" "}
              {result.counts.agent} 个 = {result.actual} 个；需要{" "}
              {result.bid.quantity} 个。
            </p>
          </div>
          <b>
            {human.score} : {agent.score}
          </b>
        </section>
      )}
      <section className="ag-controls ag-dice-controls">
        {o.phase === "bidding" ? (
          options.length || canChallenge ? (
            <>
              <div className="ag-dice-inputs">
                <label>
                  数量
                  <input
                    aria-label="叫点数量"
                    type="number"
                    min={selected?.minimum ?? 2}
                    max={14}
                    step={1}
                    value={draft.quantity}
                    disabled={busy || !options.length}
                    onChange={(e) =>
                      setDraft({ ...draft, quantity: e.target.value })
                    }
                  />
                </label>
                <div
                  className="ag-dice-faces"
                  role="group"
                  aria-label="叫点点数"
                >
                  {[1, 2, 3, 4, 5, 6].map((face) => (
                    <button
                      key={face}
                      aria-label={`叫 ${face} 点`}
                      aria-pressed={draft.face === face}
                      disabled={
                        busy ||
                        !options.some(
                          (r) =>
                            r.face === face &&
                            r.mode === (face === 1 ? "straight" : draft.mode),
                        )
                      }
                      onClick={() =>
                        setDraft({
                          ...draft,
                          face,
                          mode: face === 1 ? "straight" : draft.mode,
                        })
                      }
                    >
                      {face}
                    </button>
                  ))}
                </div>
                <div
                  className="ag-dice-modes"
                  role="group"
                  aria-label="叫点模式"
                >
                  <button
                    aria-pressed={draft.mode === "wild"}
                    disabled={busy || !options.some((r) => r.mode === "wild")}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        mode: "wild",
                        face: draft.face === 1 ? 2 : draft.face,
                      })
                    }
                  >
                    {o.mode === "straight" ? "叫飞" : "普通叫点"}
                  </button>
                  <button
                    aria-pressed={draft.mode === "straight"}
                    disabled={
                      busy || !options.some((r) => r.mode === "straight")
                    }
                    onClick={() => setDraft({ ...draft, mode: "straight" })}
                  >
                    叫斋
                  </button>
                </div>
              </div>
              <div className="ag-dice-submit">
                <small>
                  {selected
                    ? `可叫 ${selected.minimum}～${selected.maximum} 个 ${selected.face}${selected.mode === "straight" ? "斋" : ""}`
                    : "此组合不可叫，请调整点数或模式。"}
                </small>
                {options.length > 0 && (
                  <button
                    className="ag-link"
                    disabled={busy}
                    onClick={() => {
                      const r = selected ?? options[0];
                      setDraft({
                        quantity: String(r.minimum),
                        face: r.face,
                        mode: r.mode,
                      });
                    }}
                  >
                    最低合法叫点
                  </button>
                )}
                <button
                  className="ag-primary"
                  disabled={busy || !valid}
                  onClick={send}
                >
                  叫点
                </button>
                <button
                  className="ag-dice-challenge"
                  disabled={busy || !canChallenge}
                  onClick={() => void act({ kind: "challenge" })}
                >
                  开盅（质疑）
                </button>
              </div>
            </>
          ) : (
            <div className="ag-wait">
              <span className="ag-wait-dot" />
              等待 {opponentName} · 可以继续聊天
            </div>
          )
        ) : o.phase === "round_result" ? (
          <button
            className="ag-primary"
            disabled={busy}
            onClick={() => void next()}
          >
            下一局
          </button>
        ) : (
          <div className="ag-dice-end">
            <button
              className="ag-primary"
              disabled={busy}
              onClick={() => void rematch()}
            >
              再来一场
            </button>
            <button disabled={busy} onClick={() => void leave()}>
              返回大厅
            </button>
          </div>
        )}
      </section>
      <div className="ag-dice-public">
        <details>
          <summary>
            本局叫点记录（{(o.bids as unknown as DiceBid[]).length}）
          </summary>
          <ol>
            {(o.bids as unknown as DiceBid[]).map((b, i) => (
              <li key={i}>
                {who(b.actor)} · {bidText(b)}
              </li>
            ))}
          </ol>
        </details>
        {rerolls.length > 0 && (
          <details>
            <summary>散骰已公开重摇（{rerolls.length}）</summary>
            {rerolls.map((r, i) => (
              <p key={i}>
                {who(r.actor)}弃用：{r.dice.join(" · ")}
              </p>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}

export function DiceHistory({
  observation,
  close,
  opponentName = "Agent",
}: GameHistoryProps) {
  const who = (actor: string) => (actor === "human" ? "玩家" : opponentName);
  const records = (observation.history ?? []) as unknown as DiceRoundRecord[];
  return (
    <aside className="ag-history">
      <div className="ag-modal-title">
        <h2>本场公开记录</h2>
        <button aria-label="关闭记录" onClick={close}>
          ×
        </button>
      </div>
      {!records.length && (
        <p className="ag-hint">开盅后的骰面和结果会显示在这里。</p>
      )}
      {records.map((r) => (
        <article key={r.roundNumber}>
          <strong>
            第 {r.roundNumber} 局 · {who(r.winner)}获胜
          </strong>
          <small>
            {who(r.challenger)}质疑 {bidText(r.bid)}；实际 {r.actual} 个
          </small>
          <p>
            玩家：{r.humanDice.join(" · ")}（有效 {r.counts.human}）<br />
            {opponentName}：{r.agentDice.join(" · ")}（有效 {r.counts.agent}）
          </p>
          <details>
            <summary>叫点过程</summary>
            {r.bids.map((b, i) => (
              <p key={i}>
                {who(b.actor)} · {bidText(b)}
              </p>
            ))}
          </details>
          {r.rerolls.length > 0 && (
            <details>
              <summary>弃用的散骰</summary>
              {r.rerolls.map((d, i) => (
                <p key={i}>
                  {who(d.actor)}：{d.dice.join(" · ")}
                </p>
              ))}
            </details>
          )}
        </article>
      ))}
    </aside>
  );
}
