async function checkUiExtra(page) {
  const assert = (v, m) => {
    if (!v) throw Error(m);
  };
  const ag = page.locator(".ag");
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
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: /^聊天/ }).click();
  const input = page.getByLabel("聊天消息", { exact: true });
  await input.fill("输入法确认");
  const before = await page.locator(".ag-message-human").count();
  await input.dispatchEvent("compositionstart", { data: "确认" });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    keyCode: 229,
    isComposing: true,
    bubbles: true,
  });
  await input.dispatchEvent("compositionend", { data: "确认" });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    keyCode: 13,
    bubbles: true,
  });
  assert(
    (await page.locator(".ag-message-human").count()) === before,
    "IME confirmation sent message",
  );
  assert((await input.inputValue()) === "输入法确认", "IME draft lost");
  await input.press("Shift+Enter");
  assert(
    (await input.inputValue()).includes("\n"),
    "Shift Enter did not insert newline",
  );
  await page.getByRole("button", { name: "☺ 表情", exact: true }).click();
  await page.getByRole("button", { name: "鼓掌", exact: true }).click();
  assert((await input.inputValue()).includes("👏"), "emoji not inserted");
  await page.getByRole("button", { name: "☺ 表情", exact: true }).click();
  let failed = false,
    blocked = true,
    firstId = "";
  await page.route("**/api/agentgamer/request", async (route) => {
    const body = route.request().postDataJSON().payload.args;
    if (body.operation === "say" && blocked) {
      const args = JSON.parse(body.payload);
      if (!failed) {
        failed = true;
        firstId = args.requestId;
        await route.fetch();
      }
      await route.abort("failed");
    } else await route.continue();
  });
  const retryText = "原请求重试验证 " + Date.now();
  await input.fill(retryText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "重试发送", exact: true }).waitFor();
  assert(failed, "send fault route not reached");
  blocked = false;
  await page.getByRole("button", { name: "重试发送", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).waitFor();
  assert(
    (await page
      .locator(".ag-message-human .ag-bubble")
      .filter({ hasText: retryText })
      .count()) === 1,
    "retry duplicated message",
  );
  await page.unroute("**/api/agentgamer/request");
  await page.screenshot({ path: "output/playwright/lobby-chat-1280.png" });
  await page.getByLabel("收起聊天").click();
  const second = await page.context().newPage();
  await second.goto(page.url());
  await second.getByRole("button", { name: "AgentGamer", exact: true }).click();
  await page.bringToFront();
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("100");
  await page.getByLabel("关闭弹窗").click();
  await second.waitForFunction(
    () => document.querySelector(".ag")?.style.fontSize === "16px",
  );
  await page.getByRole("button", { name: /^聊天/ }).click();
  await input.fill("跨窗口未读 " + Date.now());
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByLabel("收起聊天").click();
  await page.getByRole("button", { name: /^聊天 [1-9]/ }).waitFor();
  await second.bringToFront();
  await second.getByRole("button", { name: /^聊天/ }).click();
  await page.getByRole("button", { name: "聊天", exact: true }).waitFor();
  await second.close();
  await page.bringToFront();
  await page
    .getByRole("button", { name: "开始比赛", exact: true })
    .first()
    .click();
  await page.locator(".ag-blackjack").waitFor();
  if (!(await page.getByLabel("下注金额", { exact: true }).count())) {
    await page.getByRole("button", { name: "下一手 ↵" }).waitFor();
    await page.getByRole("button", { name: "下一手 ↵" }).click();
  }
  await page.getByLabel("下注金额", { exact: true }).waitFor();
  await page.getByRole("button", { name: /^聊天/ }).click();
  await page.screenshot({ path: "output/playwright/table-chat-1280.png" });
  await page.getByLabel("收起聊天").click();
  let actions = 0;
  await page.route("**/api/agentgamer/request", async (route) => {
    if (route.request().postDataJSON().payload.args.operation === "act")
      actions++;
    await route.continue();
  });
  await page
    .getByRole("button", { name: "确认下注 ↵", exact: true })
    .evaluate((b) => {
      b.click();
      b.click();
    });
  await page
    .getByRole("button", { name: "确认下注 ↵", exact: true })
    .waitFor({ state: "detached" });
  assert(actions === 1, "double click submitted multiple actions");
  await page.unroute("**/api/agentgamer/request");
  const cards = await page.locator(".ag-seat-human .ag-card").count();
  await page
    .locator(".ag-felt")
    .dispatchEvent("keydown", { key: "h", repeat: true, bubbles: true });
  assert(
    (await page.locator(".ag-seat-human .ag-card").count()) === cards,
    "repeated shortcut executed",
  );
  await page.getByLabel("显示设置").click();
  await page.locator(".ag-modal input[type=checkbox]").uncheck();
  await page.getByLabel("关闭弹窗").click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__raDeals = 0;
    document.querySelector(".ag").addEventListener("animationstart", (e) => {
      if (e.animationName === "ag-deal") window.__raDeals++;
    });
  });
  await page.getByRole("button", { name: /^聊天/ }).click();
  await input.fill("重复观察不重播牌动画");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForTimeout(300);
  assert(
    (await page.evaluate(() => window.__raDeals)) === 0,
    "chat update replayed card entry animation",
  );
  await page.screenshot({ path: "output/playwright/table-motion-1280.png" });
  return {
    imeEvents: true,
    retryDedup: true,
    multiWindowPreferences: true,
    unreadSync: true,
    doubleClick: true,
    repeatedKey: true,
    noAnimationReplay: true,
  };
}
