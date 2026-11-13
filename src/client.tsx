import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Service, type Context } from "@deepseek-ai/cordis";
import { remoteInfo } from "./remote.js";
import {
  EMOJI,
  EMOJI_NAMES,
  type Action,
  type GameViewRegistration,
  type GameViewProps,
  type PlatformSnapshot,
  type Receipt,
  type GameHistoryProps,
} from "./sdk.js";
import styles from "./styles.css";
import { LiarsDiceView, DiceHistory } from "./liars-dice-view.js";
import { DoudizhuView, DoudizhuHistory } from "./doudizhu-view.js";
import { CompanionControls, ReportPanel } from "./companion-panel.js";

interface ClientContext extends Context {
  remote: {
    $mount(info: typeof remoteInfo): Promise<() => void>;
    agentgamer: {
      request(
        operation: string,
        payload: string,
      ): Promise<{ ok: true; value: string } | { ok: false; error: Error }>;
    };
  };
  slots: {
    inject(name: string, setup: () => unknown): () => void;
    register(
      options: Record<string, unknown>,
      component: React.ComponentType<any>,
    ): () => void;
  };
  layout: { selectPanel(id: string | null): void };
  uiWorkspace: { openSession(id: string): void };
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    agentgamerViews: ViewRegistry;
  }
}
export const inject = ["remote", "slots", "layout", "uiWorkspace"];
export const name = "agentgamer-client";
export class ViewRegistry extends Service {
  views = new Map<string, GameViewRegistration>();
  listeners = new Set<() => void>();
  revision = 0;
  constructor(ctx: Context) {
    super(ctx, "agentgamerViews");
  }
  register(view: GameViewRegistration) {
    const key = `${view.id}@${view.version}`;
    if (this.views.has(key)) throw new Error("duplicate_game_view");
    this.views.set(key, view);
    this.notify();
    return () => {
      if (this.views.get(key) === view) {
        this.views.delete(key);
        this.notify();
      }
    };
  }
  notify() {
    this.revision++;
    for (const fn of this.listeners) fn();
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.revision;
}
export class ClientStore {
  snapshot: PlatformSnapshot | null = null;
  error = "";
  draft = "";
  pendingChat: { requestId: string; content: string; kind: string } | null =
    null;
  chatOpen = false;
  chatScroll = 0;
  chatBottom = true;
  catalog: { provider: string; model: string; name: string }[] = [];
  listeners = new Set<() => void>();
  version = 0;
  stopped = false;
  online = false;
  private running = false;
  constructor(
    readonly request: (operation: string, data?: unknown) => Promise<any>,
  ) {}
  notify = () => {
    this.version++;
    for (const fn of this.listeners) fn();
  };
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.version;
  async refresh() {
    this.snapshot = await this.request("snapshot");
    this.notify();
  }
  async start() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.refresh();
      this.catalog = await this.request("catalog");
      this.notify();
      this.online = true;
      const preferences =
        localStorage.getItem("agentgamer.display.v1") ??
        localStorage.getItem("rushagent.display.v1");
      try {
        await this.request(
          "initializePreferences",
          preferences ? JSON.parse(preferences) : this.snapshot!.preferences,
        );
      } catch {
        /* invalid saved preference is ignored */
      }
      while (!this.stopped) {
        const next: PlatformSnapshot = await this.request("wait", {
          cursor: this.snapshot!.cursor,
        });
        if (this.stopped) break;
        this.snapshot = next;
        this.error = "";
        try {
          localStorage.setItem(
            "agentgamer.display.v1",
            JSON.stringify(next.preferences),
          );
        } catch {
          /* apply in memory even if persistence is unavailable */
        }
        this.notify();
      }
    } catch (e) {
      if (!this.stopped) {
        this.online = false;
        this.error = `与插件 Host 的连接已中断：${e instanceof Error ? e.message.slice(0, 180) : "连接失败"}。请重试连接。`;
        this.notify();
      }
    } finally {
      this.running = false;
    }
  }
  async command(operation: string, data?: unknown): Promise<boolean> {
    try {
      const result: Receipt = await this.request(operation, data);
      if (result.accepted === false) throw new Error(result.error);
      this.error = "";
      await this.refresh();
      return true;
    } catch (e) {
      this.error = errorText(e instanceof Error ? e.message : "request_failed");
      this.notify();
      return false;
    }
  }
  async preferences(value: PlatformSnapshot["preferences"]) {
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, preferences: value };
      this.notify();
    }
    if (await this.command("preferences", value)) {
      try {
        localStorage.setItem("agentgamer.display.v1", JSON.stringify(value));
      } catch {
        this.error = "显示已调整，但偏好无法保存到此浏览器。";
        this.notify();
      }
    }
  }
}
const errors: Record<string, string> = {
  model_required: "请先选择并连接模型。",
  model_locked: "比赛期间不能更换模型。",
  busy: "操作正在进行，请稍候。",
  stale_revision: "局面已更新，请根据最新牌桌操作。",
  request_id_reused: "请求编号已使用，请刷新后重试。",
  chat_empty: "请输入消息。",
  chat_too_long: "消息最多 500 个字素。",
  not_your_turn: "现在轮到 Agent。",
  bet_range: "下注金额不在合法范围内。",
  bid_range: "叫点不符合当前数量、点数或斋／飞规则，请查看合法范围。",
  nothing_to_challenge: "尚未有人叫点，不能开盅。",
  match_mismatch: "这场比赛已结束，请查看当前牌桌。",
  agent_paused: "Agent 已暂停。",
  model_unknown: "此模型已不可用，请重新选择。",
  agent_setup: "伙伴连接未完成，请检查接入资料和模型配置后重试。",
  game_start: "比赛未启动，请检查伙伴来源是否在线后重试。",
  second_model_required: "斗地主需要两个独立模型席位，请先连接对手 2。",
  multiplayer_pet_unsupported:
    "斗地主首版只支持普通模型对手，请将对手 1 切换为普通对手并连接。",
  bid_score: "叫分必须为不叫，或高于当前最高分的 1／2／3 分。",
  cannot_pass: "本轮由你领出，需要出一组合法牌。",
  play_pattern: "选中的牌未组成合法牌型。",
  play_too_small: "这组牌无法压过当前出牌。",
  cards_not_owned: "出牌包含当前手中没有的牌，请重新选牌。",
};
const errorText = (value: string) =>
  errors[value] ?? `操作失败（${value.slice(0, 120)}），请重试。`;
