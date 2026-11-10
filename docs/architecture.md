# 架构

```text
React 大厅／牌桌／聊天 ↔ DSH Remote ↔ AgentGamer Host
                                      ↕ 限定游戏工具
                               专用 DSH AgentLoop ↔ 已配置模型
                                      ↕ 可选固定本机接口
                                  dsh-pet 伙伴
```

Host持有完整规则状态、密码学随机种子及Frame随机流。浏览器只拿人类投影，模型只拿Agent投影；平台本身不向模型提供文件、网络或其他会话工具。第三方游戏是可信DSH插件，不是权限沙箱。

- `src/rules/`：纯TypeScript规则、合法行动校验、视角投影与确定性测试注入。
- `src/platform.ts`：一场活动比赛、行动去重、聊天顺序、伙伴身份和唤醒调度。
- `src/host.ts`、`remote.ts`：DSH服务、限定Agent会话与Remote描述符；普通DSH会话配置保持原样。
- `src/agent-memory.ts`、`native-context.ts`：稳定规则提示词、确定性12 KiB记忆与原生surface replacement，保留原始事件日志。
- `src/client.tsx`、`liars-dice-view.tsx`、`styles.css`：共享宿主React，稳定视图、纯SVG／CSS牌面、交互和显示偏好。
- `src/companion*.ts`：资料读取、短期表现、整场占用续期及用户接管保护；只使用Host实际回环地址和固定路由。
- `src/reports.ts`：公开战报与持久发送队列，未知结果不自动补发。

Remote命名空间为 `agentgamer/request`，Host服务为 `agentgamer`，视图注册服务为 `agentgamerViews`。SDK API为1；Host与视图按游戏标识及实现版本匹配。

安装包和客户端模块标识为 `dsh-agentgamer`，SDK导出路径为 `dsh-agentgamer/sdk`。原 `dsh-plugin-agentgamer` 是历史包名；更名不改变上述运行服务及数据目录，但同一Host只启用一个主包。

模型工具只有 `agentgamer_read_rules`、`agentgamer_observe`、`agentgamer_act`、`agentgamer_say`。行动必须包含 `matchId / expectedRevision / requestId / action`，重复请求返回原回执；旧局请求不能进入新比赛。游戏聊天不改变比赛修订。

模型唤醒由轮次、玩家聊天和手动重试驱动；无合法行动时结束回合。思考期间的新聊天有界排队，关闭／取消后不会再发出延迟唤醒。占用心跳只维护桌宠，不唤醒模型或推进规则。

比赛与平台聊天不落盘。默认持久目录为 `resolveDshHome()/agentgamer/`，只保存已点击的公开战报任务；历史目录迁移和去重边界见 [迁移说明](migration.md)。
