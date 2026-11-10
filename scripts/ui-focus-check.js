async function checkGameFocus(page) {
  const assert = (v, m) => {
    if (!v) throw Error(m);
  };
  const find = (v, predicate) => {
    if (typeof v === "string") {
      try {
        return find(JSON.parse(v), predicate);
      } catch {
        return null;
      }
    }
    if (!v || typeof v !== "object") return null;
    if (predicate(v)) return v;
    for (const x of Object.values(v)) {
      const result = find(x, predicate);
      if (result) return result;
    }
    return null;
  };
  const rpc = async (operation, payload = {}) => {
    const method = "agentgamer/request";
    return (
      await page.request.post(new URL("/api/" + method, page.url()).href, {
        headers: { origin: new URL(page.url()).origin },
        data: {
          type: "client-request",
          rpcId: crypto.randomUUID(),
          method,
          payload: { args: { operation, payload: JSON.stringify(payload) } },
        },
      })
    ).json();
  };
  const snapshot = async () =>
    find(await rpc("snapshot"), (v) => v.instanceId && v.games);
  const native = async (path) =>
    (
      await page.request.get(new URL("/dsh-pet-7340/" + path, page.url()).href)
    ).json();
  const until = async (predicate) => {
    for (let i = 0; i < 180; i++) {
      const s = await snapshot();
      if (predicate(s)) return s;
      await page.waitForTimeout(100);
    }
    throw Error(
      "focus state timed out: " +
        JSON.stringify((await snapshot()).companionFocus),
    );
  };
  const start = async (title) => {
    await page
      .locator(".ag-game")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
      .getByRole("button", { name: "开始比赛", exact: true })
      .click();
    await until((s) => !!s.game && s.companionFocus?.state === "focused");
  };
  const leave = async () => {
    await page
      .getByRole("button", { name: /^(← )?返回大厅$/, exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "结束并返回大厅", exact: true })
      .click();
    await until((s) => !s.game && s.companionFocus.state === "idle");
    assert(
      (await native("state")).pets.fishA.lock.data.locked === false,
      "leaving kept pet ownership",
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
  await page.getByRole("button", { name: "连接桌宠", exact: true }).click();
  await until((s) => s.companionFeedback?.state === "sent");
  const memoryBefore = (await native("chat?pet=fishA&rounds=200")).messages
    .length;
  await start("双人吹牛骰");
  await rpc("pause");
  await until((s) => s.agentStatus === "paused");
  // The first caller is random. Reach a human decision before checking its controls.
  if (!(await snapshot()).observation.actions.some((a) => a.kind === "bid")) {
    await rpc("resume");
    await until((s) => s.observation.actions.some((a) => a.kind === "bid"));
    await rpc("pause");
    await until((s) => s.agentStatus === "paused");
  }
  let state = await native("state");
  const firstExpiry = state.pets.fishA.lock.data.expiresAt;
  const idle = (await native("config")).main.animations.idle[0];
  assert(
    state.pets.fishA.anim.data.name === idle,
    "game did not start in a quiet pose",
  );
  await page.waitForTimeout(1200);
  const firstSource = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll("video"))
        .slice(0, 2)
        .find((v) => v.classList.contains("is-front"))?.currentSrc,
  );
  const firstAnimCounter = (await native("state")).pets.fishA.anim.counter;
  const revision = (await snapshot()).observation.revision;
  await page.screenshot({ path: "output/playwright/pet-focus-1920.png" });
  // Exceed the entire original 15-second lease; a one-shot lock cannot pass this.
  await page.waitForTimeout(18000);
  state = await native("state");
  assert(
    state.pets.fishA.lock.data.locked &&
      state.pets.fishA.lock.data.expiresAt > firstExpiry,
    "full-game focus was not renewed",
  );
  assert(
    state.pets.fishA.anim.counter === firstAnimCounter,
    "random motion replaced the game pose",
  );
  assert(
    (await snapshot()).observation.revision === revision,
    "heartbeat changed game revision",
  );
  const afterSource = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll("video"))
        .slice(0, 2)
        .find((v) => v.classList.contains("is-front"))?.currentSrc,
  );
  assert(
    firstSource && firstSource === afterSource,
    "pet resumed unrelated daily animation",
  );
  assert(
    state.pets.fishB?.lock?.data?.locked !== true,
    "another pet was taken over",
  );
  const session = (await snapshot()).sessionId;
  await page.reload();
  if (!(await page.locator(".ag").count()))
    await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  assert(
    (await snapshot()).sessionId === session &&
      (await snapshot()).companionFocus.state === "focused",
    "refresh lost game focus",
  );
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("125");
  await page.getByLabel("关闭弹窗").click();
  for (const size of [
    { width: 1280, height: 720 },
    { width: 960, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `output/playwright/pet-focus-${size.width}-125.png`,
    });
    const box = await page
      .getByRole("button", { name: "叫点", exact: true })
      .boundingBox();
    assert(
      box.y + box.height <= size.height,
      "focus status hid the game actions",
    );
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  // A real click is user preemption, as opposed to a plugin forcibly releasing someone else's lock.
  await page.locator('.dsh-pet-hit[aria-label="陪玩小鱼A"]').click();
  await until((s) => s.companionFocus.state === "interrupted");
  await page.waitForTimeout(6500);
  assert(
    (await native("state")).pets.fishA.lock.data.locked === false,
    "focus automatically stole control back",
  );
  await page.getByRole("button", { name: "恢复专心陪玩", exact: true }).click();
  await until((s) => s.companionFocus.state === "focused");
  assert(
    (await snapshot()).agentStatus === "paused",
    "focus retry resumed the model",
  );
  await rpc("say", {
    requestId: crypto.randomUUID(),
    kind: "text",
    content: "保持专心，也来聊一句😀",
  });
  await rpc("resume");
  const spoken = await until(
    (s) =>
      s.agentStatus === "idle" &&
      s.messages.some((m) => m.sender === "agent") &&
      s.companionFeedback.state === "sent",
  );
  state = await native("state");
  assert(
    state.pets.fishA.say.data.text ===
      spoken.messages.filter((m) => m.sender === "agent").at(-1).content,
    "focused speech did not reach pet",
  );
  assert(
    state.pets.fishA.lock.data.locked,
    "speaking released the ongoing game lease",
  );
  for (let i = 0; i < 90; i++) {
    const s = await snapshot(),
      o = s.observation;
    assert(!s.error, s.error);
    if (o.phase === "finished") break;
    // React click completion is earlier than the async Remote command completion.
    const click = async (name) => {
      try {
        await page.getByRole("button", { name, exact: true }).click({ timeout: 1000 });
      } catch (e) {
        if (String(e).includes("Timeout")) return;
        throw e;
      }
      await until((next) => next.observation.revision !== o.revision);
    };
    if (o.phase === "round_result") {
      assert(
        s.companionFocus.state === "focused",
        "round settlement released full-match focus",
      );
      await click("下一局");
    } else if (o.actions.some((a) => a.kind === "challenge"))
      await click("开盅（质疑）");
    else if (o.actions.some((a) => a.kind === "bid")) {
      await page
        .getByRole("button", { name: "最低合法叫点", exact: true })
        .click();
      await click("叫点");
    }
    await page.waitForTimeout(140);
  }
  await until(
    (s) =>
      s.observation.phase === "finished" && s.companionFocus.state === "idle",
  );
  assert(
    (await native("state")).pets.fishA.lock.data.locked === false,
    "completed match kept pet locked",
  );
  await page.screenshot({
    path: "output/playwright/pet-focus-finished-1920.png",
  });
  await leave();
  await start("21 点");
  await rpc("pause");
  await leave();
  assert(
    (await native("chat?pet=fishA&rounds=200")).messages.length ===
      memoryBefore,
    "focus wrote pet chat memory",
  );
  return {
    renewBeyondOriginalLease: true,
    quietPoseStable: true,
    heartbeatRevisionUnchanged: true,
    roundWaitAndPause: true,
    userPreemption: true,
    manualRestoreOnly: true,
    focusDoesNotResumeModel: true,
    focusedChat: true,
    finishAndLeaveRelease: true,
    crossGame: true,
    refresh: true,
    nativeMemoryUnchanged: true,
    sizes: [1920, 1280, 960],
  };
}
