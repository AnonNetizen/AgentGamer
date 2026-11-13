import {
  clone,
  type AgentGameMetadata,
  type AgentMatchMemory,
  type AgentMemory,
  type ChatMessage,
  type GameDefinition,
  type Json,
  type Observation,
  type CompanionTurn,
} from "./sdk.js";

export const MEMORY_BYTES = 12 * 1024;
export const CHAT_BATCH_BYTES = 16 * 1024;
export const jsonBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
export const checkpointText = (memory: AgentMemory) =>
  JSON.stringify({ kind: "agentgamer_memory", ...memory });
export function agentMetadata(game: GameDefinition): AgentGameMetadata {
  return {
    apiVersion: game.apiVersion,
    id: game.id,
    name: game.name,
    version: game.version,
    rulesVersion: game.rulesVersion,
    ...(game.agentSeats ? { agentSeats: game.agentSeats } : {}),
  };
}
export function projectAgentContext(
  game: GameDefinition,
  visible: Observation,
): { observation: Observation; summary?: Json } {
  const projected = game.projectAgentContext?.(clone(visible));
  if (!projected) return { observation: clone(visible) };
  // Extensions may compact extra fields, but cannot change authoritative control fields.
  return clone({
    ...projected,
    observation: {
      ...projected.observation,
      matchId: visible.matchId,
      revision: visible.revision,
      phase: visible.phase,
      outcome: visible.outcome,
      actions: visible.actions,
    },
  });
}
export function chatBatch(
  messages: ChatMessage[],
  after: number,
): ChatMessage[] {
  const batch: ChatMessage[] = [];
  for (const message of messages) {
    if (message.sender !== "human" || message.sequence <= after) continue;
    if (
      batch.length === 20 ||
      (batch.length > 0 && jsonBytes([...batch, message]) > CHAT_BATCH_BYTES)
    )
      break;
    batch.push(message);
  }
  // Never split a valid Unicode message, including a single item over the soft budget.
  return clone(batch);
}
export function boundedMemory(
  messages: ChatMessage[],
  delivered: number,
  results: AgentMatchMemory[],
  currentMatchId?: string,
  companion: CompanionTurn[] = [],
): AgentMemory {
  const memory: AgentMemory = {
    chat: clone(
      messages
        .filter((m) => m.sender !== "human" || m.sequence <= delivered)
        .slice(-20),
    ),
    results: clone(
      results.filter((r) => r.matchId !== currentMatchId).slice(-3),
    ),
  };
  if (companion.length) memory.companion = clone(companion);
  while (Buffer.byteLength(checkpointText(memory), "utf8") > MEMORY_BYTES) {
    const chat = memory.chat[0],
      result = memory.results[0];
    const imported = memory.companion?.[0];
    if (
      imported &&
      (!chat || imported.ts <= Date.parse(chat.timestamp)) &&
      (!result || imported.ts <= Date.parse(result.timestamp))
    )
      memory.companion!.splice(0, 2);
    else if (chat && (!result || chat.timestamp <= result.timestamp))
      memory.chat.shift();
    else if (result) memory.results.shift();
    else break;
  }
  return memory;
}
