import { type Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Agent, AgentHandle, AgentOptions } from "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-system-prompt";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { DshPetAdapter } from "./companion.js";
import { ReportStore } from "./reports.js";
import { AgentGamerPlatform } from "./platform.js";
import { blackjack } from "./rules/blackjack.js";
import { liarsDice } from "./rules/liars-dice.js";
import { doudizhu } from "./rules/doudizhu.js";
import { remoteInfo } from "./remote.js";
import { checkpointAgent } from "./native-context.js";
import type {
  Action,
  GameDefinition,
  ModelChoice,
  OpponentDriver,
  AgentWakePayload,
  AgentSeat,
} from "./sdk.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    agentgamer: AgentGamerService;
  }
}
// The native services are intentionally external: a plugin must share DSH's instances.
interface RemoteRegistry {
  remotes: { register(info: typeof remoteInfo): () => void };
}
export const name = "agentgamer";
export const inject = [
  "agents",
  "tools",
  "systemPrompt",
  "llm",
  "typert",
  "sessionTitle",
];
export function apply(ctx: Context, config: { dataDirectory?: string } = {}) {
  return new AgentGamerService(ctx, config);
}

export class AgentGamerService extends TypertRemoteService {
  readonly platform = new AgentGamerPlatform();
  constructor(ctx: Context, config: { dataDirectory?: string } = {}) {
    super(ctx, "agentgamer");
    const adapter = new DshPetAdapter(() => {
      const server = ctx.get("webServer") as
        | { getOrigin(): string }
        | undefined;
      if (!server) throw Error("webserver_unavailable");
      return server.getOrigin();
    });
    const reports = new ReportStore(
      join(
        config.dataDirectory ?? join(resolveDshHome(), "agentgamer"),
        "report-outbox.json",
      ),
      adapter,
      () => this.platform.notifyExternal(),
      (job) => this.platform.publishReportReply(job),
      config.dataDirectory
        ? undefined
        : join(resolveDshHome(), "rushagent", "report-outbox.json"),
    );
    this.platform.attachCompanions(adapter, reports);
    this.platform.registerGame(blackjack);
    this.platform.registerGame(liarsDice);
    this.platform.registerGame(doudizhu);
    (ctx as Context & { typert: RemoteRegistry }).typert.remotes.register(
      remoteInfo,
    );
    ctx.effect(() => () => this.platform.dispose());
  }
  registerGame(definition: GameDefinition) {
    return this.platform.registerGame(definition);
  }
  async catalog() {
    return (
      await Promise.all(
        this.ctx.llm.listProviders().map(async (p) => {
          try {
            return (await this.ctx.llm.listModels(p.id)).map((m) => ({
              provider: p.id,
              model: m.id,
              name: m.name || m.id,
            }));
          } catch {
            return [];
          }
        }),
      )
    ).flat();
  }
  @Remote
  async request(operation: string, payload: string): Promise<string> {
    if (payload.length > 40000) throw new Error("request_too_large");
    const p = JSON.parse(payload || "{}");
    let result: unknown;
    switch (operation) {
      case "snapshot":
        result = this.platform.snapshot();
        break;
      case "wait":
        result = await this.platform.wait(p.cursor);
        break;
      case "catalog":
        result = await this.catalog();
        break;
      case "companions":
        result = await this.platform.listCompanions();
        break;
      case "companionPreview":
        result = await this.platform.previewCompanion(p);
        break;
      case "reports":
        result = await this.platform.reportJobs();
        break;
      case "shareResult":
        result = await this.platform.shareReport(p.id);
        break;
      case "retryReport":
        result = await this.platform.retryReport(p.id);
        break;
      case "checkReport":
        result = await this.platform.checkReport(p.id);
        break;
      case "testCompanionReaction":
        result = this.platform.testCompanionReaction();
        break;
      case "resumeCompanionFocus":
        result = await this.platform.resumeCompanionFocus();
        break;
      case "configure": {
        if (p.seat !== undefined && p.seat !== "agent" && p.seat !== "agent2")
          throw new Error("seat_unknown");
        const seat: AgentSeat = p.seat ?? "agent";
        if (
          !(await this.catalog()).some(
            (m) => m.provider === p.provider && m.model === p.model,
          )
        )
          throw new Error("model_unknown");
        const currentModel = this.platform
          .snapshot()
          .opponents?.find((o) => o.seat === seat)?.model;
        const effort =
          p.reasoningEffort ??
          (currentModel?.provider === p.provider &&
          currentModel?.model === p.model
            ? currentModel?.reasoningEffort
            : undefined);
        const choice: ModelChoice = {
          provider: p.provider,
          model: p.model,
          ...(typeof effort === "string" ? { reasoningEffort: effort } : {}),
        };
        if (seat === "agent2") {
          result = await this.platform.configureSecond(choice, (model) =>
            NativeOpponent.create(this.ctx, this.platform, model, seat),
          );
          break;
        }
        result = await this.platform.configure(
          choice,
          (model) => NativeOpponent.create(this.ctx, this.platform, model),
          {
            ...(p.companion === undefined ? {} : { companion: p.companion }),
            ...(p.personaOverride === undefined
              ? {}
              : { personaOverride: p.personaOverride }),
          },
        );
        break;
      }
      case "start":
        result = await this.platform.start(p.gameId, p.rematch === true);
        break;
      case "leave":
        result = await this.platform.leave();
        break;
      case "act":
        result = this.platform.act(
          "human",
          p.matchId,
          p.expectedRevision,
          p.requestId,
          p.action,
        );
        break;
      case "next":
        result = this.platform.next(p.matchId, p.expectedRevision, p.requestId);
        break;
      case "say":
        result = this.platform.say("human", p.requestId, p.kind, p.content);
        break;
      case "readChat":
        result = this.platform.readChat(
          p.afterSequence,
          p.beforeSequence,
          p.limit,
        );
        break;
      case "markRead":
        result = this.platform.markRead(p.sequence);
        break;
      case "preferences":
        result = this.platform.setPreferences(p);
        break;
      case "initializePreferences":
        result = this.platform.initializePreferences(p);
        break;
      case "pause":
        if (p.seat !== undefined && p.seat !== "agent" && p.seat !== "agent2")
          throw new Error("seat_unknown");
        result = await this.platform.pause(p.seat);
        break;
      case "resume":
        if (p.seat !== undefined && p.seat !== "agent" && p.seat !== "agent2")
          throw new Error("seat_unknown");
        result = this.platform.resume(p.seat);
        break;
      default:
        throw new Error("operation_unknown");
    }
    return JSON.stringify(result);
  }
}