const id = () => crypto.randomUUID();
const length = (value: string) =>
  [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(value)]
    .length;
export async function apply(context: Context) {
  const ctx = context as ClientContext;
  await ctx.remote.$mount(remoteInfo);
  await ctx.inject(["remote.agentgamer"], (scope) =>
    mountUI(scope as ClientContext),
  );
}
function mountUI(ctx: ClientContext) {
  const registry = new ViewRegistry(ctx);
  registry.register({
    id: "blackjack",
    version: "1.0.1",
    component: BlackjackView,
    historyComponent: History,
  });
  registry.register({
    id: "liars_dice",
    version: "1.0.0",
    component: LiarsDiceView,
    historyComponent: DiceHistory,
  });
  registry.register({
    id: "doudizhu",
    version: "1.0.0",
    component: DoudizhuView,
    historyComponent: DoudizhuHistory,
  });
  const store = new ClientStore(async (operation, data = {}) => {
    const result = await ctx.remote.agentgamer.request(
      operation,
      JSON.stringify(data),
    );
    if (!result.ok) throw result.error;
    return JSON.parse(result.value);
  });
  ctx.effect(() => {
    const node = document.createElement("style");
    node.textContent = styles;
    document.head.append(node);
    return () => node.remove();
  });
  ctx.effect(() => {
    void store.start();
    return () => {
      store.stopped = true;
    };
  });
  ctx.slots.inject("main", () =>
    ctx.slots.register(
      {
        name: "main",
        key: "agentgamer",
        inject: () => ({
          store,
          registry,
          openSession: (session: string) => {
            ctx.uiWorkspace.openSession(session);
            ctx.layout.selectPanel(null);
          },
        }),
      },
      AgentGamerPanel,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: "agentgamer",
        order: 20,
        label: () => "AgentGamer",
      },
      () => (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <rect
            x="5"
            y="3"
            width="14"
            height="18"
            rx="3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="m12 7 4 5-4 5-4-5z" fill="currentColor" />
        </svg>
      ),
    ),
  );
}

