import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  toolPairingBalancedBefore,
  toolPairingBalancedAfter,
} from "@deepseek-ai/dsh-compaction";
import type { AgentMemory } from "./sdk.js";
import { checkpointText } from "./agent-memory.js";

/** Replace only the model-visible surface; the append-only native event log stays intact. */
export async function checkpointAgent(
  agent: Agent,
  memory: AgentMemory,
  signal: AbortSignal,
) {
  await agent.runMaintenance(async (maintenanceSignal) => {
    const cancellation = AbortSignal.any([signal, maintenanceSignal]);
    cancellation.throwIfAborted();
    const session = agent.session,
      nodes = [...session.surface.nodes];
    const message = () =>
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: checkpointText(memory) }],
      });
    const seedMemory = () => {
      if (
        memory.companion?.length ||
        memory.chat.length ||
        memory.results.length
      )
        session.append("user/message", message(), { surfaceOp: "append" });
    };
    if (!nodes.length) {
      seedMemory();
      return;
    }
    const head = session.eventAt(nodes[0]);
    if (!head) throw new Error("missing_context_head");
    const selected = head.type === "system/message" ? nodes.slice(1) : nodes;
    if (!selected.length) {
      seedMemory();
      return;
    }
    if (
      !toolPairingBalancedBefore(session, selected[0]) ||
      !toolPairingBalancedAfter(session, selected[selected.length - 1])
    )
      throw new Error("unbalanced_game_context");
    cancellation.throwIfAborted();
    session.append("user/message", message(), {
      surfaceOp: {
        op: "replace",
        startSeq: selected[0],
        endSeq: selected[selected.length - 1],
      },
      sourceEventSeqs: selected,
    });
  });
}
