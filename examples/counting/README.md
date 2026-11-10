# AgentGamer counting 扩展

最小Web游戏注册示例：双方轮流加1～3，先到12者胜。示例演示Host规则、客户端视图和独立DSH bundle；不包含在两款正式游戏的默认目录中。

先安装 `dsh-plugin-agentgamer-0.2.0.tgz`，再安装本包 `dsh-plugin-agentgamer-counting-0.2.0.tgz`，在同一profile重启DSH。卸载时先扩展、后主包。

`host.js` 通过 `ctx.agentgamer.registerGame` 注册规则，`client.js` 通过 `ctx.agentgamerViews.register` 注册视图。API版本1，不提供historyComponent时使用通用记录空状态。
