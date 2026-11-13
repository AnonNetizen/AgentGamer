# AgentGamer counting 扩展

最小Web游戏注册示例：双方轮流加1～3，先到12者胜。示例演示Host规则、客户端视图和独立DSH bundle；不包含在三款内置游戏的默认目录中。

先按包名安装 `dsh-agentgamer`（也可使用主包tgz），再安装本地包 `dsh-agentgamer-counting-0.3.0.tgz`，在同一profile重启DSH。卸载时先扩展、后主包。从旧示例迁移时，先移除 `dsh-plugin-agentgamer-counting`，再切换主包并安装新示例。

`host.js` 通过 `ctx.agentgamer.registerGame` 注册规则，`client.js` 通过 `ctx.agentgamerViews.register` 注册视图。API版本1，不提供historyComponent时使用通用记录空状态。
