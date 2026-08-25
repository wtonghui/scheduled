/**
 * 浏览器实操演示脚本（Playwright chromium，无头）：
 * 打开控制台 → token 登录 → 任务列表 → 创建任务 → 立即运行 → 查看执行历史。
 * 每个步骤截图到 screenshots/。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3000";
const BOOT = "8ec894afa42c19855a4ba562432c50293374ed91529d900d";
const SHOT_DIR = "screenshots";
mkdirSync(SHOT_DIR, { recursive: true });

// 1) 用 bootstrap token 通过 API 签发一个日常 tasks token（UI 用它登录）
const mint = await fetch(`${BASE}/api/v1/tokens`, {
  method: "POST",
  headers: { "x-api-token": BOOT, "content-type": "application/json" },
  body: JSON.stringify({ name: "browser-demo", scopes: ["tasks:read", "tasks:write"] }),
});
const mintBody = await mint.json();
const TOKEN = mintBody.data.token;
console.log("minted UI token:", TOKEN.slice(0, 12) + "…");

const browser = await chromium.launch(); // headless
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const shot = async (name) => {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  console.log("📸", name);
};

// 2) 打开控制台：token 门
await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: /Sign in/i }).waitFor({ timeout: 10000 });
await shot("01-login-gate");

// 3) 输入 token 登录
await page.locator('input[placeholder="sche-…"]').fill(TOKEN);
await page.getByRole("button", { name: "Enter console" }).click();
await page.getByRole("heading", { name: "Tasks" }).waitFor({ timeout: 10000 });
console.log("✔ 登录成功，进入任务列表");
await shot("02-tasks-list");

// 4) 新建任务
await page.getByRole("link", { name: "+ New task" }).click();
await page.waitForURL("**/tasks/new");
await page.locator('input[name="name"]').fill(`浏览器演示 ${new Date().toISOString().slice(0, 19).replace("T", " ")}`);
await page.locator('input[placeholder="*/5 * * * *"]').fill("*/1 * * * *");
await page.getByRole("button", { name: "Create task" }).click();
// 精确等待跳转到 /tasks/<id>（注意 /tasks/new 也形似）
try {
  await page.waitForFunction(
    () => /^\/tasks\/[^/]+$/.test(new URL(location.href).pathname) && location.pathname !== "/tasks/new",
    undefined,
    { timeout: 10000 },
  );
} catch {
  const body = await page.locator("body").innerText();
  console.log("✘ 未能跳转，页面文本:\n", body.slice(0, 800));
  await shot("03-error");
  process.exit(1);
}
await page.getByText("payload", { exact: true }).waitFor({ timeout: 10000 });
console.log("✔ 任务已创建 ->", new URL(page.url()).pathname);
await shot("03-task-detail");

// 5) 立即运行（run-now）
await page.getByRole("button", { name: "run now" }).click();
await page.getByText("已触发").waitFor({ timeout: 8000 });
console.log("✔ 已触发 run-now");
await shot("04-run-now");

// 6) 等 worker 执行并轮询出 succeeded 记录（worker 每 2s 轮询）
let found = false;
for (let i = 0; i < 12; i++) {
  await page.reload();
  await page.waitForTimeout(2000);
  const rows = page.locator("table tbody tr");
  const count = await rows.count();
  for (let r = 0; r < count; r++) {
    const text = await rows.nth(r).innerText();
    if (text.includes("succeeded")) {
      found = true;
      break;
    }
  }
  if (found) break;
}
console.log(found ? "✔ 执行历史出现 succeeded（worker 运行成功）" : "✘ 未观测到 succeeded");
await shot("05-executions-history");

// 7) 回列表
await page.goto(`${BASE}/tasks`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await shot("06-task-list-final");

await browser.close();
console.log("done ✔");