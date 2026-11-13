# 升级到 AgentGamer 0.3.0

AgentGamer是原RushAgent DSH插件的新产品名。本仓库只包含插件，使用新的包、服务、工具和Remote名称；游戏规则、SDK API 1、连续比赛和模型设置语义保持原样。

## 从 dsh-agentgamer 0.2.x 更新

结束比赛并完全退出DSH。0.2.x安装的版本范围可能不会自动跨到0.3.0，使用完整版本号显式升级。桌面版使用其自带CLI，浏览器版将 `desktop` 换成 `web`，自定义profile填写实际名称：

```powershell
dsh plugin --profile desktop add dsh-agentgamer@0.3.0
```

如果装有 `dsh-agentgamer-counting`，先运行 `dsh plugin --profile desktop remove dsh-agentgamer-counting`，再升级主包，最后从本次Release下载并安装 `dsh-agentgamer-counting-0.3.0.tgz`。旧counting的peer范围只支持0.2.x，新的示例范围同时接受0.2.1和0.3.x；先移除扩展可以避免包管理器补装另一份旧主包。

重启后，在大厅分别连接两个普通模型席位，即可开始斗地主；两个席位可使用相同或不同模型。21点与吹牛骰继续只使用对手1，斗地主首版不接桌宠。关闭Host会结束当前比赛和平台聊天，显示偏好、已点击战报状态及DSH原生历史按原有方式保留。

pnpm 11默认会等待新包发布满1天；首日使用 `@latest` 可能仍选0.2.1。上面的精确版本命令已在隔离配置验证从0.2.1升级到0.3.0；包管理器只为该精确版本登记豁免，不需要关闭全局等待策略。来源：[pnpm 11官方说明](https://pnpm.io/blog/releases/11.0)。

## 从 dsh-plugin-agentgamer 0.2.0 切换

主包名从 `dsh-plugin-agentgamer` 简化为 `dsh-agentgamer`。先结束比赛并完全退出对应DSH；安装了旧counting时，先移除 `dsh-plugin-agentgamer-counting`，再移除旧主包。桌面版使用其自带CLI：

```powershell
dsh plugin --profile desktop remove dsh-plugin-agentgamer
dsh plugin --profile desktop add dsh-agentgamer@0.3.0
```

浏览器版将 `desktop` 换成 `web`，自定义profile填写实际名称。原包和原v0.2.0发行附件保留；不要在同一Host同时启用新旧主包。需要示例时重新安装 `dsh-agentgamer-counting-0.3.0.tgz`。

此次简化只改变包／模块标识：服务、Remote路由、游戏工具、SDK API 1和 `agentgamer/` 数据目录保持原样。显示偏好和战报队列继续使用原位置，旧任务编号／原文不改写。比赛与平台聊天仍只在内存中，关闭Host后结束；DSH原始历史继续保留。

## 从旧版 RushAgent 安装

1. 完成本次比赛并关闭／停止对应Host。
2. 如果安装旧counting，先移除 `dsh-plugin-rushagent-counting`，再移除 `dsh-plugin-rushagent`。扩展依赖主包，倒序卸载可能使包管理器尝试从npm补装旧主包。
3. 按npm包名 `dsh-agentgamer` 安装主插件，也可使用Release中的 `dsh-agentgamer-0.3.0.tgz`。需要示例时再安装Release中的 `dsh-agentgamer-counting-0.3.0.tgz`；counting仍为可选本地包。
4. 重启该profile，在 **AgentGamer** 重新选择模型或桌宠并连接。旧比赛和控制权不会恢复，原DSH历史仍由DSH保留。

不要在同一Host同时启用两个品牌的旧／新主插件。安装、卸载均使用实际运行的同一profile，不需要重新填写模型API Key。

## 数据接续

- 同一浏览器来源下，新版首次读取显示偏好时兼容 `rushagent.display.v1`，后续写入 `agentgamer.display.v1`。
- 默认战报目录改为 `DSH_HOME/agentgamer/report-outbox.json`。新文件缺失时，首次加载可从 `DSH_HOME/rushagent/report-outbox.json` 复制已有任务；原文件不改动。显式配置 `dataDirectory` 时按指定目录处理，不自动查找旧目录。
- 原战报编号、文本和确认状态原样接续，不改写旧品牌文字，因为它们是核对原生聊天与防止重复发送的依据。旧的等待／发送中任务转为“结果未知”，只核对，不自动POST。新目录已有文件时优先使用它；损坏文件不会被旧数据静默覆盖。
- 新战报显示AgentGamer并使用AG前缀；平台聊天与未点击战报原本只在内存中，不跨Host重启迁移。导入的人设和近聊会重新读取原生桌宠资料。

## 扩展开发者

| 项目     | 旧名                   | 新名                    |
| -------- | ---------------------- | ----------------------- |
| 包／SDK  | `dsh-plugin-rushagent` | `dsh-agentgamer` |
| Host服务 | `rushagent`            | `agentgamer`            |
| 视图服务 | `rushagentViews`       | `agentgamerViews`       |
| Remote   | `rushagent/request`    | `agentgamer/request`    |
| 模型工具 | `rushagent_*`          | `agentgamer_*`          |

更新扩展的peer依赖、Host注入、客户端注入／external和模块ID后重新打包。SDK类型结构与API版本仍为1；旧命名空间不作为运行时别名注入，避免同时启用新旧包时误路由。
