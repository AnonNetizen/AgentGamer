export const inject = ["agentgamer"];
export function apply(ctx) {
  ctx.effect(() =>
    ctx.agentgamer.registerGame({
      apiVersion: 1,
      id: "counting",
      name: "接力到 12",
      version: "1.0.0",
      rulesVersion: "1.0.0",
      rules:
        "双方从0开始，玩家先行，每次加1、2或3，不能超过12。先到12者获胜。此示例演示独立插件注册游戏与客户端视图。",
      create(matchId) {
        let count = 0,
          revision = 1,
          turn = "human",
          winner = null;
        return {
          observe(actor) {
            return {
              matchId,
              revision,
              phase: winner ? "finished" : "playing",
              outcome: winner ? (winner === actor ? "win" : "loss") : "ongoing",
              count,
              turn,
              actions:
                !winner && turn === actor
                  ? [
                      {
                        kind: "add",
                        minimum: 1,
                        maximum: Math.min(3, 12 - count),
                      },
                    ]
                  : [],
            };
          },
          apply(actor, expected, action) {
            if (expected !== revision) return "stale_revision";
            if (winner || turn !== actor) return "not_your_turn";
            if (
              action.kind !== "add" ||
              !Number.isInteger(action.amount) ||
              action.amount < 1 ||
              action.amount > Math.min(3, 12 - count)
            )
              return "illegal_action";
            count += action.amount;
            revision++;
            if (count === 12) winner = actor;
            else turn = turn === "human" ? "agent" : "human";
            return "";
          },
          nextHand() {
            return "phase";
          },
        };
      },
    }),
  );
}
