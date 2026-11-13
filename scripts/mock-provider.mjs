// Development-only provider. Never included in the release tarball.
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { writeFile } from "node:fs/promises";
export const inject = ["llm", "agentgamer"];
export function apply(ctx) {
  const delivered = new Map();
  const metrics = [];
  let writes = Promise.resolve();
  class Mock extends LlmAdapter {
    providerInfo() {
      return { id: "agentgamer-mock", name: "AgentGamer 本地模拟" };
    }
    async listModels() {
      return [
        {
          provider: "agentgamer-mock",
          id: "test",
          name: "本地验证模型（无外部请求）",
        },
      ];
    }
    async *stream(options) {
      if (options.purpose) {
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      const p = ctx.agentgamer.platform;
      const gameCall =
        Array.isArray(options.tools) &&
        options.tools.some((t) => t.name === "agentgamer_act");
      if (process.env.AGENTGAMER_PET_METRICS_PATH) {
        const raw = JSON.stringify({
          system: options.system,
          messages: options.messages,
        });
        metrics.push({
          kind: gameCall ? "game" : "pet",
          companion: p.snapshot().companion?.petId ?? null,
          hasA: raw.includes("测试伙伴A") || raw.includes("只属于伙伴A"),
          hasB: raw.includes("测试伙伴B") || raw.includes("只属于伙伴B"),
          hasPersonaA: raw.includes("测试伙伴A"),
          hasMemoryA: raw.includes("只属于伙伴A"),
          hasPersonaB: raw.includes("测试伙伴B"),
          hasMemoryB: raw.includes("只属于伙伴B"),
          engineLeak: /"(?:seed|shoe|rng|randomState)"\s*:/.test(raw),
          tools: (options.tools ?? []).map((t) => t.name),
          bytes: Buffer.byteLength(raw),
        });
        const data = JSON.stringify(metrics, null, 2);
        writes = writes.then(() =>
          writeFile(process.env.AGENTGAMER_PET_METRICS_PATH, data),
        );
        await writes;
      }
      await new Promise((r) => setTimeout(r, 80));
      options.signal?.throwIfAborted();
      if (!gameCall) {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "text", text: "我记住这场比赛了！下次继续一起玩😀" },
        };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      let packet = { humanChat: [] };
      for (const m of [...options.messages].reverse()) {
        if (m.role !== "user") continue;
        for (const b of m.content ?? []) {
          if (b.type !== "text") continue;
          try {
            const v = JSON.parse(b.text);
            if (Array.isArray(v.humanChat)) {
              packet = v;
              break;
            }
          } catch {}
        }
        if (packet.humanChat.length) break;
      }
      const seat = packet.seat ?? "agent";
      const session =
        p.snapshot().opponents?.find((s) => s.seat === seat)?.sessionId ??
        p.sessionId;
      const o = p.observeAgent(seat).observation;
      const through = delivered.get(session) ?? 0;
      let call;
      if (o?.actions.length) {
        const a = o.actions[0];
        const range = a.kind === "bid" && a.options ? a.options[0] : null;
        call = {
          name: "agentgamer_act",
          arguments: JSON.stringify({
            matchId: o.matchId,
            expectedRevision: o.revision,
            requestId: crypto.randomUUID(),
            action: range
              ? {
                  kind: "bid",
                  quantity: range.minimum,
                  face: range.face,
                  mode: range.mode,
                }
              : a.kind === "bid" && a.scores
                ? { kind: "bid", score: Math.max(...a.scores) }
                : a.kind === "play"
                  ? { kind: "play", cards: a.suggestions[0] }
                  : a.kind === "pass"
                    ? { kind: "pass" }
                    : a.kind === "bet"
                      ? { kind: "bet", amount: 10 }
                      : a.kind === "add"
                        ? { kind: "add", amount: 1 }
                        : { kind: "stand" },
          }),
        };
      } else if (packet.humanChat.some((m) => m.sequence > through)) {
        delivered.set(
          session,
          Math.max(...packet.humanChat.map((m) => m.sequence)),
        );
        call = {
          name: "agentgamer_say",
          arguments: JSON.stringify({
            requestId: crypto.randomUUID(),
            kind: "text",
            content: "你好！😀 这是一条模拟模型的公开回复。",
          }),
        };
      }
      if (call) {
        const block = { type: "tool-call", id: crypto.randomUUID(), ...call };
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "block-end", index: 0, block };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  ctx.llm.registerAdapter(["agentgamer-mock"], new Mock());
}
