// 用本机 Chrome（无界面）打开图视图并截图，检查默认布局。截图保存在 runs/screenshots/（不进 git）。
// 用法：先 npm run dev，再 npx tsx scripts/screenshot.ts [序号,…]（序号见 src/web/fixtures/real-graphs.json；demo 表示示例数据）
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const targets = (process.argv[2] ?? "demo,1,3,5,9,11,15").split(",");
const out = join("runs", "screenshots");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const problems: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));

for (const t of targets) {
  const url = t === "demo" ? "http://localhost:5173/?fresh" : `http://localhost:5173/?graph=${t}&fresh`;
  await page.goto(url);
  await page.waitForSelector(".graph canvas");
  await page.waitForTimeout(800);
  const file = join(out, `layout-${t}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}
// 悬停回路列表的第一项，检查回路标记的显示位置
await page.goto("http://localhost:5173/?fresh");
await page.waitForSelector(".loops li");
await page.waitForTimeout(500);
await page.hover(".loops li >> nth=1");
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, "layout-demo-hover-loop.png") });
console.log(join(out, "layout-demo-hover-loop.png"));

await browser.close();
console.log(problems.length ? `浏览器控制台问题：\n${problems.join("\n")}` : "浏览器控制台：没有错误或警告");
