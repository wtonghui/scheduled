/**
 * 有头（可视化）浏览器实操演示：窗口会弹出在桌面上，每步动作放慢便于观看。
 * 打开控制台 → token 登录 → 任务列表 → 新建任务 → 立即运行 → 执行历史。
 */
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3000";
const BOOT = "8ec894afa42c19855a4ba562432c50293374ed91529d900d";
const PAUSE = 1600; // 每步展示停留

const mint = await (
  await fetch(`${BASE}/api/v1/tokens`, {
    method: "POST",
    headers: { "x-api-token": BOOT, "content-type": "application/json" },
    body: JSON.stringify({ name: "live-demo", scopes: ["tasks:read", "tasks:write"] }),
  })
).json();
const TOKEN = mint.data.token;
console.log("UI token:", TOKEN.slice(0, 12) + "…");

const browser = await chromium.launch({ headless: false, slowMo: 260 }); // 有头 + 慢动作
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const step = async (msg) => {
  console.log("→", msg);
  await page.waitForTimeout(PAUSE);
};

// 1) 打开控制台，看到 token 登录门
await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: /Sign in/i }).waitFor({ timeout: 10000 });
await step("① 打开 http://localhost:3000 —— token 登录门");

// 2) 输入 token 登录
await page.locator('input[placeholder="sche-…"]').fill(TOKEN);
await step("② 输入 API token（sche-…）");
await page.getByRole("button", { name: "Enter console" }).click();
await page.getByRole("heading", { name: "Tasks" }).waitFor({ timeout: 10000 });
await step("③ 点击 Enter console —— 进入任务列表");

// 3) 新建任务
await page.getByRole("link", { name: "+ New task" }).click();
await page.waitForURL("**/tasks/new");
await step("④ 点 + New task 打开创建表单");
await page.locator('input[name="name"]').fill(`可视演示 ${new Date().toISOString().slice(11, 19)}`);
await page.locator('input[placeholder="*/5 * * * *"]').fill("*/1 * * * *");
await step("⑤ 填写 name + cron（每 1 分钟）");
await page.getByRole("button", { name: "Create task" }).click();
await page.waitForFunction(
  () => /^\/tasks\/[^/]+$/.test(location.pathname) && location.pathname !== "/tasks/new",
  undefined,
  { timeout: 10000 },
);
await step("⑥ Create task —— 跳到任务详情页");

// 4) 立即运行
await page.getByRole("button", { name: "run now" }).click();
await page.getByText("已触发").waitFor({ timeout: 8000 });
await step("⑦ 点 run now —— 触发一次手动执行");

// 5) 等 worker 执行后刷新历史，看到 succeeded
await step("⑧ 等待 worker 轮询领取执行（每 1.5s）");
for (let i = 0; i < 10; i++) {
  await page.reload();
  await page.waitForTimeout(1500);
  const rows = page.locator("table tbody tr");
  for (let r = 0; r < (await rows.count()); r++) {
    if ((await rows.nth(r).innerText()).includes("succeeded")) {
      await step(`⑨ 执行历史出现 succeeded —— worker 已跑通（第 ${i + 1} 次刷新）`);
      i = 99;
      break;
    }
  }
}

// 6) 回任务列表
await page.goto(`${BASE}/tasks`, { waitUntil: "networkidle" });
await step("⑩ 回到任务列表 —— 全部流程完成 ✔");

await browser.close();
console.log("done");