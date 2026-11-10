async function checkReactions(page) {
  const assets = [];
  page.on("request", (r) => {
    if (r.url().includes("/dsh-pet-7340/thumb/"))
      assets.push(decodeURIComponent(r.url()));
  });
  await page.reload();
  const assert = (v, m) => {
    if (!v) throw Error(m);
  };
  const unwrap = (v, predicate) => {
    if (typeof v === "string") {
      try {
        return unwrap(JSON.parse(v), predicate);
      } catch {
        return null;
      }
    }
    if (!v || typeof v !== "object") return null;
    if (predicate(v)) return v;
    for (const x of Object.values(v)) {
      const result = unwrap(x, predicate);
      if (result) return result;
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
    unwrap(await rpc("snapshot"), (v) => v.instanceId && v.games);
  const native = async (path) =>
    (
      await page.request.get(new URL("/dsh-pet-7340/" + path, page.url()).href)
    ).json();
  const nativePost = async (path, data) =>
    (
      await page.request.post(
        new URL("/dsh-pet-7340/" + path, page.url()).href,
        { data },
      )
    ).json();
  const until = async (predicate) => {
    for (let i = 0; i < 150; i++) {
      const s = await snapshot();
      if (predicate(s)) return s;
      await page.waitForTimeout(100);
    }
    throw Error(
      "reaction state timed out: " +
        JSON.stringify((await snapshot()).companionFeedback),
    );
  };
  if (!(await page.locator(".ag").count()))
    await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("100");
  await page.locator(".ag-modal input[type=checkbox]").uncheck();
  await page.getByLabel("关闭弹窗").click();
  await page
    .getByLabel("对战模型", { exact: true })
    .selectOption({ label: "本地验证模型（无外部请求） · agentgamer-mock" });
  await page.getByRole("button", { name: "我的桌宠", exact: true }).click();
  await page
    .getByLabel("选择桌宠", { exact: true })
    .selectOption({ label: "陪玩小鱼A · main / fishA" });
  const before = (await native("chat?pet=fishA&rounds=200")).messages.length;
  await page.getByRole("button", { name: "连接桌宠", exact: true }).click();
  await until((s) => s.companionFeedback?.state === "sent");
  let state = await native("state"),
    cue = state.pets.fishA.anim.data;
  assert(cue.name.includes("挥手"), "connection gesture not requested");
  assert(
    state.pets.fishA.say.data.text === "陪玩已连接，等你选游戏。",
    "connection bubble missing",
  );
  await page
    .getByText("陪玩已连接，等你选游戏。", { exact: true })
    .last()
    .waitFor();
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("video"))
        .slice(0, 2)
        .some(
          (v) =>
            v.classList.contains("is-front") && !v.paused && v.currentTime > 0,
        ),
    { timeout: 8000 },
  );
  assert(
    assets.some((u) => u.includes(cue.name)),
    "connection gesture asset was not fetched",
  );
  const connectionReceipt = await native("playback/" + cue.playbackId);
  await page.screenshot({
    path: "output/playwright/pet-reaction-connected-1920.png",
  });
  assert(state.pets.fishA.lock.data.locked === false, "lease was not released");
  await page.getByRole("button", { name: /^聊天/ }).click();
  await page.getByLabel("聊天消息", { exact: true }).fill("桌宠气泡同步验证😀");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const chatted = await until(
    (s) =>
      s.agentStatus === "idle" &&
      s.messages.some((m) => m.sender === "agent") &&
      s.companionFeedback.state === "sent",
  );
  const reply = chatted.messages
    .filter((m) => m.sender === "agent")
    .at(-1).content;
  assert(
    (await native("state")).pets.fishA.say.data.text === reply,
    "public reply not mirrored",
  );
  await page.getByText(reply, { exact: true }).last().waitFor();
  await page.screenshot({
    path: "output/playwright/pet-reaction-chat-1920.png",
  });
  await page.getByLabel("收起聊天").click();
  const lease = await nativePost("lock?pet=fishA&surface=any", { ttl: 10000 });
  await page.getByRole("button", { name: "测试桌宠反应", exact: true }).click();
  await until((s) => s.companionFeedback.state === "error");
  assert(
    (await page.locator(".ag-pet-feedback").innerText()).includes("占用"),
    "busy reason missing",
  );
  await nativePost("lock/release?pet=fishA", { lockId: lease.lockId });
  await page.getByRole("button", { name: "测试桌宠反应", exact: true }).click();
  await until((s) => s.companionFeedback.state === "sent");
  // Reduced motion changes only bubble, never the animation counter.
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("125");
  await page.locator(".ag-modal input[type=checkbox]").check();
  await page.getByLabel("关闭弹窗").click();
  const counter = (await native("state")).pets.fishA.anim.counter;
  await page.getByRole("button", { name: "测试桌宠反应", exact: true }).click();
  await until((s) => s.companionFeedback.state === "sent");
  assert(
    (await native("state")).pets.fishA.anim.counter === counter,
    "reduced motion played an animation",
  );
  await page.getByLabel("显示设置").click();
  await page.locator(".ag-modal input[type=checkbox]").uncheck();
  await page.getByLabel("关闭弹窗").click();
  await page
    .locator(".ag-game")
    .filter({
      has: page.getByRole("heading", { name: "双人吹牛骰", exact: true }),
    })
    .getByRole("button", { name: "开始比赛", exact: true })
    .click();
  await until((s) => s.game?.id === "liars_dice" && s.agentStatus === "idle");
  for (const size of [
    { width: 1280, height: 720 },
    { width: 960, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `output/playwright/pet-reaction-table-${size.width}-125.png`,
    });
    const button = await page
      .getByRole("button", { name: "叫点", exact: true })
      .boundingBox();
    assert(
      button.y + button.height <= size.height,
      "main game action fell below the viewport",
    );
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (let i = 0; i < 90; i++) {
    const s = await snapshot(),
      o = s.observation;
    assert(!s.error, s.error);
    if (o.phase === "finished") break;
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
    await page.waitForTimeout(140);
  }
  const finished = await until(
    (s) =>
      s.observation.phase === "finished" &&
      s.companionFeedback.state === "sent",
  );
  state = await native("state");
  cue = state.pets.fishA.anim.data;
  assert(
    state.pets.fishA.say.data.text.startsWith("比赛结束："),
    "result bubble missing",
  );
  const config = await native("config");
  const expected =
    config.main.animations.events.workStatus[
      finished.observation.outcome === "loss" ? 4 : 5
    ];
  assert(
    cue.name === (Array.isArray(expected) ? expected[0] : expected),
    "wrong result animation",
  );
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("video"))
        .slice(0, 2)
        .some(
          (v) =>
            v.classList.contains("is-front") && !v.paused && v.currentTime > 0,
        ),
    { timeout: 8000 },
  );
  assert(
    assets.some((u) => u.includes(cue.name)),
    "result gesture asset was not fetched",
  );
  await page.screenshot({
    path: "output/playwright/pet-reaction-result-1920.png",
  });
  assert(
    (await native("chat?pet=fishA&rounds=200")).messages.length === before,
    "presentation wrote native chat memory",
  );
  return {
    connectionPlayback: true,
    nativeConnectionReceipt: connectionReceipt.status,
    publicBubbleVisible: true,
    resultPlayback: true,
    outcome: finished.observation.outcome,
    nativeMemoryUnchanged: true,
    leaseReleased: true,
    busyAndRetry: true,
    reducedMotion: true,
    sizes: [1920, 1280, 960],
  };
}
