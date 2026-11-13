# 架构

```text
React 大厅／牌桌／聊天 ↔ DSH Remote ↔ AgentGamer Host
                                      ↕ 限定游戏工具
                         按席位隔离的 DSH AgentLoop ↔ 各自配置模型
                                      ↕ 可选固定本机接口
                                  dsh-pet 伙伴
```

Host持有完整规则状态、密码学随机种子及Frame随机流。浏览器只拿人类投影，模型只拿Agent投影；平台本身不向模型提供文件、网络或其他会话工具。第三方游戏是可信DSH插件，不是权限沙箱。

- `src/rules/`：纯TypeScript规则、合法行动校验、视角投影与确定性测试注入。
- `src/platform.ts`：一场活动比赛、行动去重、聊天顺序、伙伴身份和每席位独立唤醒调度。斗地主使用agent与agent2两个会话，普通双人游戏只启用agent。
- `src/host.ts`、`remote.ts`：DSH服务、限定Agent会话与Remote描述符；普通DSH会话配置保持原样。
- `src/agent-memory.ts`、`native-context.ts`：稳定规则提示词、确定性12 KiB记忆与原生surface replacement，保留原始事件日志。
- `src/client.tsx`、`liars-dice-view.tsx`、`doudizhu-view.tsx`、`styles.css`：共享宿主React，稳定视图、纯SVG／CSS牌面、交互和显示偏好。
- `src/companion*.ts`：资料读取、短期表现、整场占用续期及用户接管保护；只使用Host实际回环地址和固定路由。
- `src/reports.ts`：公开战报与持久发送队列，未知结果不自动补发。

Remote命名空间为 `agentgamer/request`，Host服务为 `agentgamer`，视图注册服务为 `agentgamerViews`。SDK API为1；Host与视图按游戏标识及实现版本匹配。

安装包和客户端模块标识为 `dsh-agentgamer`，SDK导出路径为 `dsh-agentgamer/sdk`。原 `dsh-plugin-agentgamer` 是历史包名；更名不改变上述运行服务及数据目录，但同一Host只启用一个主包。

模型工具只有 `agentgamer_read_rules`、`agentgamer_observe`、`agentgamer_act`、`agentgamer_say`。行动必须包含 `matchId / expectedRevision / requestId / action`，重复请求返回原回执；旧局请求不能进入新比赛。游戏聊天不改变比赛修订。

模型唤醒由轮次、玩家聊天和手动重试驱动；无合法行动时结束回合。思考期间的新聊天有界排队，关闭／取消后不会再发出延迟唤醒。占用心跳只维护桌宠，不唤醒模型或推进规则。

三人游戏声明 `agentSeats: 2`；两位NativeOpponent的工具闭包分别固定agent或agent2，不接受模型指定执行身份。每席位独立维护模型、运行状态、重试预算、聊天投递游标、12 KiB检查点与最近3场公开摘要。人类页面仅取得human投影，各Agent仅取得自身投影；队友也不共享暗牌。两边可以同时处理聊天，规则提交仍按单一Host上的修订顺序串行校验。全局暂停／离开／卸载取消两边；席位暂停以独立运行代号丢弃旧回调。第二席位在双人游戏或大厅不自动唤醒。

比赛与平台聊天不落盘。默认持久目录为 `resolveDshHome()/agentgamer/`，只保存已点击的公开战报任务；历史目录迁移和去重边界见 [迁移说明](migration.md)。
