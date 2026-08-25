import { expect, test } from "@playwright/test";

/**
 * E2E 冒烟（T039，quickstart §7）：需 web(3000) + worker 运行。
 * 流程：匿名进入任务列表 → 顶部 token 登录 → 新建任务（自然语言快捷解析）→ 列表可见。
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.E2E_API_TOKEN ?? "";

test("topbar rejects a bad token", async ({ page }) => {
  await page.goto(BASE_URL);
  await expect(page.getByRole("heading", { name: "任务" })).toBeVisible();

  await page.getByPlaceholder("token 登录（可选）").fill("sche-bad-token");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "无效" })).toBeVisible({
    timeout: 5000,
  });
});

test("creates a task and sees it in the list", async ({ page }) => {
  test.skip(!TOKEN, "E2E_API_TOKEN 未设置：跳过（用 bootstrap 生成后设置）");
  await page.goto(BASE_URL);

  // 顶部登录
  await page.getByPlaceholder("token 登录（可选）").fill(TOKEN);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "任务" })).toBeVisible({ timeout: 5000 });

  // 新建任务：自然语言快捷解析 + 名称
  await page.getByRole("link", { name: "新建任务" }).click();
  await expect(page.getByRole("heading", { name: "新建任务" })).toBeVisible();

  await page.getByPlaceholder(/快捷输入/).fill("每1分钟");
  await page.getByRole("button", { name: "解析" }).click();
  await page.getByPlaceholder("例如：每日健康检查").fill("e2e smoke");
  await page.getByRole("button", { name: "创建任务" }).click();

  // 创建成功进入详情页
  await expect(page.getByRole("heading", { name: "配置 payload" })).toBeVisible({ timeout: 5000 });
  await page.goto(`${BASE_URL}/tasks`);
  await expect(page.getByRole("link", { name: "e2e smoke" }).first()).toBeVisible();
});
