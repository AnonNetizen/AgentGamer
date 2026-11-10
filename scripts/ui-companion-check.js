async function checkCompanionUi(page) {
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
  const rpc = async (operation, args = {}) => {
    const method = "agentgamer/request";
    const r = await page.request.post(
      new URL("/api/" + method, page.url()).href,
      {
        headers: { origin: new URL(page.url()).origin },
        data: {
          type: "client-request",
          rpcId: crypto.randomUUID(),
          method,
          payload: { args: { operation, payload: JSON.stringify(args) } },
        },
      },
    );
    return r.json();
  };
  const snapshot = async () =>
    find(await rpc("snapshot"), (v) => v.instanceId && Array.isArray(v.games));
  const until = async (p) => {
    for (let i = 0; i < 160; i++) {
      const s = await snapshot();
      if (p(s)) return s;
      await page.waitForTimeout(100);
    }
    throw Error("companion Host timed out");
  };
  const nativeHistory = async (id) =>
    (
      await page.request.get(
        new URL("/dsh-pet-7340/chat?pet=" + id + "&rounds=200", page.url())
          .href,
      )
    ).json();
  const leave = async () => {
    await page
      .getByRole("button", { name: /^(← )?返回大厅$/, exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "结束并返回大厅", exact: true })
      .click();
    await until((s) => !s.game);
  };
  const start = async (id) => {
    const card = page.locator(".ag-game").filter({
      has: page.getByRole("heading", {
        name: id === "blackjack" ? "21 点" : "双人吹牛骰",
        exact: true,
      }),
    });
    await card.getByRole("button", { name: "开始比赛", exact: true }).click();
    await until((s) => s.game?.id === id);
  };
  const complete = async () => {
    for (let i = 0; i < 120; i++) {
      const s = await snapshot(),
        o = s.observation;
      assert(!s.error, "Host: " + s.error);
      if (o.phase === "finished") return until((s) => s.agentStatus === "idle");
      const click = async (name) => {
        try {
          await page.getByRole("button", { name, exact: true }).click({ timeout: 1000 });
        } catch (e) {
          if (String(e).includes("Timeout")) return;
          throw e;
        }
        await until((next) => next.observation.revision !== o.revision);
      };
      if (o.phase === "round_result" || o.phase === "hand_result") {
        await click(s.game.id === "blackjack" ? "下一手 ↵" : "下一局");
      } else if (o.actions.some((a) => a.kind === "challenge")) {
        await click("开盅（质疑）");
      } else if (o.actions.some((a) => a.kind === "bid")) {
        await page
          .getByRole("button", { name: "最低合法叫点", exact: true })
          .click();
        await click("叫点");
      } else if (o.actions.some((a) => a.kind === "bet")) {
        await page.getByLabel("下注金额", { exact: true }).fill("10");
        await click("确认下注 ↵");
      } else if (o.actions.some((a) => a.kind === "stand")) {
        await click(/^停牌/);
      }
      await page.waitForTimeout(140);
    }
    throw Error("match did not finish");
  };
  if (!(await page.locator(".ag").count()))
    await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  await page.setViewportSize({ width: 1920, height: 1080 });
  if ((await snapshot()).game) await leave();
  if (await page.getByLabel("收起聊天").count())
    await page.getByLabel("收起聊天").click();
  await page
    .getByLabel("对战模型", { exact: true })
    .selectOption({ label: "本地验证模型（无外部请求） · agentgamer-mock" });
  await page.getByRole("button", { name: "我的桌宠", exact: true }).click();
  const select = page.getByLabel("选择桌宠", { exact: true });
  await select.selectOption({ label: "陪玩小鱼A · main / fishA" });
  const before = await nativeHistory("fishA");
  await page.getByRole("button", { name: "预览接入资料", exact: true }).click();
  await page.getByRole("dialog", { name: "伙伴接入资料" }).waitFor();
  assert(
    (await page.getByLabel("陪玩人设副本").inputValue()).includes("测试伙伴A"),
    "native instance persona missing",
  );
  const memoryText = await page.locator(".ag-companion-memory").innerText();
  assert(
    memoryText.includes("只属于伙伴A") && !memoryText.includes("伙伴B"),
    "native recent chat mixed identities",
  );
  await page.screenshot({ path: "output/playwright/pet-preview-1920.png" });
  for (const size of [
    { width: 1280, height: 720 },
    { width: 960, height: 640 },
  ]) {
    await page.setViewportSize(size);
    const box = await page
      .getByRole("dialog", { name: "伙伴接入资料" })
      .boundingBox();
    assert(
      box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= size.width + 1 &&
        box.y + box.height <= size.height + 1,
      "persona dialog overflow",
    );
  }
  await page.getByLabel("关闭伙伴预览").click();
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("125");
  await page.locator(".ag-modal input[type=checkbox]").check();
  await page.getByLabel("关闭弹窗").click();
  await page.getByRole("button", { name: "预览接入资料", exact: true }).click();
  await page.getByRole("dialog", { name: "伙伴接入资料" }).waitFor();
  await page.screenshot({ path: "output/playwright/pet-preview-960-125.png" });
  await page.getByLabel("关闭伙伴预览").click();
  await page.getByRole("button", { name: "连接桌宠", exact: true }).click();
  const connected = await until(
    (s) => s.companion?.petId === "fishA" && s.sessionId,
  );
  const aSession = connected.sessionId;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: "output/playwright/pet-lobby-1920.png" });
  await page.getByRole("button", { name: /^聊天/ }).click();
  await page.getByLabel("聊天消息", { exact: true }).fill("你好，小鱼A😀");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until((s) =>
    s.messages.some(
      (m) => m.sender === "agent" && m.senderName === "陪玩小鱼A",
    ),
  );
  await page.getByLabel("收起聊天").click();
  const matches = [];
  for (const id of ["liars_dice", "liars_dice", "blackjack"]) {
    await start(id);
    await until(
      (s) =>
        s.agentStatus === "idle" &&
        (s.observation.actions.length ||
          ["hand_result", "round_result", "finished"].includes(
            s.observation.phase,
          )),
    );
    assert(
      (await snapshot()).sessionId === aSession,
      "same partner created another session",
    );
    assert(
      (
        await page
          .locator(id === "blackjack" ? ".ag-blackjack" : ".ag-dice-game")
          .innerText()
      ).includes("陪玩小鱼A"),
      "table lost nickname",
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: `output/playwright/pet-${id}-1280.png` });
    if (id === "blackjack") {
      await page.reload();
      if (!(await page.locator(".ag").count()))
        await page
          .getByRole("button", { name: "AgentGamer", exact: true })
          .click();
      assert(
        (await snapshot()).sessionId === aSession &&
          (await snapshot()).game.id === id,
        "refresh lost active partner game",
      );
    }
    const finished = await complete();
    matches.push({
      game: id,
      matchId: finished.observation.matchId,
      outcome: finished.observation.outcome,
    });
    assert(
      finished.report?.companion.petId === "fishA",
      "report not bound to original companion",
    );
    assert(
      (await nativeHistory("fishA")).messages.length === before.messages.length,
      "unrequested report wrote pet memory",
    );
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.screenshot({
      path: `output/playwright/pet-${id}-result-1920.png`,
    });
    await leave();
  }
  const report = (await snapshot()).report;
  await page
    .locator(".ag-report")
    .filter({
      has: page.getByRole("button", { name: "告诉桌宠", exact: true }),
    })
    .getByRole("button", { name: "告诉桌宠", exact: true })
    .click();
  // Duplicate Remote submission must return the existing task, even while generation is in flight.
  await rpc("shareResult", { id: report.id });
  await start("liars_dice");
  await until((s) =>
    s.reportJobs.some((j) => j.id === report.id && j.status === "written"),
  );
  const native = await nativeHistory("fishA");
  assert(
    native.messages.filter(
      (m) => m.role === "user" && m.content === report.text,
    ).length === 1,
    "duplicate native report write",
  );
  assert(
    (await snapshot()).messages.some(
      (m) => m.origin === "pet_report" && m.senderName === "陪玩小鱼A",
    ),
    "native reply missing or renamed",
  );
  await leave();
  await select.selectOption({ label: "陪玩小鱼B · main / fishB" });
  await page.getByRole("button", { name: "连接桌宠", exact: true }).click();
  const bState = await until(
    (s) => s.companion?.petId === "fishB" && s.sessionId !== aSession,
  );
  await page.getByRole("button", { name: /^聊天/ }).click();
  await page.getByLabel("聊天消息", { exact: true }).fill("你好，小鱼B");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until((s) => s.messages.some((m) => m.senderName === "陪玩小鱼B"));
  assert(
    (await snapshot()).messages.some((m) => m.senderName === "陪玩小鱼A"),
    "old messages renamed with current partner",
  );
  await page.setViewportSize({ width: 960, height: 640 });
  await page.screenshot({ path: "output/playwright/pet-chat-960-125.png" });
  await page.reload();
  if (!(await page.locator(".ag").count()))
    await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  assert(
    (await snapshot()).sessionId === bState.sessionId,
    "reload replaced companion session",
  );
  return {
    matches,
    sessionReused: true,
    differentPartnerNewSession: true,
    previewReadOnly: true,
    manualOnly: true,
    reportWrittenOnce: true,
    nativeReply: true,
    refresh: true,
    layouts: [1920, 1280, 960],
    fontPercent: 125,
  };
}
