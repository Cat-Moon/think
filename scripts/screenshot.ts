// 用本机 Chrome（无界面）打开图视图并截图，检查默认布局。截图保存在 runs/screenshots/（不进 git）。
// 用法：先 npm run dev，再 npx tsx scripts/screenshot.ts [序号,…]（序号见 src/web/fixtures/real-graphs.json；demo 表示示例数据）
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { NODE_H } from "../src/web/layout";
import { controlPoint, edgePath, pointAt } from "../src/web/routing";

/** 核对浏览器里 Cytoscape 实际的控制点与 routing.ts 的计算是否一致（同时打印标签相关字段，便于核对标签位置） */
async function verifyGeometry(page: import("playwright-core").Page, name: string, probe: boolean) {
  const edges = await page.evaluate(() => {
    const cy = (window as unknown as { __cy: import("cytoscape").Core }).__cy;
    return cy.edges().map((e) => {
      const rs = (e as unknown as { _private: { rscratch: Record<string, unknown> } })._private.rscratch;
      return {
        id: e.id(),
        d: e.data("cpd") as number,
        lo: e.data("lo") as number,
        a: e.source().position(),
        b: e.target().position(),
        wa: e.source().data("w") as number,
        wb: e.target().data("w") as number,
        cp: e.controlPoints() as { x: number; y: number }[] | undefined,
        label: Object.fromEntries(Object.entries(rs).filter(([k]) => /label/i.test(k) && typeof rs[k] !== "object")),
      };
    });
  });
  let worstCp = 0;
  let worstLabel = 0;
  const off: string[] = [];
  for (const e of edges) {
    if (e.cp?.length) {
      const mine = controlPoint({ ...e.a, w: e.wa, h: NODE_H }, { ...e.b, w: e.wb, h: NODE_H }, e.d);
      const dev = Math.hypot(mine.x - e.cp[0]!.x, mine.y - e.cp[0]!.y);
      worstCp = Math.max(worstCp, dev);
      if (dev > 2) off.push(`${e.id} 控制点偏差 ${dev.toFixed(1)}（d=${e.d}）`);
    }
    const lx = e.label.sourceLabelX as number | undefined;
    const ly = e.label.sourceLabelY as number | undefined;
    if (lx !== undefined && ly !== undefined) {
      const path = edgePath({ ...e.a, w: e.wa, h: NODE_H }, { ...e.b, w: e.wb, h: NODE_H }, e.d);
      const mine = pointAt(path, e.lo);
      const dev = Math.hypot(mine.x - lx, mine.y - ly);
      worstLabel = Math.max(worstLabel, dev);
      if (dev > 6) off.push(`${e.id} 标签偏差 ${dev.toFixed(1)}（lo=${e.lo}）`);
    }
  }
  console.log(`  ${name}：${edges.length} 条边；控制点最大偏差 ${worstCp.toFixed(1)}px，标签最大偏差 ${worstLabel.toFixed(1)}px${off.length ? `；${off.join("；")}` : ""}`);
  if (probe) console.log("  标签字段示例：", JSON.stringify(edges.find((e) => e.d !== 0) ?? edges[0])?.slice(0, 900));
}

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
  await verifyGeometry(page, t, t === targets[0]);
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

// 回路较多时：点击左上角的提示，显示全部回路标记
await page.goto("http://localhost:5173/?fresh");
await page.waitForSelector(".loop-hint");
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, "layout-demo-loop-hint.png") });
await page.click(".loop-hint");
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, "layout-demo-all-loops.png") });
console.log(join(out, "layout-demo-loop-hint.png"), join(out, "layout-demo-all-loops.png"));
// 设置：预览中提示新回路（默认关闭，打开后预览面板显示）
await page.check("text=预览中提示新回路");
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, "layout-demo-new-loops-on.png") });
await page.uncheck("text=预览中提示新回路");
console.log(join(out, "layout-demo-new-loops-on.png"));

await browser.close();
console.log(problems.length ? `浏览器控制台问题：\n${problems.join("\n")}` : "浏览器控制台：没有错误或警告");
