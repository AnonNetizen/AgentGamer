# 从 RushAgent 升级到 AgentGamer 0.2.0

AgentGamer是原RushAgent DSH插件的新产品名。本仓库只包含插件，使用新的包、服务、工具和Remote名称；游戏规则、SDK API 1、连续比赛和模型设置语义保持原样。

## 安装顺序

1. 完成本次比赛并关闭／停止对应Host。
2. 如果安装旧counting，先移除 `dsh-plugin-rushagent-counting`，再移除 `dsh-plugin-rushagent`。扩展依赖主包，倒序卸载可能使包管理器尝试从npm补装旧主包。
3. 按npm包名 `dsh-plugin-agentgamer` 安装主插件，也可使用Release中的 `dsh-plugin-agentgamer-0.2.0.tgz`。需要示例时再安装Release中的 `dsh-plugin-agentgamer-counting-0.2.0.tgz`；counting仍为可选本地包。
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
| 包／SDK  | `dsh-plugin-rushagent` | `dsh-plugin-agentgamer` |
| Host服务 | `rushagent`            | `agentgamer`            |
| 视图服务 | `rushagentViews`       | `agentgamerViews`       |
| Remote   | `rushagent/request`    | `agentgamer/request`    |
| 模型工具 | `rushagent_*`          | `agentgamer_*`          |

更新扩展的peer依赖、Host注入、客户端注入／external和模块ID后重新打包。SDK类型结构与API版本仍为1；旧命名空间不作为运行时别名注入，避免同时启用新旧包时误路由。