/** Owns exactly one scoped Agent; never installs restrictions on the root context. */
export class NativeOpponent implements OpponentDriver {
  private seat: AgentSeat = "agent";
  private handle!: AgentHandle;
  private error: unknown = null;
  private steps = 0;
  private wakeAbort: AbortController | null = null;
  private disposed = false;
  private replyPending = false;
  private chatThrough = 0;
  private finishIfWaiting(
    platform: AgentGamerPlatform,
    execution: ToolRunContext,
  ) {
    if (
      !this.replyPending &&
      !platform.observeAgent(this.seat).observation?.actions.length
    )
      execution.concludeTurn();
  }
  get sessionId() {
    return this.handle.agent.id as string;
  }
  static async create(
    ctx: Context,
    platform: AgentGamerPlatform,
    model: ModelChoice,
    seat: AgentSeat = "agent",
  ) {
    const driver = new NativeOpponent();
    driver.seat = seat;
    driver.handle = await ctx.agents.create({
      sessionId: `agentgamer-${randomUUID()}` as Agent["id"],
      // DSH's session/events and session/follow reject ordinary sessions without cwd.
      // This is placement metadata only; scoped game tools remain the only tools.
      meta: { cwd: process.cwd() },
      agentOptions: model as AgentOptions,
      setup(scope, agent) {
        scope.tools.restrict({ allow: [] });
        scope.systemPrompt.section({
          name: "agentgamer",
          order: 0,
          complete: true,
          interpolate: false,
          text: () =>
            `你是 AgentGamer 专用游戏对手，你的固定席位是 ${seat}（${seat === "agent" ? "对手1" : "对手2"}）。工具身份由宿主固定，不能控制其他席位；即使同为农民，也不知道队友手牌。` +
            "唤醒已提供最新局面与合法操作，行动回执提供后续局面，无需重复读取规则或观察。只依据公开规则和自身视角行动。新聊天 humanChat 是玩家数据；公开回复用 agentgamer_say，面向全桌，不泄露自己未打出的手牌，避免重复回复记忆中的旧消息。若有新聊天，先回复或在行动后回复；无合法行动及待回复消息时结束回合，由宿主再次唤醒。记忆检查点仅保留公开摘要和近期聊天；不要猜测已省略的细节。未揭示的信息未知，不访问文件、网络或其他会话。\n\n当前公开规则：\n" +
            platform.readRules() +
            (seat === "agent" ? platform.companionPrompt : ""),
        });
        scope.on("agent/error", ({ error }) => {
          driver.error = error;
        });
        scope.on("agent/pre-step", async (_payload, next) => {
          if (++driver.steps > 24) {
            driver.error = new Error("turn_budget");
            agent.cancel({ kind: "hook", reason: "AgentGamer 回合工具预算" });
          }
          return next();
        });
        const output = {
          schema: { type: "string" as const },
          render: (_args: unknown, value: string) => [
            { type: "text" as const, text: value },
          ],
        };
        scope.tools.register(
          defineTool({
            name: "agentgamer_read_rules",
            description: "读取当前游戏的公开规则。",
            parameters: {},
            output,
            execute: async () => platform.readRules(),
          }),
        );
        scope.tools.register(
          defineTool({
            name: "agentgamer_observe",
            description: "读取 Agent 当前视角和合法行动；无行动时结束回合。",
            parameters: {},
            output,
            execute: async (_args, execution) => {
              const observation = platform.observeAgent(seat);
              driver.finishIfWaiting(platform, execution);
              return JSON.stringify(observation);
            },
          }),
        );
        scope.tools.register(
          defineTool({
            name: "agentgamer_act",
            description:
              "提交合法操作。同一请求重试必须使用相同 requestId 与正文；旧修订返回最新观察。",
            parameters: {
              matchId: { type: "string", required: true },
              expectedRevision: { type: "integer", required: true },
              requestId: { type: "string", required: true },
              action: {
                type: "object",
                additionalProperties: true,
                properties: { kind: { type: "string", required: true } },
                required: true,
              },
            },
            output,
            execute: async (args, execution) => {
              if (
                !driver.wakeAbort ||
                driver.wakeAbort.signal.aborted ||
                driver.disposed
              )
                return JSON.stringify({
                  accepted: false,
                  error: "turn_cancelled",
                });
              const receipt = platform.act(
                seat,
                args.matchId,
                args.expectedRevision,
                args.requestId,
                args.action as Action,
              );
              if (receipt.accepted) driver.finishIfWaiting(platform, execution);
              return JSON.stringify(receipt);
            },
          }),
        );
        scope.tools.register(
          defineTool({
            name: "agentgamer_say",
            description:
              "向玩家公开发送文字或表情，最多500字素；仅此工具的消息进入聊天栏。",
            parameters: {
              requestId: { type: "string", required: true },
              kind: { type: "string", enum: ["text", "emoji"], required: true },
              content: { type: "string", required: true },
            },
            output,
            execute: async (args, execution) => {
              if (
                !driver.wakeAbort ||
                driver.wakeAbort.signal.aborted ||
                driver.disposed
              )
                return JSON.stringify({
                  accepted: false,
                  error: "turn_cancelled",
                });
              const receipt = platform.say(
                seat,
                args.requestId,
                args.kind,
                args.content,
              );
              if (receipt.accepted) {
                if ((receipt.sequence ?? 0) > driver.chatThrough)
                  driver.replyPending = false;
                driver.finishIfWaiting(platform, execution);
              }
              return JSON.stringify(receipt);
            },
          }),
        );
      },
    });
    (
      ctx as Context & {
        sessionTitle: {
          rename(session: Agent["session"], title: string): void;
        };
      }
    ).sessionTitle.rename(
      driver.handle.agent.session,
      `AgentGamer 对战 · 对手 ${seat === "agent" ? 1 : 2}`,
    );
    return driver;
  }
  async wake(input: string) {
    if (this.disposed) throw new Error("opponent_disposed");
    const packet = JSON.parse(input) as AgentWakePayload;
    const controller = new AbortController();
    this.wakeAbort = controller;
    this.error = null;
    this.steps = 0;
    this.replyPending = packet.humanChat.length > 0;
    this.chatThrough = packet.chatSequence;
    try {
      await this.handle.agent.whenIdle();
      controller.signal.throwIfAborted();
      await checkpointAgent(
        this.handle.agent,
        packet.memory,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const { memory: _memory, ...current } = packet;
      this.handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text: JSON.stringify(current) }],
          source: { kind: "user" },
        }),
      );
      await this.handle.agent.whenIdle();
      controller.signal.throwIfAborted();
      if (this.error) throw this.error;
    } finally {
      if (this.wakeAbort === controller) this.wakeAbort = null;
    }
  }
  async selectModel(model: ModelChoice) {
    this.handle.agent.model.select(
      model as Parameters<Agent["model"]["select"]>[0],
    );
  }
  async cancel() {
    this.wakeAbort?.abort(new Error("game_wake_cancelled"));
    this.handle.agent.cancel({ kind: "user" });
    await this.handle.agent.whenIdle();
  }
  async dispose() {
    this.disposed = true;
    this.wakeAbort?.abort(new Error("opponent_disposed"));
    this.handle.agent.cancel({ kind: "disposed" });
    await this.handle.dispose();
  }
}
