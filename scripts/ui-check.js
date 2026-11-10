async function checkUi(page) {
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  const panel = page.locator(".ag");
  assert(
    (await panel.evaluate((e) => getComputedStyle(e).display)) === "flex",
    "plugin stylesheet missing or using a stale namespace",
  );
  if (
    await page.getByRole("button", { name: "← 返回大厅", exact: true }).count()
  ) {
    await page.getByRole("button", { name: "← 返回大厅", exact: true }).click();
    await page
      .getByRole("button", { name: "结束并返回大厅", exact: true })
      .click();
  }
  if (await page.getByLabel("收起聊天").count())
    await page.getByLabel("收起聊天").click();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page
    .getByLabel("对战模型", { exact: true })
    .selectOption({ label: "本地验证模型（无外部请求） · agentgamer-mock" });
  await page.getByRole("button", { name: /^(连接模型|更换 \/ 重连)$/ }).click();
  await page.getByRole("button", { name: "对战会话 ↗" }).waitFor();
  await page.getByRole("button", { name: /^聊天/ }).click();
  await page.getByLabel("聊天消息", { exact: true }).fill("你好😀");
  await page.getByLabel("聊天消息", { exact: true }).press("Enter");
  await page.locator(".ag-message-agent").last().waitFor();
  assert(
    (await panel.innerText()).includes("你好！😀"),
    "public model chat missing",
  );
  await page.getByLabel("聊天消息", { exact: true }).fill("保留的聊天草稿");
  await page.getByLabel("收起聊天").click();
  await page
    .getByRole("button", { name: "开始比赛", exact: true })
    .first()
    .click();
  await page.locator(".ag-blackjack").waitFor();
  // Ensure a human-betting hand, regardless of random initial dealer.
  if (!(await page.getByLabel("下注金额", { exact: true }).count())) {
    await page.getByRole("button", { name: "下一手 ↵" }).waitFor();
    await page.getByRole("button", { name: "下一手 ↵" }).click();
  }
  await page.getByLabel("下注金额", { exact: true }).fill("50");
  await page.getByRole("button", { name: "本场记录", exact: true }).click();
  await page.getByLabel("关闭记录").click();
  assert(
    (await page.getByLabel("下注金额", { exact: true }).inputValue()) === "50",
    "bet draft reset",
  );
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("125");
  await page.locator(".ag-modal input[type=checkbox]").check();
  await page.getByLabel("关闭弹窗").click();
  assert(
    (await page.getByLabel("下注金额", { exact: true }).inputValue()) === "50",
    "font change reset bet",
  );
  assert(
    await panel.evaluate((e) => e.classList.contains("ag-reduced")),
    "reduced motion not applied",
  );
  await page.setViewportSize({ width: 960, height: 640 });
  await page.screenshot({ path: "output/playwright/betting-960-125.png" });
  const betBox = await page
    .getByRole("button", { name: "确认下注 ↵", exact: true })
    .boundingBox();
  assert(
    betBox.y + betBox.height <= 640,
    `bet action clipped: ${JSON.stringify(betBox)}`,
  );
  await page.getByRole("button", { name: /^聊天/ }).click();
  assert(
    (await page.getByLabel("聊天消息", { exact: true }).inputValue()) ===
      "保留的聊天草稿",
    "chat draft reset",
  );
  await page.getByLabel("聊天消息", { exact: true }).fill("h");
  await page.getByLabel("聊天消息", { exact: true }).press("h");
  assert(
    (await page.getByLabel("下注金额", { exact: true }).inputValue()) === "50",
    "shortcut leaked from chat",
  );
  await page.screenshot({ path: "output/playwright/chat-960-125.png" });
  await page.getByLabel("收起聊天").click();
  await page.getByLabel("下注金额", { exact: true }).fill("10");
  await page.getByRole("button", { name: "确认下注 ↵", exact: true }).click();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole("button", { name: /^聊天/ }).click();
  await page.screenshot({ path: "output/playwright/table-1920.png" });
  await page.getByLabel("收起聊天").click();
  let matches = 0;
  // Real Host context maintenance and browser rendering can outlast 130 short polls.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (
      await page.getByRole("button", { name: "再来一场", exact: true }).count()
    ) {
      matches++;
      if (matches === 1) {
        await page.screenshot({
          path: "output/playwright/settlement-1920.png",
        });
        await page
          .getByRole("button", { name: "再来一场", exact: true })
          .click();
        await page
          .getByRole("button", { name: "再来一场", exact: true })
          .waitFor({ state: "detached" });
        continue;
      }
      break;
    }
    const next = page.getByRole("button", { name: "下一手 ↵", exact: true }),
      bet = page.getByRole("button", { name: "确认下注 ↵", exact: true }),
      stand = page.getByRole("button", { name: "停牌", exact: false });
    try {
      if ((await next.count()) && (await next.isEnabled()))
        await next.click({ timeout: 700 });
      else if ((await bet.count()) && (await bet.isEnabled()))
        await bet.click({ timeout: 700 });
      else if ((await stand.count()) && (await stand.isEnabled()))
        await stand.click({ timeout: 700 });
    } catch (e) {
      if (!String(e).includes("Timeout")) throw e;
    }
    await page.waitForTimeout(160);
  }
  assert(matches === 2, "two UI matches not completed");
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await page
    .getByRole("button", { name: "结束并返回大厅", exact: true })
    .click();
  await page
    .locator(".ag-game")
    .filter({
      has: page.getByRole("heading", { name: "接力到 12", exact: true }),
    })
    .getByRole("button", { name: "开始比赛", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "接力到 12", exact: true, level: 1 })
    .waitFor();
  for (let i = 0; i < 100; i++) {
    if (
      await page.getByRole("button", { name: "再来一场", exact: true }).count()
    )
      break;
    const b = page.getByRole("button", { name: "+1", exact: true });
    await b.evaluateAll((buttons) => {
      const b = buttons[0];
      if (b && !b.disabled) b.click();
    });
    await page.waitForTimeout(200);
  }
  assert(
    await page.getByRole("button", { name: "再来一场", exact: true }).count(),
    "extension game did not finish",
  );
  await page.screenshot({ path: "output/playwright/extension.png" });
  await page.reload();
  await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  await page.getByRole("heading", { name: "接力到 12", exact: true }).waitFor();
  assert(
    await page.getByRole("button", { name: "再来一场", exact: true }).count(),
    "reload lost current game",
  );
  return {
    matches,
    extension: true,
    reload: true,
    drafts: true,
    chat: true,
    reducedMotion: true,
  };
}
