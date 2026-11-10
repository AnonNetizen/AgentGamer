async function checkSessionHistory(page) {
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  const marker = "会话历史回归验证-" + Date.now();
  await page.setViewportSize({ width: 1280, height: 720 });
  if (await page.getByRole("dialog", { name: "预览版说明" }).count())
    await page.getByRole("button", { name: "继续", exact: true }).click();
  if (await page.getByRole("dialog", { name: "开始使用" }).count())
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
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
  await page
    .getByLabel("对战模型", { exact: true })
    .selectOption({ label: "本地验证模型（无外部请求） · agentgamer-mock" });
  await page.getByRole("button", { name: /^(连接模型|更换 \/ 重连)$/ }).click();
  await page
    .getByRole("button", { name: "对战会话 ↗", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^聊天/ }).click();
  const repliesBefore = await page.locator(".ag-message-agent").count();
  await page.getByLabel("聊天消息", { exact: true }).fill(marker);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(
    (before) => document.querySelectorAll(".ag-message-agent").length > before,
    repliesBefore,
    { timeout: 15000 },
  );

  // The native Remote envelope and endpoint: assert actual history data, not navigation alone.
  const rpc = async (method, args) => {
    const response = await page.request.post(
      new URL("/api/" + method, page.url()).href,
      {
        headers: { origin: new URL(page.url()).origin },
        data: {
          type: "client-request",
          rpcId: crypto.randomUUID(),
          method,
          payload: { args },
        },
      },
    );
    assert(response.ok(), method + " returned HTTP " + response.status());
    return response.json();
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
    for (const child of Object.values(value)) {
      const match = find(child, predicate);
      if (match) return match;
    }
    return null;
  };
  const snapshot = find(
    await rpc("agentgamer/request", { operation: "snapshot", payload: "{}" }),
    (v) => typeof v.instanceId === "string" && Array.isArray(v.games),
  );
  assert(snapshot?.sessionId, "active game session missing");
  const history = find(
    await rpc("session/events", {
      request: {
        address: { kind: "session", sessionId: snapshot.sessionId },
        maxMessages: 50,
      },
    }),
    (v) => Array.isArray(v.records) && typeof v.cursor === "number",
  );
  assert(
    history?.records.length > 0,
    "native session/events did not return history",
  );
  assert(
    JSON.stringify(history.records).includes(marker),
    "native history lost the public chat trigger",
  );
  await page.getByRole("button", { name: "对战会话 ↗", exact: true }).click();
  await page.locator(".ag").waitFor({ state: "detached" });
  await page.waitForFunction(
    (tag) => document.body.innerText.includes(tag),
    marker,
    { timeout: 15000 },
  );
  const text = await page.locator("body").innerText();
  assert(
    !text.includes("历史加载失败") && !text.includes("载入历史…"),
    "native history page failed",
  );
  await page.screenshot({
    path: "output/playwright/session-history-0.2.0.png",
  });
  await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  await page.getByRole("button", { name: "对战会话 ↗", exact: true }).click();
  await page.waitForFunction(
    (tag) => document.body.innerText.includes(tag),
    marker,
    { timeout: 15000 },
  );
  assert(
    !(await page.locator("body").innerText()).includes("历史加载失败"),
    "reopen history failed",
  );
  return {
    nativeHistory: true,
    records: history.records.length,
    reload: true,
    sessionId: snapshot.sessionId,
  };
}
