async function checkCompanionLayout(page) {
  if (!(await page.locator(".ag").count()))
    await page.getByRole("button", { name: "AgentGamer", exact: true }).click();
  if (await page.getByLabel("收起聊天").count())
    await page.getByLabel("收起聊天").click();
  const back = page.getByRole("button", { name: /^(← )?返回大厅$/ }).first();
  if (await back.count()) {
    await back.click();
    await page
      .getByRole("button", { name: "结束并返回大厅", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "我的桌宠", exact: true }).click();
  await page.getByRole("button", { name: "刷新桌宠", exact: true }).click();
  await page.getByLabel("选择桌宠", { exact: true }).selectOption({ index: 2 });
  await page.getByLabel("显示设置").click();
  await page.getByLabel("字号", { exact: true }).selectOption("125");
  await page.getByLabel("关闭弹窗").click();
  await page.getByRole("button", { name: "预览接入资料", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "伙伴接入资料" });
  await dialog.waitFor();
  const sizes = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 960, height: 640 },
  ];
  for (const size of sizes) {
    await page.setViewportSize(size);
    const box = await dialog.boundingBox();
    if (
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > size.width + 1 ||
      box.y + box.height > size.height + 1
    )
      throw Error("companion modal escaped viewport");
    const geometry = await dialog.evaluate((e) => {
      const textarea = e.querySelector("textarea");
      const label = textarea.parentElement;
      return {
        overflow: e.scrollWidth > e.clientWidth + 1,
        input: textarea.clientWidth,
        label: label.clientWidth,
      };
    });
    if (geometry.overflow || geometry.input < geometry.label - 3)
      throw Error("persona width is constrained");
    await dialog.evaluate((e) => {
      e.scrollTop = 0;
    });
    await page.screenshot({
      path: `output/playwright/pet-long-preview-${size.width}-125.png`,
    });
    await page
      .getByRole("button", { name: "完成预览", exact: true })
      .scrollIntoViewIfNeeded();
  }
  await page.getByLabel("关闭伙伴预览").click();
  // Recover persisted confirmations after the isolated Host restart; this must not POST.
  const taskList = page.locator(".ag-reports > details");
  if ((await taskList.getAttribute("open")) === null)
    await page.getByText(/战报任务（/).click();
  const check = page.getByRole("button", { name: "核对桌宠记录", exact: true });
  if (await check.count()) await check.first().click();
  await page.getByText("已写入桌宠聊天记忆", { exact: true }).first().waitFor();
  await page
    .locator(".ag-report")
    .filter({ hasText: "已写入桌宠聊天记忆" })
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "output/playwright/pet-report-confirmed-960-125.png",
  });
  return {
    modalScroll: true,
    fullWidthPersona: true,
    longNickname: true,
    sizes: sizes.map((s) => s.width),
    persistedReportVisible: true,
    recoveredUnknownReceipt: true,
  };
}
