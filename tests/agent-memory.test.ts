import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentMetadata,
  boundedMemory,
  chatBatch,
  checkpointText,
  jsonBytes,
  MEMORY_BYTES,
  CHAT_BATCH_BYTES,
  projectAgentContext,
} from "../src/agent-memory.js";
import { AgentGamerPlatform } from "../src/platform.js";
import { blackjack, BlackjackMatch } from "../src/rules/blackjack.js";
import type {
  AgentWakePayload,
  ChatMessage,
  AgentMatchMemory,
} from "../src/sdk.js";
const chat = (n: number, content = "消息"): ChatMessage => ({
  sequence: n,
  sender: n % 3 === 0 ? "agent" : "human",
  timestamp: new Date(n * 1000).toISOString(),
  kind: "text",
  content,
  gameId: null,
  matchId: null,
});

test("compact projection preserves hidden cards, control fields, full human history and legacy modules", () => {
  const m = new BlackjackMatch("projection", {
    dealer: "agent",
    shoe: [10, 9, 8, 8, 2, 2, 2, 2].map((rank) => ({ rank, suit: 0 })),
  });
  m.apply("human", 1, { kind: "bet", amount: 10 });
  const visible = m.observe("agent"),
    projected = projectAgentContext(blackjack, visible).observation;
  assert.deepEqual(projected.self, visible.self);
  assert.equal((projected.self as any).cards[1], null);
  assert.equal((projected.self as any).total, null);
  m.apply("human", 2, { kind: "stand" });
  const full = m.observe("agent"),
    compact = projectAgentContext(blackjack, full);
  assert.ok(JSON.stringify(full.history).includes("humanCards"));
  assert.ok(!JSON.stringify(compact.observation.history).includes("Cards"));
  assert.deepEqual(
    projectAgentContext({ ...blackjack, projectAgentContext: undefined }, full)
      .observation,
    full,
  );
  const malicious = projectAgentContext(
    {
      ...blackjack,
      projectAgentContext: (o) => ({
        observation: { ...o, matchId: "bad", revision: 999, actions: [] },
      }),
    },
    visible,
  ).observation;
  assert.equal(malicious.matchId, "projection");
  assert.equal(malicious.revision, visible.revision);
  assert.deepEqual(malicious.actions, visible.actions);
  assert.ok(!("rules" in agentMetadata(blackjack)));
});
test("bounded public memory, pending chat exclusion and UTF-8 batch soft limit", () => {
  const messages = Array.from({ length: 1000 }, (_, i) =>
    chat(i + 1, "中".repeat(500)),
  );
  const results: AgentMatchMemory[] = Array.from({ length: 5 }, (_, i) => ({
    game: agentMetadata(blackjack),
    matchId: "m" + i,
    timestamp: new Date(i * 1000).toISOString(),
    outcome: "draw",
    summary: { selfBalance: 1000 },
  }));
  const memory = boundedMemory(messages, 995, results, "m4");
  assert.ok(jsonBytes(memory) <= MEMORY_BYTES);
  assert.ok(Buffer.byteLength(checkpointText(memory)) <= MEMORY_BYTES);
  assert.ok(memory.chat.length <= 20);
  assert.ok(memory.results.length <= 3);
  assert.ok(
    memory.chat.every((m) => m.sender === "agent" || m.sequence <= 995),
  );
  assert.ok(memory.results.every((r) => r.matchId !== "m4"));
  // The envelope is part of the strict checkpoint budget, not just its entries.
  const edge = { ...results[0], summary: "" };
  edge.summary = "a".repeat(
    MEMORY_BYTES - jsonBytes({ chat: [], results: [edge] }),
  );
  assert.equal(jsonBytes({ chat: [], results: [edge] }), MEMORY_BYTES);
  const bounded = boundedMemory([], 0, [edge]);
  assert.equal(bounded.results.length, 0);
  assert.ok(Buffer.byteLength(checkpointText(bounded)) <= MEMORY_BYTES);
  const batch = chatBatch(messages, 0);
  assert.ok(batch.length <= 20);
  assert.ok(jsonBytes(batch) <= CHAT_BATCH_BYTES);
  const big = {
    ...chat(1, "a" + "\u0301".repeat(15999)),
    sender: "human" as const,
  };
  assert.deepEqual(chatBatch([big, { ...chat(2), sender: "human" }], 0), [big]);
});
test("messages arriving during a wake are delivered FIFO in bounded batches without repeated rules", async () => {
  const p = new AgentGamerPlatform();
  p.registerGame(blackjack);
  const packets: AgentWakePayload[] = [];
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (begin = r)),
    gate = new Promise<void>((r) => (release = r));
  await p.configure({ provider: "mock", model: "test" }, async () => ({
    sessionId: "same",
    selectModel: async () => {},
    cancel: async () => release?.(),
    dispose: async () => release?.(),
    wake: async (input) => {
      packets.push(JSON.parse(input));
      if (packets.length === 1) {
        begin();
        await gate;
      }
    },
  }));
  p.say("human", "first", "text", "第一条");
  await started;
  for (let i = 2; i <= 46; i++)
    p.say("human", "message-" + i, "text", String(i));
  release();
  await p.settled();
  assert.deepEqual(
    packets.map((p) => p.humanChat.length),
    [1, 20, 20, 5],
  );
  assert.deepEqual(
    packets.flatMap((p) => p.humanChat.map((m) => m.sequence)),
    Array.from({ length: 46 }, (_, i) => i + 1),
  );
  assert.equal(p.snapshot().messages.length, 46);
  assert.equal(p.sessionId, "same");
  assert.equal(p.snapshot().observation, null);
  assert.ok(packets.every((p) => jsonBytes(p.memory) <= MEMORY_BYTES));
  await p.dispose();
});
test("failed chat batch is retried intact and successful batches are not redelivered", async () => {
  const p = new AgentGamerPlatform();
  const inputs: AgentWakePayload[] = [];
  let fail = true;
  await p.configure({ provider: "mock", model: "test" }, async () => ({
    sessionId: "same",
    selectModel: async () => {},
    cancel: async () => {},
    dispose: async () => {},
    wake: async (input) => {
      inputs.push(JSON.parse(input));
      if (fail) throw Error("provider");
    },
  }));
  for (let i = 0; i < 23; i++) p.say("human", "queued-" + i, "text", String(i));
  await p.settled();
  assert.equal(p.snapshot().agentStatus, "error");
  fail = false;
  p.resume();
  await p.settled();
  assert.deepEqual(
    inputs.map((p) => p.humanChat.length),
    [20, 20, 3],
  );
  assert.deepEqual(inputs[0].humanChat, inputs[1].humanChat);
  p.say("human", "last", "text", "24");
  await p.settled();
  assert.deepEqual(
    inputs.at(-1)!.humanChat.map((m) => m.sequence),
    [24],
  );
  await p.dispose();
});
