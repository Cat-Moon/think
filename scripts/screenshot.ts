// 用本机 Chrome（无界面）打开图视图并截图，检查默认布局。截图保存在 runs/screenshots/（不进 git）。
// 用法：先用 scripts/seed-workspace.ts 生成工作区，用它启动服务端（THINK_PORT=5184）和 vite（THINK_WEB_PORT=5183 THINK_API_PORT=5184），
// 再 npx tsx scripts/screenshot.ts <工作区目录> [序号,…]（序号见 src/web/fixtures/real-graphs.json；demo 表示示例图）。THINK_UI 为界面地址
import { mkdirSync, readFileSync } from "node:fs";
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

const [wsDir, targetArg] = process.argv.slice(2);
if (!wsDir) throw new Error("用法：npx tsx scripts/screenshot.ts <工作区目录> [序号,…]");
const index = JSON.parse(readFileSync(join(wsDir, "seed-index.json"), "utf8")) as Record<string, string>;
const UI = process.env.THINK_UI ?? "http://localhost:5183";
const mapUrl = (t: string) => `${UI}/?map=${encodeURIComponent(index[t]!)}`;
const targets = (targetArg ?? "demo,1,3,5,9,11,15").split(",");
const out = join("runs", "screenshots");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const problems: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
const shot = async (name: string) => {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
};
const api = (method: string, path: string, body?: unknown) =>
  fetch(UI + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const openMap = async (t: string) => {
  // 默认布局：清空已保存的位置
  await api("PUT", `/api/maps/${encodeURIComponent(index[t]!)}/layout`, { positions: {} });
  await page.goto(mapUrl(t));
  await page.waitForSelector(".graph canvas");
  await page.waitForTimeout(900);
};

// 首页与首次启动的隐私说明
await api("PUT", "/api/settings", { privacy_notice_seen: false });
await page.goto(UI);
await page.waitForSelector(".modal");
await page.waitForTimeout(300);
await shot("m5-privacy");
await page.click("text=知道了");
await page.waitForTimeout(300);
await shot("m5-home");

for (const t of targets) {
  await openMap(t);
  await verifyGeometry(page, t, false);
  await shot(`layout-${t}`);
}

// 示例图：AI 的建议（含修改类建议）；悬停"修改"那一项
await openMap("demo");
await page.hover(".op-modify");
await page.waitForTimeout(300);
await shot("m5-demo-modify-hover");
// 拒绝一项：出现可跳过的理由输入框
await page.uncheck(".op >> nth=1 >> input[type=checkbox]");
await page.fill(".reject-reason", "远郊开发主要受房价驱动");
await shot("m5-demo-reject-reason");
await page.check(".op >> nth=1 >> input[type=checkbox]");

// 回路较多时：点击左上角的提示，显示全部回路标记
await page.click(".loop-hint");
await page.waitForTimeout(300);
await shot("layout-demo-all-loops");
await page.click(".loop-hint");

// 回路页、版本页
await page.click(".tabs button >> nth=1");
await page.hover(".loops li >> nth=1");
await page.waitForTimeout(300);
await shot("layout-demo-hover-loop");
await page.click(".tabs button >> nth=2");
await page.click(".timeline li >> nth=2");
await page.waitForTimeout(600);
await shot("m5-demo-view-old-version");

// 设置
await page.goto(mapUrl("demo"));
await page.waitForSelector(".graph canvas");
await page.click("header button[title=设置]");
await page.waitForTimeout(200);
await shot("m5-settings");

// 小窗口：图例完整可见；折叠后
await page.setViewportSize({ width: 900, height: 560 });
await page.goto(mapUrl("11"));
await page.waitForSelector(".graph canvas");
await page.waitForTimeout(900);
await shot("m5-small-window-legend");
const zoom = await page.evaluate(() => (window as unknown as { __cy: import("cytoscape").Core }).__cy.zoom());
console.log(`  小窗口：缩放 ${zoom.toFixed(2)}，变量名 ${(14 * zoom).toFixed(1)}px（应不小于 12px）`);
const box = await page.locator(".legend").boundingBox();
const vp = page.viewportSize()!;
console.log(`  图例：${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}，${box.y + box.height <= vp.height && box.x + box.width <= vp.width ? "完整可见" : "超出窗口"}` : "未找到"}`);
await page.click(".legend summary");
await page.waitForTimeout(200);
await shot("m5-small-window-legend-folded");
await page.click(".legend summary");

await browser.close();
console.log(problems.length ? `浏览器控制台问题：\n${problems.join("\n")}` : "浏览器控制台：没有错误或警告");
