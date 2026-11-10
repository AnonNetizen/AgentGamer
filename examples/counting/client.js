window.__ModuleLoader__.load({
  id: "dsh-plugin-agentgamer-counting",
  factory: (require) => {
    const React = require("react");
    require("dsh-plugin-agentgamer");
    const h = React.createElement;
    function Counting({ observation: o, busy, act, rematch, leave }) {
      const controls =
        o.phase === "finished"
          ? [
              h("button", { key: "again", onClick: rematch }, "再来一场"),
              h("button", { key: "leave", onClick: leave }, "返回大厅"),
            ]
          : [1, 2, 3].map((n) =>
              h(
                "button",
                {
                  key: n,
                  disabled: busy || !o.actions.length || n > 12 - o.count,
                  onClick: () => act({ kind: "add", amount: n }),
                },
                `+${n}`,
              ),
            );
      return h(
        "div",
        { className: "ag-lobby" },
        h("h1", null, "接力到 12"),
        h(
          "div",
          { className: "ag-empty", style: { fontSize: "4em" } },
          o.count,
        ),
        h(
          "p",
          null,
          o.phase === "finished"
            ? o.outcome === "win"
              ? "你赢了"
              : "Agent 赢了"
            : o.actions.length
              ? "你的回合：加1、2或3"
              : "等待 Agent",
        ),
        h(
          "div",
          { className: "ag-action-pair", style: { marginTop: 24 } },
          ...controls,
        ),
      );
    }
    return {
      inject: ["agentgamerViews"],
      apply(ctx) {
        ctx.effect(() =>
          ctx.agentgamerViews.register({
            id: "counting",
            version: "1.0.0",
            component: Counting,
            // API v1 historyComponent is optional; this example exercises the legacy fallback.
          }),
        );
      },
    };
  },
});
