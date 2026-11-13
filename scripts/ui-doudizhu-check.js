async function checkDoudizhuUi(page) {
  const assert = (v, m) => {
    if (!v) throw Error(m);
  };
  const find = (value, predicate) => {
    if (typeof value === "string") {
      try {
        return find(JSON.parse(value), predicate);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== "object") return null;
    if (predicate(value)) return value;
    for (const v of Object.values(value)) {
      const found = find(v, predicate);
      if (found) return found;
    }
    return null;
  };
  const snapshot = async () => {
    const method = "agentgamer/request";
    const response = await page.request.post(
      new URL("/api/" + method, page.url()).href,
      {
        headers: { origin: new URL(page.url()).origin },
        data: {
          type: "client-request",
          rpcId: crypto.randomUUID(),
          method,
          payload: { args: { operation: "snapshot", payload: "{}" } },
        },
      },
    );
    return find(
      await response.json(),
      (v) => v.instanceId && Array.isArray(v.games),
    );
  };
  const until = async (predicate) => {
    const end = Date.now() + 15000;
    do {
      const s = await snapshot();
      if (predicate(s)) return s;
      await page.waitForTimeout(50);
    } while (Date.now() < end);
    throw Error("Host condition timeout");
  };
  await page.setViewportSize({ width: 1920, height: 1080 });
  if (!(await page.locator(".ag").count()))
    await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  if (await page.getByLabel("收起聊天").count())
    await page.getByLabel("收起聊天").click();
  if (
    await page.getByRole("button", { name: "← 返回大厅", exact: true }).count()
  ) {
    await page.getByRole("button", { name: "← 返回大厅", exact: true }).click();
    await page
      .getByRole("button", { name: "结束并返回大厅", exact: true })
      .click();
    await until((s) => !s.game);
  }
  const card = () =>
    page.locator(".ag-game").filter({
      has: page.getByRole("heading", { name: "斗地主", exact: true }),
    });
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("100");
  await page.locator(".ag-modal input[type=checkbox]").uncheck();
  await page.getByLabel("关闭弹窗").click();
  await page
    .getByLabel("对战模型", { exact: true })
    .selectOption({ label: "本地验证模型（无外部请求） · agentgamer-mock" });
  await page.getByRole("button", { name: /^(连接模型|更换 \/ 重连)$/ }).click();
  await until((s) => !!s.sessionId);
  const secondSelect = page.getByLabel("对手 2 模型", { exact: true });
  await secondSelect.selectOption({
    label: "本地验证模型（无外部请求） · agentgamer-mock",
  });
  await page
    .getByRole("button", { name: /^(连接对手 2|更换 \/ 重连对手 2)$/ })
    .click();
  const ready = await until((s) => s.opponents.every((o) => o.sessionId));
  const sessions = ready.opponents.map((o) => o.sessionId);
  assert(new Set(sessions).size === 2, "not two sessions");
  await card().getByRole("button", { name: "查看公开规则 ↗" }).click();
  const rules = await page.locator(".ag-modal pre").innerText();
  assert(
    rules.includes("斗地主") && !rules.includes("Blackjack"),
    "wrong game rules",
  );
  await page.getByLabel("关闭弹窗").click();
  await page.locator(".ag-main").evaluate((el) => {
    el.scrollTop = 160;
  });
  await page.screenshot({ path: "output/playwright/doudizhu-lobby-1920.png" });
  await card().getByRole("button", { name: "开始比赛", exact: true }).click();
  await page.locator(".ag-ddz").waitFor();
  for (let i = 0; i < 10; i++) {
    const s = await until(
      (s) => s.observation.actions.length || s.observation.phase === "finished",
    );
    if (
      s.observation.phase === "playing" &&
      s.observation.actions.some((a) => a.kind === "play")
    )
      break;
    if (s.observation.phase === "bidding")
      await page.getByRole("button", { name: "3 分", exact: true }).click();
    else await page.getByRole("button", { name: "不出", exact: true }).click();
    await until((next) => next.observation.revision !== s.observation.revision);
  }
  const playing = await until(
    (s) =>
      s.observation.phase === "playing" &&
      s.observation.actions.some((a) => a.kind === "play"),
  );
  await page.getByRole("button", { name: "暂停 Agent", exact: true }).click();
  await until((s) => s.opponents.every((o) => o.status === "paused"));
  assert(
    await page
      .getByRole("button", { name: "对手 1 会话 ↗", exact: true })
      .count(),
    "missing first session link",
  );
  assert(
    await page
      .getByRole("button", { name: "对手 2 会话 ↗", exact: true })
      .count(),
    "missing second session link",
  );
  const firstHidden = await page
    .locator('.ag-ddz-opponents [aria-label="未公开手牌"]')
    .count();
  assert(firstHidden === 2, "opponent hands leaked in table");
  await page.getByRole("button", { name: "提示", exact: true }).click();
  const selection = () =>
    page.locator('.ag-ddz-hand button[aria-pressed="true"]').count();
  const selected = await selection();
  assert(selected > 0, "no suggested selection");
  await page.getByRole("button", { name: "本场记录", exact: true }).click();
  await page.getByLabel("关闭记录").click();
  await page.getByRole("button", { name: /^聊天/ }).click();
  await page.getByLabel("聊天消息", { exact: true }).fill("斗地主保留草稿😀");
  const before = (await snapshot()).observation.revision;
  await page.getByLabel("聊天消息", { exact: true }).press("Shift+Enter");
  await page.evaluate(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        repeat: true,
        bubbles: true,
      }),
    );
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
      }),
    );
  });
  assert(
    (await snapshot()).observation.revision === before,
    "input/repeat/composition played cards",
  );
  await page.getByLabel("收起聊天").click();
  assert((await selection()) === selected, "selection lost in chat/history");
  await page.screenshot({ path: "output/playwright/doudizhu-table-1920.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: "output/playwright/doudizhu-table-1280.png" });
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("125");
  await page.locator(".ag-modal input[type=checkbox]").check();
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  assert(
    (await snapshot()).observation.revision === before,
    "modal played cards",
  );
  await page.getByLabel("关闭弹窗").click();
  await page.setViewportSize({ width: 960, height: 640 });
  assert((await selection()) === selected, "selection lost on font change");
  await page.screenshot({
    path: "output/playwright/doudizhu-small-960-125.png",
  });
  const bounds = await page
    .getByRole("button", { name: "出牌", exact: true })
    .boundingBox();
  assert(
    bounds &&
      bounds.x >= 0 &&
      bounds.x + bounds.width <= 960 &&
      bounds.y >= 0 &&
      bounds.y + bounds.height <= 640,
    "primary play control outside small viewport",
  );
  assert(
    await page
      .locator(".ag")
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    "horizontal layout overflow",
  );
  await page.getByRole("button", { name: /^聊天/ }).click();
  assert(
    (await page.getByLabel("聊天消息", { exact: true }).inputValue()).includes(
      "斗地主保留草稿",
    ),
    "chat draft lost",
  );
  await page.getByLabel("聊天消息", { exact: true }).fill("两位都能看到吗😀");
  await page.getByLabel("聊天消息", { exact: true }).press("Enter");
  await page.getByLabel("收起聊天").click();
  await page.getByRole("button", { name: "继续 Agent", exact: true }).click();
  await until(
    (s) => s.messages.filter((m) => m.sender !== "human").length >= 2,
  );
  assert(
    (await snapshot()).observation.revision === before,
    "chat changed revision",
  );
  // Only one human mutation even when two click events arrive in one browser task.
  await page.getByRole("button", { name: "暂停 Agent", exact: true }).click();
  await page.getByRole("button", { name: "出牌", exact: true }).dblclick();
  await until((s) => s.observation.revision > before);
  assert(
    (await snapshot()).observation.revision === before + 1,
    "duplicate submit advanced twice",
  );
  await page.reload();
  if (!(await page.locator(".ag").count()))
    await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  await page.locator(".ag-ddz").waitFor();
  assert(
    (await snapshot()).observation.matchId === playing.observation.matchId,
    "refresh lost match",
  );
  await page.getByRole("button", { name: "继续 Agent", exact: true }).click();
  const finish = async () => {
    for (let i = 0; i < 180; i++) {
      const s = await until(
        (s) =>
          s.agentStatus === "error" ||
          s.observation.phase === "finished" ||
          s.observation.actions.length,
      );
      assert(s.agentStatus !== "error", s.error);
      const o = s.observation;
      if (o.phase === "finished") return s;
      if (o.phase === "bidding")
        await page.getByRole("button", { name: "3 分", exact: true }).click();
      else if (o.actions.some((a) => a.kind === "play")) {
        await page.getByRole("button", { name: "提示", exact: true }).click();
        await page.getByRole("button", { name: "出牌", exact: true }).click();
      } else
        await page.getByRole("button", { name: "不出", exact: true }).click();
      await until((s) => s.observation.revision !== o.revision);
    }
    throw Error("match did not finish");
  };
  const results = [await finish()];
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: "output/playwright/doudizhu-result-1920.png" });
  assert(
    (await page
      .locator('.ag-ddz-opponents [aria-label="未公开手牌"]')
      .count()) === 0,
    "settlement did not reveal hands",
  );
  await page.getByRole("button", { name: "再来一局", exact: true }).click();
  await until((s) => s.observation.matchId !== results[0].observation.matchId);
  results.push(await finish());
  assert(
    JSON.stringify((await snapshot()).opponents.map((o) => o.sessionId)) ===
      JSON.stringify(sessions),
    "sessions changed across matches",
  );
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await page
    .getByRole("button", { name: "结束并返回大厅", exact: true })
    .click();
  await until((s) => !s.game);
  await page
    .locator(".ag-game")
    .filter({
      has: page.getByRole("heading", { name: "双人吹牛骰", exact: true }),
    })
    .getByRole("button", { name: "开始比赛", exact: true })
    .click();
  await page.locator(".ag-dice-game").waitFor();
  assert(
    !(await page
      .getByRole("button", { name: "对手 2 会话 ↗", exact: true })
      .count()),
    "second session active in duel UI",
  );
  console.log(
    "DOUDIZHU_UI_OK",
    JSON.stringify({
      matches: results.map((s) => ({
        revision: s.observation.revision,
        result: s.observation.result,
      })),
      twoSessions: true,
      draft: true,
      shortcutIsolation: true,
      duplicateGuard: true,
      refresh: true,
      layouts: ["1920x1080", "1280x720", "960x640-125%"],
    }),
  );
  return {
    passed: true,
    twoSessions: true,
    matches: results.map((s) => s.observation.result),
    layouts: ["1920x1080", "1280x720", "960x640-125%"],
  };
}
