// 界面端到端检查（不调用真实 AI）：新建 → 对话（思考中）→ 逐项处理（拒绝带理由）→ 直接编辑 → 取消与重试 → 失败提示 → 恢复版本。
// 用法：
//   1. 服务端用 FakeProvider 和一个空的临时工作区启动：
//      THINK_WORKSPACE=<空目录> THINK_PORT=5184 THINK_FAKE=scripts/ui-check-fake.json npx tsx src/server/index.ts
//   2. THINK_WEB_PORT=5183 THINK_API_PORT=5184 npx vite
//   3. npx tsx scripts/ui-check.ts <同一个工作区目录>
// 截图保存在 runs/screenshots/ui-*.png
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const ws = process.argv[2];
if (!ws) throw new Error("用法：npx tsx scripts/ui-check.ts <工作区目录>");
const UI = process.env.THINK_UI ?? "http://localhost:5183";
const out = join("runs", "screenshots");
const results: string[] = [];
const check = (ok: boolean, what: string) => {
  results.push(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) console.error(`✗ ${what}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const problems: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
const shot = async (name: string) => page.screenshot({ path: join(out, `ui-${name}.png`) });

/** 画布上某个变量的屏幕坐标 */
async function nodeAt(p: Page, label: string) {
  const r = await p.evaluate((l) => {
    const cy = (window as unknown as { __cy: import("cytoscape").Core }).__cy;
    const n = cy.nodes("node.var").filter((x) => x.data("label") === l)[0];
    const rect = (document.querySelector(".graph") as HTMLElement).getBoundingClientRect();
    return n ? { x: rect.left + n.renderedPosition().x, y: rect.top + n.renderedPosition().y } : null;
  }, label);
  if (!r) throw new Error(`图上没有「${label}」`);
  return r;
}
const labels = () => page.evaluate(() => (window as unknown as { __cy: import("cytoscape").Core }).__cy.nodes("node.var").map((n) => n.data("label") as string));
const mapDir = () => join(ws, "maps", readdirSync(join(ws, "maps"))[0]!);
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// 首次启动：隐私说明
await page.goto(UI);
await page.waitForSelector(".modal");
check(await page.isVisible("text=对话会发给 Anthropic"), "首次启动显示隐私说明");
await page.click("text=知道了");
await page.waitForTimeout(500);
check(json(join(ws, "workspace.json")).privacy_notice_seen === true, "关闭隐私说明后写入 workspace.json");

// 新建
await page.fill(".home input", "为什么我总是拖延");
await page.click(".home button.primary");
await page.waitForSelector(".chat-input textarea");
check(page.url().includes("?map="), "新建后打开这个 Map");

// 对话：思考中（流式进度）
await page.fill(".chat-input textarea", "为什么我总是拖延");
await page.click(".chat-input button");
await page.waitForSelector(".msg.thinking");
await page.waitForTimeout(1800);
const thinking = await page.textContent(".msg.thinking");
check(/思考中|正在写/.test(thinking ?? ""), `显示进度：${thinking?.replace(/\s+/g, " ").trim()}`);
await shot("thinking");
await page.waitForSelector(".card.patch", { timeout: 15000 });
await page.waitForTimeout(800);
await shot("patch");

// 逐项处理：拒绝"任务难度 → 焦虑程度"，写理由
await page.uncheck(".op >> nth=5 >> input[type=checkbox]");
await page.fill(".reject-reason", "任务难度不是主因");
await page.click("text=接受选中的");
await page.waitForFunction(() => !document.querySelector(".card.patch"));
const p1 = json(join(mapDir(), "patches", "p001.json"));
check(p1.resolution?.decisions?.[5]?.reason === "任务难度不是主因", "拒绝理由保存在补丁记录里");

// 直接编辑：双击空白处新增变量
const g = (await page.locator(".graph").boundingBox())!;
await page.mouse.dblclick(g.x + 120, g.y + g.height - 220);
await page.fill(".new-node input", "睡眠质量");
await page.keyboard.press("Enter");
await page.waitForFunction(() => (window as unknown as { __cy: import("cytoscape").Core }).__cy.nodes("node.var").some((n) => n.data("label") === "睡眠质量"));
await page.waitForTimeout(600);
const v2 = json(join(mapDir(), "versions", "v002.json"));
const sleep = v2.graph.nodes.find((n: { label: string }) => n.label === "睡眠质量");
const p2 = json(join(mapDir(), "patches", "p002.json"));
check(sleep?.origin === "user" && p2.origin === "user" && p2.resolution?.result_version === "v002", "新增变量走补丁（origin: user，自动接受）");
check(Boolean(json(join(mapDir(), "layout.json")).positions[sleep?.id]), "新变量的位置写入 layout.json");
const before = json(join(mapDir(), "layout.json")).positions;

// 连线模式：睡眠质量 → 焦虑程度，极性默认 ?，之后改成 −
await page.click("header >> text=连线");
let a = await nodeAt(page, "睡眠质量");
await page.mouse.click(a.x, a.y);
a = await nodeAt(page, "焦虑程度");
await page.mouse.click(a.x, a.y);
await page.waitForSelector("text=极性定为 −");
await shot("connect");
const v3 = json(join(mapDir(), "versions", "v003.json"));
const newEdge = v3.graph.edges.find((e: { from: string }) => e.from === sleep.id);
check(newEdge?.polarity === "?" && newEdge?.origin === "user", "连线新增关系，极性默认 ?");
await page.click("text=极性定为 −");
await page.waitForTimeout(500);
check(json(join(mapDir(), "versions", "v004.json")).graph.edges.find((e: { id: string }) => e.id === newEdge.id)?.polarity === "-", "之后可以改极性");
await page.click("header >> text=退出连线");
const after = json(join(mapDir(), "layout.json")).positions;
check(
  Object.entries(before).every(([id, p]) => JSON.stringify(after[id]) === JSON.stringify(p)),
  "新增关系后已有变量的位置不变",
);

// 重命名、删除（等同拒绝）
a = await nodeAt(page, "睡眠质量");
await page.mouse.click(a.x, a.y);
await page.click("text=重命名");
await page.fill(".card .reason input", "睡眠不足");
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
check((await labels()).includes("睡眠不足"), "重命名");
a = await nodeAt(page, "任务难度");
await page.mouse.click(a.x, a.y);
await page.click(".card >> text=删除");
await page.fill(".card .reason input", "暂时不考虑");
await page.click("text=确认删除");
await page.waitForTimeout(500);
check(!(await labels()).includes("任务难度"), "删除变量（图上不再显示）");
const lastPatch = json(join(mapDir(), "patches", "p006.json"));
check(lastPatch.origin === "user" && lastPatch.ops[0].op === "remove_node" && lastPatch.ops[0].reason === "暂时不考虑", "删除走补丁（remove_node，带理由）");

// 取消：消息已保存，可以重试
await page.fill(".chat-input textarea", "为什么焦虑会导致回避？");
await page.click(".chat-input button");
await page.waitForSelector(".msg.thinking");
await page.waitForTimeout(800);
await page.click(".msg.thinking .cancel");
await page.waitForSelector("text=你的消息已保存");
await shot("cancelled");
check(true, "取消后显示\"你的消息已保存 · 重试\"");
await page.click(".msg.error >> text=重试");
await page.waitForSelector("text=回避能暂时减轻焦虑", { timeout: 15000 });
const log = readFileSync(join(mapDir(), "logs", "provider.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check(log.at(-1).prompt.includes("任务难度不是主因") || log.at(-1).prompt.includes("暂时不考虑"), "拒绝理由发给了 AI");
const turns = readFileSync(join(mapDir(), "conversation.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check(turns.filter((t: { text: string }) => t.text === "为什么焦虑会导致回避？").length === 1, "重试没有重复保存用户消息");

// 失败：显示原因，消息已保存，可以重试
await page.fill(".chat-input textarea", "还有什么遗漏？");
await page.click(".chat-input button");
await page.waitForSelector(".msg.error");
await shot("error");
check((await page.textContent(".msg.error"))?.includes("额度") ?? false, "失败时显示原因");
check(await page.isVisible(".msg.error >> text=重试"), "失败后可以重试，输入不丢");

// 版本：回看 v001（只读），恢复（产生新版本）
await page.click(".tabs >> text=版本与笔记");
await page.click(".timeline li >> text=v001");
await page.waitForSelector("text=正在查看 v001");
await page.click("text=恢复到这个版本");
await page.click("text=确认恢复");
await page.waitForTimeout(800);
const versions = readdirSync(join(mapDir(), "versions")).sort();
const restored = json(join(mapDir(), "versions", versions.at(-1)!));
check(restored.restored_from === "v001" && versions.length === 8, `恢复产生新版本 ${restored.version}（历史共 ${versions.length} 个版本）`);
await page.fill(".notes textarea", "先观察一周");
await page.waitForTimeout(1500);
check(readFileSync(join(mapDir(), "notes.md"), "utf8") === "先观察一周", "笔记自动保存");
await shot("versions");

await browser.close();
console.log(results.join("\n"));
console.log(problems.length ? `浏览器控制台问题：\n${problems.join("\n")}` : "浏览器控制台：没有错误或警告");