export function AgentGamerPanel({
  store,
  registry,
  openSession,
}: {
  store: ClientStore;
  registry: ViewRegistry;
  openSession(session: string): void;
}) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const s = store.snapshot;
  const [busy, setBusy] = useState(false),
    [modal, setModal] = useState<"settings" | "rules" | "leave" | null>(null),
    [history, setHistory] = useState(false);
  const busyRef = useRef(false);
  const [search, setSearch] = useState(""),
    [model, setModel] = useState("");
  const [rulesGame, setRulesGame] = useState<string | null>(null);
  const [secondModel, setSecondModel] = useState("");
  const [opponentMode, setOpponentMode] = useState<"auto" | "pet" | "default">(
    "auto",
  );
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const trap = (e: KeyboardEvent) => {
      const dialog = document.querySelector(".ag-modal");
      if (!dialog) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setModal(null);
      }
      if (e.key !== "Tab") return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,textarea,[tabindex="0"]',
        ),
      );
      const first = controls[0],
        last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [modal]);
  const command = async (op: string, data?: unknown) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await store.command(op, data);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  if (!s)
    return (
      <div className="ag">
        <div className="ag-empty">
          {store.error || "正在连接 AgentGamer…"}
          {store.error && (
            <button onClick={() => void store.start()}>重试连接</button>
          )}
        </div>
      </div>
    );
  const observation = s.observation,
    view = s.game && registry.views.get(`${s.game.id}@${s.game.version}`);
  const multi = s.game?.agentSeats === 2;
  const second = s.opponents?.find((o) => o.seat === "agent2");
  const opponentNames = Object.fromEntries(
    (s.opponents ?? []).map((o) => [o.seat, o.name]),
  );
  const petMode =
    opponentMode === "auto" ? !!s.companion : opponentMode === "pet";
  const focusIssue =
    !!s.game &&
    s.observation?.phase !== "finished" &&
    ["interrupted", "error"].includes(s.companionFocus?.state ?? "");
  const focusStarting = s.companionFocus?.state === "starting";
  const petMessage =
    focusIssue || focusStarting
      ? s.companionFocus!.message
      : s.companionFocus?.state === "focused"
        ? s.companionFeedback?.state === "error"
          ? `专心陪玩 · ${s.companionFeedback.message}`
          : "专心陪玩中，日常动作已暂停"
        : s.companionFeedback?.message || "等待公开发言或比赛结果";
  const connectOpponent = async (
    companion: import("./sdk.js").CompanionRef | null,
    personaOverride?: string,
  ) => {
    const [provider, chosen] = (
      model || `${s.model?.provider}\0${s.model?.model}`
    ).split("\0");
    await command("configure", {
      provider,
      model: chosen,
      companion,
      ...(personaOverride === undefined ? {} : { personaOverride }),
    });
  };
  const status = {
    unconfigured: "未选择模型",
    idle: "已就绪",
    running: "Agent 回合",
    paused: "已暂停",
    error: "需要处理",
  }[s.agentStatus];
  const gameProps: GameViewProps | null = observation && {
    observation,
    busy,
    reduceMotion: s.preferences.reduceMotion,
    opponentName: s.opponent?.name,
    opponentNames,
    act: async (action) => {
      await command("act", {
        matchId: observation.matchId,
        expectedRevision: observation.revision,
        requestId: id(),
        action,
      });
    },
    next: async () => {
      await command("next", {
        matchId: observation.matchId,
        expectedRevision: observation.revision,
        requestId: id(),
      });
    },
    rematch: async () => {
      await command("start", { gameId: s.game!.id, rematch: true });
    },
    leave: async () => {
      setModal("leave");
    },
  };
  return (
    <div
      className={`ag ${s.preferences.reduceMotion ? "ag-reduced" : ""}`}
      style={{ fontSize: s.preferences.fontPercent === 125 ? 20 : 16 }}
    >
      <header className="ag-header">
        <div className="ag-brand">
          <span className="ag-logo">♠</span>
          <div>
            <strong>AgentGamer</strong>
            <small>
              {s.game
                ? `${s.game.name} · v${s.game.version}`
                : "与 Agent 面对面，玩一局"}
            </small>
          </div>
        </div>
        <div className="ag-header-actions">
          <span
            className={`ag-badge ${s.agentStatus === "error" ? "ag-warning" : ""}`}
          >
            ● {status}
          </span>
          {s.sessionId && (
            <button
              title="查看 DSH 对战会话（含模型输出与工具日志）"
              onClick={() => openSession(s.sessionId!)}
            >
              {multi ? "对手 1 会话 ↗" : "对战会话 ↗"}
            </button>
          )}
          {multi && second?.sessionId && (
            <button onClick={() => openSession(second.sessionId!)}>
              对手 2 会话 ↗
            </button>
          )}
          <button
            aria-expanded={store.chatOpen}
            onClick={() => {
              store.chatOpen = !store.chatOpen;
              store.notify();
            }}
          >
            聊天 {s.unread > 0 && <b className="ag-count">{s.unread}</b>}
          </button>
          <button aria-label="显示设置" onClick={() => setModal("settings")}>
            ⚙
          </button>
        </div>
      </header>
      {(s.error || store.error) && (
        <div className="ag-alert" role="alert">
          <span>{store.error || s.error}</span>
          <button
            disabled={busy}
            onClick={() =>
              store.error && !store.online
                ? void store.start()
                : store.error
                  ? void command("snapshot")
                  : void command("resume")
            }
          >
            重试
          </button>
        </div>
      )}
      <div className={`ag-body ${store.chatOpen ? "ag-with-chat" : ""}`}>
        <main className="ag-main">
          {s.companion && s.companionFeedback && (
            <div
              className={`ag-pet-feedback ${s.game ? "ag-pet-feedback-playing" : ""} ${s.companionFeedback.state === "error" || focusIssue ? "ag-pet-feedback-error" : ""}`}
              role="status"
            >
              <span title={petMessage}>桌宠：{petMessage}</span>
              <button
                disabled={
                  focusStarting ||
                  (!focusIssue && s.companionFeedback.state === "pending")
                }
                onClick={() =>
                  void store
                    .request(
                      focusIssue
                        ? "resumeCompanionFocus"
                        : "testCompanionReaction",
                    )
                    .then(() => store.refresh())
                    .catch(() => store.refresh())
                }
              >
                {focusIssue ? "恢复专心陪玩" : "测试桌宠反应"}
              </button>
            </div>
          )}
          {!s.game ? (
            <div className="ag-lobby">
              <div className="ag-heading">
                <div>
                  <span className="ag-kicker">游戏库</span>
                  <h1>下一局，玩什么？</h1>
                  <p>选择游戏与模型，所有对局都留在 DSH 中。</p>
                </div>
                <span className="ag-library-count">
                  {s.games.length} 款游戏
                </span>
              </div>
              <section className="ag-model">
                <div>
                  <strong>对战模型</strong>
                  <small>复用 DSH 中已配置的模型；一场比赛内固定。</small>
                </div>
                <select
                  aria-label="对战模型"
                  value={
                    model ||
                    (s.model ? `${s.model.provider}\0${s.model.model}` : "")
                  }
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">请选择模型</option>
                  {store.catalog.map((m) => (
                    <option
                      key={`${m.provider}/${m.model}`}
                      value={`${m.provider}\0${m.model}`}
                    >
                      {m.name} · {m.provider}
                    </option>
                  ))}
                </select>
                {!petMode && (
                  <button
                    disabled={busy || !(model || s.model)}
                    onClick={() => void connectOpponent(null)}
                  >
                    {s.sessionId ? "更换 / 重连" : "连接模型"}
                  </button>
                )}
              </section>
              <section className="ag-model ag-second-model">
                <div>
                  <strong>三人游戏 · 对手 2</strong>
                  <small>
                    独立模型、会话与手牌视角，仅斗地主使用。可选与对手 1
                    相同的模型。
                  </small>
                </div>
                <select
                  aria-label="对手 2 模型"
                  value={
                    secondModel ||
                    (second?.model
                      ? `${second.model.provider}\0${second.model.model}`
                      : "")
                  }
                  onChange={(e) => setSecondModel(e.target.value)}
                >
                  <option value="">请选择第二个模型</option>
                  {store.catalog.map((m) => (
                    <option
                      key={`${m.provider}/${m.model}`}
                      value={`${m.provider}\0${m.model}`}
                    >
                      {m.name} · {m.provider}
                    </option>
                  ))}
                </select>
                <button
                  disabled={busy || !(secondModel || second?.model)}
                  onClick={() => {
                    const [provider, model] = (
                      secondModel ||
                      `${second?.model?.provider}\0${second?.model?.model}`
                    ).split("\0");
                    void command("configure", {
                      seat: "agent2",
                      provider,
                      model,
                    });
                  }}
                >
                  {second?.sessionId ? "更换 / 重连对手 2" : "连接对手 2"}
                </button>
                <small className="ag-second-state">
                  {second?.error ||
                    (second?.sessionId
                      ? "✓ 对手 2 已连接"
                      : "尚未连接 · 两人游戏不需要此席位")}
                </small>
              </section>
              <CompanionControls
                store={store}
                petMode={petMode}
                setPetMode={(value) =>
                  setOpponentMode(value ? "pet" : "default")
                }
                busy={busy}
                canConnect={!!(model || s.model)}
                connect={connectOpponent}
              />
              <ReportPanel store={store} />
              {!store.catalog.length && (
                <p className="ag-hint">
                  还没有可用模型。请先在 DSH 设置中配置模型，再
                  <button
                    className="ag-link"
                    onClick={async () => {
                      store.catalog = await store.request("catalog");
                      store.notify();
                    }}
                  >
                    刷新列表
                  </button>
                  。
                </p>
              )}
              <input
                className="ag-search"
                aria-label="搜索游戏"
                placeholder="搜索游戏名称或标识…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="ag-games">
                {s.games
                  .filter((g) =>
                    `${g.name} ${g.id}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((g) => {
                    const ready = registry.views.has(`${g.id}@${g.version}`);
                    const requiresSecond = g.agentSeats === 2;
                    const blocked =
                      requiresSecond && (!second?.sessionId || !!s.companion);
                    return (
                      <article className="ag-game" key={g.id}>
                        <div className="ag-game-art" aria-hidden="true">
                          {g.id === "liars_dice" ? (
                            <>
                              <span>⚄</span>
                              <span>⚂</span>
                            </>
                          ) : (
                            <>
                              <span>♠</span>
                              {g.id === "doudizhu" && <span>♣</span>}
                              <span>♥</span>
                            </>
                          )}
                        </div>
                        <div className="ag-game-title">
                          <h2>{g.name}</h2>
                          <span className="ag-badge">
                            {ready ? "可游玩" : "缺少匹配界面"}
                          </span>
                        </div>
                        <p>
                          v{g.version} · 规则 {g.rulesVersion}
                          {requiresSecond ? " · 三人对局" : ""}
                        </p>
                        <p className="ag-game-description">
                          {g.rules.split("\n")[1] || g.rules.slice(0, 100)}
                        </p>
                        <button
                          className="ag-link"
                          onClick={() => {
                            setRulesGame(g.id);
                            setModal("rules");
                          }}
                        >
                          查看公开规则 ↗
                        </button>
                        <button
                          className="ag-primary"
                          disabled={busy || !s.sessionId || !ready || blocked}
                          title={
                            !s.sessionId
                              ? "请先连接对战模型"
                              : requiresSecond && s.companion
                                ? "请先将对手 1 切换为普通模型对手"
                                : requiresSecond && !second?.sessionId
                                  ? "请连接对手 2"
                                  : !ready
                                    ? "需要相同游戏版本的客户端视图"
                                    : ""
                          }
                          onClick={() =>
                            void command("start", { gameId: g.id })
                          }
                        >
                          {busy
                            ? "正在准备…"
                            : requiresSecond && s.companion
                              ? "请连接普通模型对手"
                              : requiresSecond && !second?.sessionId
                                ? "请先连接对手 2"
                                : s.sessionId
                                  ? "开始比赛"
                                  : "请先连接模型"}
                        </button>
                      </article>
                    );
                  })}
              </div>
              {!s.games.some((g) =>
                `${g.name} ${g.id}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              ) && (
                <div className="ag-empty">
                  {s.games.length ? "没有匹配的游戏" : "还没有注册游戏模块"}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="ag-table-bar">
                <button onClick={() => setModal("leave")}>← 返回大厅</button>
                <div>
                  <button
                    onClick={() => {
                      setRulesGame(s.game!.id);
                      setModal("rules");
                    }}
                  >
                    规则
                  </button>
                  <button
                    aria-pressed={history}
                    onClick={() => setHistory(!history)}
                  >
                    本场记录
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void command(
                        s.agentStatus === "paused" || s.agentStatus === "error"
                          ? "resume"
                          : "pause",
                      )
                    }
                  >
                    {s.agentStatus === "paused" || s.agentStatus === "error"
                      ? "继续 Agent"
                      : "暂停 Agent"}
                  </button>
                </div>
              </div>
              {multi && (
                <div className="ag-opponent-statuses" aria-label="对手会话状态">
                  {s.opponents?.map((o) => (
                    <div key={o.seat}>
                      <span>
                        <strong>{o.name}</strong>
                        <small>
                          {o.model?.model} ·{" "}
                          {
                            {
                              unconfigured: "未连接",
                              idle: "等待轮次",
                              running: "处理中",
                              paused: "已暂停",
                              error: "需要重试",
                            }[o.status]
                          }
                        </small>
                      </span>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void command(
                            o.status === "error" || o.status === "paused"
                              ? "resume"
                              : "pause",
                            { seat: o.seat },
                          )
                        }
                      >
                        {o.status === "error"
                          ? `重试${o.name}`
                          : o.status === "paused"
                            ? `继续${o.name}`
                            : `暂停${o.name}`}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {view && gameProps ? (
                <view.component key={observation!.matchId} {...gameProps} />
              ) : (
                <div className="ag-empty">游戏界面模块已卸载。请返回大厅。</div>
              )}
              {history && observation && (
                <GameHistory
                  component={view?.historyComponent}
                  observation={observation}
                  opponentName={s.opponent?.name}
                  opponentNames={opponentNames}
                  close={() => setHistory(false)}
                />
              )}
              {observation?.phase === "finished" && (
                <ReportPanel store={store} />
              )}
            </>
          )}
        </main>
        {store.chatOpen && (
          <>
            <button
              className="ag-chat-mask"
              aria-label="关闭聊天遮罩"
              onClick={() => {
                store.chatOpen = false;
                store.notify();
              }}
            />
            <Chat store={store} />
          </>
        )}
      </div>
      {modal && (
        <div
          className="ag-modal-mask"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className="ag-modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "settings"
                ? "显示设置"
                : modal === "rules"
                  ? "公开规则"
                  : "结束比赛"
            }
          >
            <div className="ag-modal-title">
              <h2>
                {modal === "settings"
                  ? "显示设置"
                  : modal === "rules"
                    ? "公开规则"
                    : "结束当前比赛？"}
              </h2>
              <button
                autoFocus
                aria-label="关闭弹窗"
                onClick={() => setModal(null)}
              >
                ×
              </button>
            </div>
            {modal === "rules" && (
              <pre>
                {s.games.find((g) => g.id === rulesGame)?.rules ||
                  s.game?.rules ||
                  "请选择游戏查看规则。"}
              </pre>
            )}
            {modal === "settings" && (
              <>
                <label>
                  字号
                  <select
                    aria-label="字号"
                    value={s.preferences.fontPercent}
                    onChange={(e) => {
                      const value = {
                        ...s.preferences,
                        fontPercent: Number(e.target.value),
                      };
                      void store.preferences(
                        value as PlatformSnapshot["preferences"],
                      );
                    }}
                  >
                    <option value="100">100%</option>
                    <option value="125">125%</option>
                  </select>
                </label>
                <label className="ag-checkbox">
                  <input
                    type="checkbox"
                    checked={s.preferences.reduceMotion}
                    onChange={(e) => {
                      const value = {
                        ...s.preferences,
                        reduceMotion: e.target.checked,
                      };
                      void store.preferences(value);
                    }}
                  />
                  减少动效
                </label>
                <p className="ag-hint">
                  偏好在本次 Host
                  的所有窗口同步。浏览器保存显示偏好，比赛与聊天仅在 Host
                  内存中保留。
                </p>
              </>
            )}
            {modal === "leave" && (
              <>
                <p>
                  当前比赛将结束，未完成的模型任务会取消。聊天保留，对战会话可继续用于下一场。
                </p>
                <div className="ag-modal-actions">
                  <button onClick={() => setModal(null)}>继续比赛</button>
                  <button
                    className="ag-danger"
                    disabled={busy}
                    onClick={async () => {
                      await command("leave");
                      setModal(null);
                    }}
                  >
                    结束并返回大厅
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Chat({ store }: { store: ClientStore }) {
  const s = store.snapshot!,
    scroll = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false),
    compositionEnd = useRef(0);
  const [emoji, setEmoji] = useState(false),
    [sending, setSending] = useState(false),
    [hint, setHint] = useState("");
  const bottom = () => {
    if (scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
      store.chatBottom = true;
      store.chatScroll = scroll.current.scrollTop;
    }
  };
  const mark = () => {
    if (
      store.chatBottom &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      s.humanReadSequence < s.chatSequence
    )
      void store.request("markRead", { sequence: s.chatSequence });
  };
  useEffect(() => {
    if (scroll.current) {
      if (store.chatBottom) bottom();
      else scroll.current.scrollTop = store.chatScroll;
    }
  }, []);
  useEffect(() => {
    if (store.chatBottom) bottom();
    mark();
  }, [s.chatSequence]);
  useEffect(() => {
    const focused = () => mark();
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", focused);
    return () => {
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", focused);
    };
  }, [s.chatSequence]);
  const send = async () => {
    if (sending || composing.current) return;
    const content = store.draft.trim();
    if (!store.pendingChat && (!content || length(content) > 500)) return;
    if (!store.pendingChat)
      store.pendingChat = {
        requestId: id(),
        content: store.draft,
        kind: (EMOJI as readonly string[]).includes(content) ? "emoji" : "text",
      };
    setSending(true);
    setHint("");
    const pending = store.pendingChat;
    let success = false;
    try {
      const reply: Receipt = await store.request("say", pending);
      if (!reply.accepted) {
        store.pendingChat = null;
        store.error = errorText(reply.error);
        setHint(errorText(reply.error));
      } else {
        success = true;
        await store.refresh();
        store.error = "";
      }
    } catch {
      store.error = "聊天发送未确认，请使用原请求重试。";
    }
    if (success) {
      if (store.draft === pending.content) store.draft = "";
      store.pendingChat = null;
      bottom();
      setHint("已发送到平台");
    } else setHint("发送未确认，请原样重试。");
    setSending(false);
    store.notify();
  };
  return (
    <aside className="ag-chat" aria-label="与 Agent 聊天">
      <div className="ag-chat-heading">
        <div>
          <h2>
            {s.game?.agentSeats === 2
              ? "全桌聊天"
              : `与 ${s.opponent?.name ?? s.companion?.name ?? "Agent"} 聊天`}
          </h2>
          <small>
            {s.game?.agentSeats === 2
              ? "两位对手都能看到玩家消息 · 请勿发送私有手牌"
              : "本次运行共享 · 消息保留发送时的伙伴身份"}
          </small>
        </div>
        <button
          aria-label="收起聊天"
          onClick={() => {
            store.chatOpen = false;
            store.notify();
          }}
        >
          ×
        </button>
      </div>
      <div
        className="ag-messages"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          store.chatScroll = el.scrollTop;
          store.chatBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 36;
          mark();
        }}
      >
        {s.truncated && (
          <p className="ag-hint">早期记录已省略，仅保留最近 1000 条。</p>
        )}
        {s.messages.length === 0 && (
          <div className="ag-chat-empty">
            发一句话，打个招呼。<small>Agent 通过公开发言工具回复。</small>
          </div>
        )}
        {s.messages.map((m) => (
          <div
            className={`ag-message ag-message-${m.sender}`}
            key={`${s.instanceId}:${m.sequence}`}
          >
            <div className="ag-message-meta">
              {m.sender === "human" ? "你" : (m.senderName ?? "Agent")}
              {m.origin === "pet_report" ? " · 战报回应" : ""}
              <time>
                {new Date(m.timestamp).toLocaleTimeString("zh", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <div
              className={`ag-bubble ${(EMOJI as readonly string[]).includes(m.content) ? "ag-emoji-message" : ""}`}
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>
      {!store.chatBottom && s.chatSequence > s.humanReadSequence && (
        <button
          className="ag-new-message"
          onClick={() => {
            bottom();
            mark();
            store.notify();
          }}
        >
          有新消息 ↓
        </button>
      )}
      <div className="ag-compose">
        <div className="ag-compose-tools">
          <button aria-expanded={emoji} onClick={() => setEmoji(!emoji)}>
            ☺ 表情
          </button>
          <small>{length(store.draft)} / 500</small>
        </div>
        {emoji && (
          <div className="ag-emoji-picker" role="group" aria-label="表情选择">
            {EMOJI.map((e, i) => (
              <button
                key={e}
                aria-label={EMOJI_NAMES[i]}
                title={EMOJI_NAMES[i]}
                onClick={() => {
                  store.draft += e;
                  store.notify();
                  input.current?.focus();
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          aria-label="聊天消息"
          placeholder="聊两句… Enter 发送，Shift+Enter 换行"
          value={store.draft}
          disabled={sending || !!store.pendingChat}
          onChange={(e) => {
            store.draft = e.target.value;
            store.notify();
            setHint("");
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            compositionEnd.current = Date.now();
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.repeat &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229 &&
              !composing.current &&
              Date.now() - compositionEnd.current > 80
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="ag-primary"
          disabled={
            sending ||
            (!store.pendingChat &&
              (!store.draft.trim() || length(store.draft.trim()) > 500))
          }
          onClick={() => void send()}
        >
          {sending ? "发送中…" : store.pendingChat ? "重试发送" : "发送"}
        </button>
        <small className="ag-send-hint" role="status">
          {hint || "只显示公开聊天，不包含模型推理或工具日志。"}
        </small>
      </div>
    </aside>
  );
}

type Seat = {
  role: string;
  balance: number;
  cards: (string | null)[];
  total: number | null;
};
type HandRecord = {
  handNumber: number;
  dealer: string;
  bet: number;
  playerProfit: number;
  reason: string;
  humanCards: string[];
  agentCards: string[];
};
const reasons: Record<string, string> = {
  blackjack: "闲家 Blackjack",
  dealer_blackjack: "庄家 Blackjack",
  player_bust: "闲家爆牌",
  dealer_bust: "庄家爆牌",
  push: "和局",
  points: "点数比较",
  ten_hands: "已完成十手",
  insufficient_chips: "筹码不足最低下注",
};
export function BlackjackView({
  observation: o,
  busy,
  reduceMotion,
  act,
  next,
  rematch,
  leave,
  opponentName = "Agent",
}: GameViewProps) {
  const human = o.self as unknown as Seat,
    agent = o.opponent as unknown as Seat;
  const betAction = o.actions.find((a) => a.kind === "bet"),
    max = Number(betAction?.maximum ?? 0);
  const [draft, setDraft] = useState(10),
    [handKey, setHandKey] = useState(`${o.matchId}:${o.handNumber}`);
  const key = `${o.matchId}:${o.handNumber}`;
  if (key !== handKey) {
    setHandKey(key);
    setDraft(10);
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.repeat ||
        e.isComposing ||
        e.keyCode === 229 ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        busy ||
        document.querySelector(".ag-modal")
      )
        return;
      if (
        (e.target as HTMLElement)?.closest(
          'input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"],.ag-chat',
        )
      )
        return;
      if (e.key === "Enter" && (e.target as HTMLElement)?.closest("button"))
        return;
      if (
        e.key.toLowerCase() === "h" &&
        o.actions.some((a) => a.kind === "hit")
      ) {
        e.preventDefault();
        act({ kind: "hit" });
      } else if (
        e.key.toLowerCase() === "s" &&
        o.actions.some((a) => a.kind === "stand")
      ) {
        e.preventDefault();
        act({ kind: "stand" });
      } else if (e.key === "Enter") {
        if (betAction && draft >= 10 && draft <= max && draft % 10 === 0) {
          e.preventDefault();
          act({ kind: "bet", amount: draft });
        } else if (o.phase === "hand_result") {
          e.preventDefault();
          next();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [o, busy, draft]);
  const seat = (value: Seat, name: string, who: string) => (
    <section className={`ag-seat ag-seat-${who}`}>
      <div className="ag-seat-meta">
        <span className="ag-avatar">{who === "agent" ? "A" : "你"}</span>
        <strong>{name}</strong>
        <span className="ag-role">
          {value.role === "dealer" ? "庄家" : "闲家"}
        </span>
        <span className="ag-chips" key={`${who}-${value.balance}`}>
          ◉ {value.balance.toLocaleString()}
        </span>
        <span className="ag-score">
          {value.total === null
            ? value.cards.length
              ? "暗牌未揭示"
              : "等待发牌"
            : `${value.total} 点`}
        </span>
      </div>
      <div className="ag-card-scroll">
        <div className="ag-cards">
          {value.cards.length ? (
            value.cards.map((card, slot) => (
              <PlayingCard
                key={`${key}:${who}:${slot}`}
                value={card}
                reduceMotion={reduceMotion}
              />
            ))
          ) : (
            <span className="ag-card-placeholder">♤</span>
          )}
        </div>
      </div>
    </section>
  );
  const profit =
      Number(o.playerProfit ?? 0) * (human.role === "player" ? 1 : -1),
    finalDelta = human.balance - 1000;
  return (
    <div className="ag-blackjack">
      <div className="ag-felt">
        <div className="ag-hand-info">
          <span>
            第 <b>{Number(o.handNumber)}</b> / 10 手
          </span>
          <span>
            下注 <b>{Number(o.bet)}</b>
          </span>
        </div>
        {seat(agent, opponentName, "agent")}
        <div className="ag-table-center">
          <span className="ag-table-emblem">21</span>
          <p>
            {o.phase === "betting"
              ? "等待闲家下注"
              : o.phase === "playing"
                ? o.actions.length
                  ? "你的回合"
                  : `等待 ${opponentName}`
                : o.phase === "finished"
                  ? "比赛结束"
                  : "本手已结算"}
          </p>
          <small>BLACKJACK · 六副牌 · 庄家软 17 停牌</small>
        </div>
        {seat(human, "玩家", "human")}
        {(o.phase === "hand_result" || o.phase === "finished") && (
          <div className="ag-result" role="status">
            <strong>
              {o.phase === "finished"
                ? finalDelta > 0
                  ? "你赢得了比赛"
                  : finalDelta < 0
                    ? `${opponentName} 赢得了比赛`
                    : "比赛平局"
                : reasons[String(o.handResult)] || "本手结算"}
            </strong>
            <span
              className={
                (o.phase === "finished" ? finalDelta : profit) >= 0
                  ? "ag-profit"
                  : "ag-loss"
              }
            >
              {o.phase === "finished" ? "累计" : "本手"}{" "}
              {(o.phase === "finished" ? finalDelta : profit) > 0 ? "+" : ""}
              {o.phase === "finished" ? finalDelta : profit} 筹码
            </span>
            {o.phase === "finished" && (
              <small>
                玩家 {human.balance} · {opponentName} {agent.balance} ·{" "}
                {reasons[String(o.finishReason)]}
              </small>
            )}
          </div>
        )}
      </div>
      <div className="ag-controls">
        {betAction ? (
          <>
            <div className="ag-bet-title">
              <strong>下注金额</strong>
              <small>10–{max} · 步长 10</small>
            </div>
            <div className="ag-bet-row">
              <input
                type="number"
                aria-label="下注金额"
                min="10"
                max={max}
                step="10"
                value={Number.isNaN(draft) ? "" : draft}
                onChange={(e) =>
                  setDraft(e.target.value === "" ? NaN : Number(e.target.value))
                }
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.repeat &&
                    !e.nativeEvent.isComposing &&
                    draft >= 10 &&
                    draft <= max &&
                    draft % 10 === 0
                  ) {
                    e.preventDefault();
                    act({ kind: "bet", amount: draft });
                  }
                }}
              />
              <input
                type="range"
                aria-label="下注滑杆"
                min="10"
                max={Math.max(10, max)}
                step="10"
                value={
                  Number.isNaN(draft) ? 10 : Math.max(10, Math.min(max, draft))
                }
                onChange={(e) => setDraft(Number(e.target.value))}
              />
              <button
                className="ag-primary"
                disabled={
                  busy ||
                  !Number.isInteger(draft) ||
                  draft < 10 ||
                  draft > max ||
                  draft % 10 !== 0
                }
                onClick={() => act({ kind: "bet", amount: draft })}
              >
                确认下注 ↵
              </button>
            </div>
            <div className="ag-quick">
              {[10, 50, 100, max].map((v, i) => (
                <button
                  key={i}
                  disabled={busy || v > max}
                  onClick={() => setDraft(v)}
                >
                  {i === 3 ? `最大 ${v}` : v}
                </button>
              ))}
            </div>
          </>
        ) : o.phase === "playing" && o.actions.length ? (
          <div className="ag-action-pair">
            <button
              className="ag-primary"
              disabled={busy}
              onClick={() => act({ kind: "hit" })}
            >
              要牌 <kbd>H</kbd>
            </button>
            <button disabled={busy} onClick={() => act({ kind: "stand" })}>
              停牌 <kbd>S</kbd>
            </button>
          </div>
        ) : o.phase === "hand_result" ? (
          <button className="ag-primary" disabled={busy} onClick={next}>
            下一手 ↵
          </button>
        ) : o.phase === "finished" ? (
          <div className="ag-action-pair">
            <button className="ag-primary" disabled={busy} onClick={rematch}>
              再来一场
            </button>
            <button onClick={leave}>返回大厅</button>
          </div>
        ) : (
          <div className="ag-wait">
            ◷ 等待 {opponentName}
            {human.role === "dealer" ? " · 你是庄家，按规则自动补牌" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
function PlayingCard({
  value,
  reduceMotion,
}: {
  value: string | null;
  reduceMotion: boolean;
}) {
  const old = useRef(value),
    [flip, setFlip] = useState(false);
  useEffect(() => {
    setFlip(false);
    if (old.current === null && value !== null && !reduceMotion) {
      setFlip(true);
      const timer = setTimeout(() => setFlip(false), 200);
      old.current = value;
      return () => clearTimeout(timer);
    }
    old.current = value;
  }, [value, reduceMotion]);
  return (
    <div
      className={`ag-card ${value === null ? "ag-card-back" : /[♥♦]/u.test(value) ? "ag-card-red" : ""} ${flip ? "ag-card-flip" : ""}`}
      aria-label={value || "暗牌"}
    >
      {value === null ? (
        <span>♠</span>
      ) : (
        <>
          <span className="ag-card-corner">
            {value.slice(0, -1)}
            <small>{value.slice(-1)}</small>
          </span>
          <span className="ag-card-suit">{value.slice(-1)}</span>
          <span className="ag-card-corner ag-card-bottom">
            {value.slice(0, -1)}
            <small>{value.slice(-1)}</small>
          </span>
        </>
      )}
    </div>
  );
}
function GameHistory({
  component: Component,
  ...props
}: GameHistoryProps & { component?: React.ComponentType<GameHistoryProps> }) {
  if (Component) return <Component {...props} />;
  return (
    <aside className="ag-history">
      <div className="ag-modal-title">
        <h2>本场公开记录</h2>
        <button aria-label="关闭记录" onClick={props.close}>
          ×
        </button>
      </div>
      <p className="ag-hint">该游戏暂无公开记录界面。</p>
    </aside>
  );
}
function History({
  observation,
  close,
  opponentName = "Agent",
}: {
  observation: GameViewProps["observation"];
  close(): void;
  opponentName?: string;
}) {
  return (
    <aside className="ag-history">
      <div className="ag-modal-title">
        <h2>本场公开记录</h2>
        <button aria-label="关闭记录" onClick={close}>
          ×
        </button>
      </div>
      {((observation.history as unknown as HandRecord[]) || []).length ===
        0 && <p className="ag-hint">结算后的手牌会显示在这里。</p>}
      {((observation.history as unknown as HandRecord[]) || []).map((h) => {
        const profit = h.playerProfit * (h.dealer === "human" ? -1 : 1);
        return (
          <article key={h.handNumber}>
            <strong>
              第 {h.handNumber} 手 · 玩家
              {h.dealer === "human" ? "坐庄" : "闲家"}
            </strong>
            <span className={profit >= 0 ? "ag-profit" : "ag-loss"}>
              {profit > 0 ? "+" : ""}
              {profit}
            </span>
            <small>
              下注 {h.bet} · {reasons[h.reason]}
            </small>
            <p>
              {opponentName} {h.agentCards.join(" ")}
              <br />
              玩家 {h.humanCards.join(" ")}
            </p>
          </article>
        );
      })}
    </aside>
  );
}
