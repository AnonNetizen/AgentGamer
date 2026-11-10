async function checkDiceUi(page) {
  if (!(await page.locator(".ag").count()))
    await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  const assert = (v, m) => {
    if (!v) throw Error(m);
  };
  const find = (v, p) => {
    if (typeof v === "string") {
      try {
        return find(JSON.parse(v), p);
      } catch {
        return null;
      }
    }
    if (!v || typeof v !== "object") return null;
    if (p(v)) return v;
    for (const x of Object.values(v)) {
      const r = find(x, p);
      if (r) return r;
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
    for (let i = 0; i < 100; i++) {
      const s = await snapshot();
      if (predicate(s)) return s;
      await page.waitForTimeout(100);
    }
    throw Error("Host condition timed out");
  };
  const cards = () => page.locator(".ag-game");
  const diceCard = () =>
    cards().filter({
      has: page.getByRole("heading", { name: "双人吹牛骰", exact: true }),
    });
  await page.setViewportSize({ width: 1920, height: 1080 });
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
  await page
    .getByLabel("对战模型", { exact: true })
    .selectOption({ label: "本地验证模型（无外部请求） · agentgamer-mock" });
  await page.getByRole("button", { name: /^(连接模型|更换 \/ 重连)$/ }).click();
  await page.getByRole("button", { name: "对战会话 ↗" }).waitFor();
  await diceCard().getByRole("button", { name: "查看公开规则 ↗" }).click();
  const ruleText = await page.locator(".ag-modal pre").innerText();
  assert(
    ruleText.includes("五局三胜") && !ruleText.includes("Blackjack"),
    "rules mixed games",
  );
  await page.getByLabel("关闭弹窗").click();
  await page.screenshot({ path: "output/playwright/dice-lobby-1920.png" });
  await diceCard()
    .getByRole("button", { name: "开始比赛", exact: true })
    .click();
  await page.locator(".ag-dice-game").waitFor();
  const start = await until(
    (s) => s.agentStatus === "idle" && s.observation.actions.length,
  );
  const session = start.sessionId;
  await page.getByRole("button", { name: "暂停 Agent", exact: true }).click();
  await page.getByLabel("叫点数量", { exact: true }).fill("9");
  await page.getByRole("button", { name: "叫 1 点", exact: true }).click();
  assert(
    (await page
      .getByRole("button", { name: "叫斋", exact: true })
      .getAttribute("aria-pressed")) === "true",
    "ones did not select straight",
  );
  await page.getByRole("button", { name: "本场记录", exact: true }).click();
  assert(
    (await page.locator(".ag-history").innerText()).includes("开盅后"),
    "dice empty history missing",
  );
  await page.getByLabel("关闭记录").click();
  await page.getByRole("button", { name: /^聊天/ }).click();
  await page
    .getByLabel("聊天消息", { exact: true })
    .fill("保留的吹牛骰聊天草稿");
  await page.getByLabel("收起聊天").click();
  const revision = (await snapshot()).observation.revision;
  await page.getByLabel("叫点数量", { exact: true }).press("Enter");
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        repeat: true,
        bubbles: true,
      }),
    ),
  );
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  assert(
    (await snapshot()).observation.revision === revision,
    "input/repeat/composition submitted a bid",
  );
  await page.screenshot({ path: "output/playwright/dice-table-1920.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: "output/playwright/dice-table-1280.png" });
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("125");
  await page.locator(".ag-modal input[type=checkbox]").check();
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  assert(
    (await snapshot()).observation.revision === revision,
    "modal did not isolate shortcut",
  );
  await page.getByLabel("关闭弹窗").click();
  assert(
    (await page.getByLabel("叫点数量", { exact: true }).inputValue()) === "9",
    "draft reset on setting/history update",
  );
  await page.setViewportSize({ width: 960, height: 640 });
  await page.screenshot({ path: "output/playwright/dice-bidding-960-125.png" });
  const controls = await page
    .getByRole("button", { name: "叫点", exact: true })
    .boundingBox();
  assert(
    controls && controls.y >= 0 && controls.y + controls.height <= 640,
    "primary bid button clipped: " + JSON.stringify(controls),
  );
  const overflow = await page
    .locator(".ag")
    .evaluate((e) => e.scrollWidth > e.clientWidth + 1);
  assert(!overflow, "small layout overflows horizontally");
  await page.getByRole("button", { name: /^聊天/ }).click();
  assert(
    (await page.getByLabel("聊天消息", { exact: true }).inputValue()) ===
      "保留的吹牛骰聊天草稿",
    "chat draft reset",
  );
  await page.screenshot({ path: "output/playwright/dice-chat-960-125.png" });
  await page.getByLabel("收起聊天").click();
  await page.locator(".ag").evaluate((e) => {
    window.__agentGamerDiceStarts = 0;
    e.addEventListener("animationstart", (event) => {
      if (event.target.matches(".ag-die")) window.__agentGamerDiceStarts++;
    });
  });
  await page.getByLabel("显示设置").click();
  await page.locator(".ag-modal input[type=checkbox]").uncheck();
  await page.getByLabel("关闭弹窗").click();
  await page.waitForTimeout(280);
  assert(
    (await page.evaluate(() => window.__agentGamerDiceStarts)) === 0,
    "turning motion on replayed old dice",
  );
  // Both clicks target the same DOM control, before React can paint a disabled state.
  await page
    .getByRole("button", { name: "叫点", exact: true })
    .evaluate((e) => {
      e.click();
      e.click();
    });
  await until((s) => s.observation.revision === revision + 1);
  assert(
    (await snapshot()).observation.bid.face === 1,
    "UI submitted wrong face",
  );
  await page.getByRole("button", { name: "继续 Agent", exact: true }).click();
  await until((s) => s.agentStatus === "idle" && s.observation.actions.length);
  assert(
    (await page.getByLabel("叫点数量", { exact: true }).inputValue()) === "9",
    "same-round draft reset after Agent action",
  );
  await page.getByRole("button", { name: "暂停 Agent", exact: true }).click();
  await page.getByRole("button", { name: "最低合法叫点", exact: true }).click();
  const keyboardRevision = (await snapshot()).observation.revision;
  await page.evaluate(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        repeat: true,
        bubbles: true,
      }),
    );
  });
  await until((s) => s.observation.revision === keyboardRevision + 1);
  await page.getByRole("button", { name: "继续 Agent", exact: true }).click();
  await until((s) => s.agentStatus === "idle" && s.observation.actions.length);
  await page.getByRole("button", { name: "开盅（质疑）", exact: true }).click();
  await until(
    (s) =>
      s.observation.phase === "round_result" ||
      s.observation.phase === "finished",
  );
  assert(
    (await page.locator(".ag-die-hidden").count()) === 0,
    "opponent dice did not reveal",
  );
  await page.waitForTimeout(280);
  const revealAnimations = await page.evaluate(() => window.__agentGamerDiceStarts);
  assert(
    revealAnimations === 5,
    "only five hidden dice should flip: " + revealAnimations,
  );
  await page.getByRole("button", { name: /^聊天/ }).click();
  await page.getByLabel("聊天消息", { exact: true }).fill("这次开盅我看到了😀");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until((s) => s.agentStatus === "idle");
  await page.waitForTimeout(280);
  assert(
    (await page.evaluate(() => window.__agentGamerDiceStarts)) === revealAnimations,
    "chat replayed old dice animations",
  );
  await page.getByLabel("收起聊天").click();
  await page.getByRole("button", { name: "本场记录", exact: true }).click();
  const publicHistory = await page.locator(".ag-history").innerText();
  assert(
    publicHistory.includes("实际") &&
      publicHistory.includes("有效") &&
      !publicHistory.includes("NaN"),
    "wrong history renderer",
  );
  await page.getByLabel("关闭记录").click();
  // Two full matches from UI; the first is already under way.
  const played = [];
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("100");
  await page.getByLabel("关闭弹窗").click();
  for (let game = 0; game < 2; game++) {
    for (let safety = 0; safety < 70; safety++) {
      const s = await snapshot(),
        o = s.observation;
      assert(!s.error, "Host error: " + s.error);
      if (o.phase === "finished") {
        played.push(o.score);
        break;
      }
      if (o.phase === "round_result")
        await page.getByRole("button", { name: "下一局", exact: true }).click();
      else if (o.actions.some((a) => a.kind === "challenge"))
        await page
          .getByRole("button", { name: "开盅（质疑）", exact: true })
          .click();
      else if (o.actions.some((a) => a.kind === "bid")) {
        await page
          .getByRole("button", { name: "最低合法叫点", exact: true })
          .click();
        await page.getByRole("button", { name: "叫点", exact: true }).click();
      }
      await page.waitForTimeout(150);
    }
    assert(
      (await snapshot()).observation.phase === "finished",
      "match did not complete",
    );
    if (game === 0) {
      const old = (await snapshot()).observation.matchId;
      await page.getByRole("button", { name: "再来一场", exact: true }).click();
      await until((s) => s.observation.matchId !== old);
    }
  }
  await until((s) => s.agentStatus === "idle");
  await page.screenshot({ path: "output/playwright/dice-settlement-1920.png" });
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await page
    .getByRole("button", { name: "结束并返回大厅", exact: true })
    .click();
  await cards()
    .filter({
      has: page.getByRole("heading", { name: "接力到 12", exact: true }),
    })
    .getByRole("button", { name: "开始比赛", exact: true })
    .click();
  await page.getByRole("button", { name: "本场记录", exact: true }).click();
  assert(
    (await page.locator(".ag-history").innerText()).includes("暂无公开记录"),
    "legacy extension history fallback failed",
  );
  await page.getByLabel("关闭记录").click();
  await page.reload();
  await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  assert(
    (await snapshot()).sessionId === session,
    "session not retained across game/reload",
  );
  assert((await snapshot()).game.id === "counting", "refresh lost game");
  await page.getByRole("button", { name: "← 返回大厅", exact: true }).click();
  await page
    .getByRole("button", { name: "结束并返回大厅", exact: true })
    .click();
  return {
    played,
    sessionReused: true,
    drafts: true,
    shortcutIsolation: true,
    duplicateClick: true,
    hiddenDice: true,
    history: true,
    legacyHistory: true,
    smallLayout: true,
    reload: true,
    animations: true,
    enterOnce: true,
  };
}
