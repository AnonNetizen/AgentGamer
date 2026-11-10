# 开发与扩展

## 环境与检查

Node ≥24.9，pnpm 11.28.5；DSH 0.2.2-rc.1为固定宿主目标。运行 `pnpm install --frozen-lockfile --ignore-scripts`，再运行 `pnpm check`。构建不需要父目录工程、Godot或.NET。

`tests/fixtures/blackjack-reference.json.gz` 是80场原C#实现与Frame随机流生成的合成黄金轨迹。解压后哈希、规则版本和源文件指纹见同目录provenance；不含用户对局。性能对照的旧Host位于 `tests/baseline/`，保持原始字节与旧命名空间，以免把重写后的实现冒充历史基线。这些测试数据不进入发行包。

## 真实宿主检查

使用独立DSH开发副本，在副本中运行真实AgentLoop，不能把另一套项目devDependencies混进正在运行的Host。

```powershell
$env:AGENTGAMER_DSH_RUNTIME = '/absolute/path/to/isolated-dsh-runtime'
pnpm build
pnpm check:native
```

该目录需要固定版本DSH的 `node_modules/@deepseek-ai/...` 运行模块；脚本只写它的 `agentgamer-check/` 测试区。也可按DSH官方开发流程准备一个开发副本。不要指向日常应用安装目录或含用户会话的DSH_HOME。

`native-check.mjs` 覆盖会话、工具隔离、原生历史、取消和错误恢复；`dice-native-check.mjs` 覆盖两场吹牛骰与跨游戏；`token-check.mjs` 用相同行动比较旧基线与当前有效上下文。请求序列化字节不等于供应商Token、缓存命中或费用。

`scripts/mock-provider.mjs` 是无外部请求的模拟模型插件。把它放入能解析同一套DSH模块的测试副本，在独立Host加载后选择 `agentgamer-mock`。可选 `AGENTGAMER_PET_METRICS_PATH` 写合成身份标记与调用类别，不保存原始提示正文。

页面回归使用Playwright CLI：已打开隔离Host后执行 `playwright-cli run-code --filename scripts/ui-check.js`。其余脚本覆盖原生历史、聊天、吹牛骰、伙伴资料、表现及整场专心占用。伙伴脚本使用 `fishA / fishB` 合成实例，仅在测试DSH_HOME安装dsh-pet 0.4.7；原生桌宠日志和聊天不能作为源码提交。截图输出到 `output/playwright/`。

## 注册游戏

SDK：`dsh-agentgamer/sdk`。Host以Cordis `inject: ['agentgamer']` 获取服务，并在生命周期effect内调用 `ctx.agentgamer.registerGame(definition)`。客户端以 `agentgamerViews` 注册视图，同时在包的 `dsh.client.inject / external` 声明主插件，复用宿主React。

`GameDefinition` 提供游戏标识、名称、游戏／规则版本、公开规则和 `create(matchId)`。对局实现：

- `observe(actor)`：只返回该视角的公开信息与合法操作。
- `apply(actor, expectedRevision, action)`：人类和Agent共同校验入口，空字符串表示成功；仅成功时推进修订。
- `nextHand()`：人类阶段控制，用于下一手／下一局；终局 `phase` 必须为 `finished`。

可选 `projectAgentContext(observation)` 只接收已有Agent投影，压缩额外字段和公开跨场摘要，不能改变 `matchId / revision / phase / outcome / actions`。不实现时保留原观察。

客户端 `register({id, version, component, historyComponent?})`，保存并在卸载时调用清理函数。视图拿到人类观察及绑定身份的 `act / next / rematch / leave`；可选 `opponentName` 显示伙伴，`historyComponent` 渲染公开记录。标识与实现版本必须和Host完全一致。例见 [counting](../examples/counting/README.md)。

## 发行

更新主包、counting版本、CHANGELOG与文档后运行 `pnpm release:local`。脚本先检查和构建，再打包两个tgz，审核实际归档路径、必要文件、品牌、依赖版本、Host边界与机器路径／凭据形态，生成SHA256SUMS。GitHub Release上传两个安装包与校验文件。

主包 `dsh-agentgamer` 另发布到npm，使用审核通过的同一tgz。历史 `dsh-plugin-agentgamer@0.2.0` 的npm产物与原GitHub Release逐字节一致；新版本继续使用同一归档分发。先确认该版本尚未发布，再在发布者本机完成npm登录及其要求的2FA验证：

```powershell
npm publish ./release/dsh-agentgamer-0.2.1.tgz --access public --ignore-scripts --registry=https://registry.npmjs.org/
```

后续发行替换成相应的新版本文件名，不能覆盖已经发布的版本。发布后核对registry完整性字段与匿名下载的归档，并在隔离profile按包名安装验证。不要把登录凭据或恢复码加入仓库、日志及CI。当前CI只构建、检查与生成归档，不自动发布npm或插件市场；counting示例仍作为本地包交付。
