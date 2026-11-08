// 界面端到端检查（不调用真实 AI）：
// 第一部分：新建 → 对话（思考中）→ 逐项处理（拒绝带理由）→ 直接编辑 → 取消与重试 → 失败提示 → 恢复版本 → 详情卡片自动关闭
// 第二部分（工作台）：多标签、切换后状态保留、并行上限与排队、按图独立取消、重命名、删除与撤销、侧栏子项、Ctrl+K、侧栏折叠
// 用法：
//   1. 服务端用 FakeProvider 和一个空的临时工作区启动：
//      THINK_WORKSPACE=<空目录> THINK_PORT=5184 THINK_FAKE=scripts/ui-check-fake.json npx tsx src/server/index.ts
//   2. THINK_WEB_PORT=5183 THINK_API_PORT=5184 npx vite
//   3. npx tsx scripts/ui-check.ts <同一个工作区目录>
// 截图保存在 runs/screenshots/ui-*.png；工作台的各个状态另存 1500×950 和 1100×640 两套（wb-*-1500.png / wb-*-1100.png）
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
    const cy = (document.querySelector(".tab-pane:not(.hidden) .graph") as unknown as { __cy: import("cytoscape").Core }).__cy;
    const n = cy.nodes("node.var").filter((x) => x.data("label") === l)[0];
    const rect = (document.querySelector(".tab-pane:not(.hidden) .graph") as HTMLElement).getBoundingClientRect();
    return n ? { x: rect.left + n.renderedPosition().x, y: rect.top + n.renderedPosition().y } : null;
  }, label);
  if (!r) throw new Error(`图上没有「${label}」`);
  return r;
}
const labels = () => page.evaluate(() => (document.querySelector(".tab-pane:not(.hidden) .graph") as unknown as { __cy: import("cytoscape").Core }).__cy.nodes("node.var").map((n) => n.data("label") as string));
/** 第一个图（拖延）的文件夹；新建后从地址栏取得 */
let A = "";
const mapDir = () => join(ws, "maps", A);
const P = ".tab-pane:not(.hidden)";
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// 首次启动：隐私说明
await page.goto(UI);
await page.waitForSelector(".modal");
check(await page.isVisible("text=对话会发给 Anthropic"), "首次启动显示隐私说明");
await page.click("text=知道了");
await page.waitForTimeout(500);
check(json(join(ws, "workspace.json")).privacy_notice_seen === true, "关闭隐私说明后写入 workspace.json");

// 新建
await page.fill(".new-map input", "为什么我总是拖延");
await page.click(".new-map button.primary");
await page.waitForSelector(".chat-input textarea");
check(page.url().includes("?map="), "新建后在标签页里打开这个图");
A = (await page.getAttribute(".tab.on", "data-map"))!;
check((await page.inputValue(".chat-input textarea")) === "为什么我总是拖延", "主题预填进输入框");

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
const btn = await page.locator(".patch-footer button.primary").boundingBox();
check(Boolean(btn && btn.y + btn.height <= 950), "接受按钮固定在可见区域底部");
check((await page.textContent(".card.patch"))?.includes("你拖延的时候，更常见的感受") ?? false, "AI 的问题显示在建议卡片里");

// 逐项处理：拒绝"任务难度 → 焦虑程度"，写理由
await page.uncheck(".op >> nth=5 >> input[type=checkbox]");
await page.fill(".reject-reason", "任务难度不是主因");
await page.click("text=接受选中的");
await page.waitForFunction(() => !document.querySelector(".card.patch"));
const p1 = json(join(mapDir(), "patches", "p001.json"));
check(p1.resolution?.decisions?.[5]?.reason === "任务难度不是主因", "拒绝理由保存在补丁记录里");

// 直接编辑：双击空白处新增变量
const g = (await page.locator(`${P} .graph`).boundingBox())!;
await page.mouse.dblclick(g.x + 120, g.y + g.height - 220);
await page.fill(".new-node input", "睡眠质量");
await page.keyboard.press("Enter");
await page.waitForFunction(() => (document.querySelector(".tab-pane:not(.hidden) .graph") as unknown as { __cy: import("cytoscape").Core }).__cy.nodes("node.var").some((n) => n.data("label") === "睡眠质量"));
await page.waitForTimeout(600);
const v2 = json(join(mapDir(), "versions", "v002.json"));
const sleep = v2.graph.nodes.find((n: { label: string }) => n.label === "睡眠质量");
const p2 = json(join(mapDir(), "patches", "p002.json"));
check(sleep?.origin === "user" && p2.origin === "user" && p2.resolution?.result_version === "v002", "新增变量走补丁（origin: user，自动接受）");
check(Boolean(json(join(mapDir(), "layout.json")).positions[sleep?.id]), "新变量的位置写入 layout.json");
const before = json(join(mapDir(), "layout.json")).positions;

// 连线模式：睡眠质量 → 焦虑程度，连好后直接选极性（只产生一个版本）
await page.click(".map-toolbar >> text=连线");
let a = await nodeAt(page, "睡眠质量");
await page.mouse.click(a.x, a.y);
a = await nodeAt(page, "焦虑程度");
await page.mouse.click(a.x, a.y);
await page.waitForSelector(".new-edge");
await shot("connect");
await page.click(".new-edge >> text=−");
await page.waitForSelector("text=极性相反");
const v3 = json(join(mapDir(), "versions", "v003.json"));
const newEdge = v3.graph.edges.find((e: { from: string }) => e.from === sleep.id);
check(newEdge?.polarity === "-" && newEdge?.origin === "user", "连线时直接选极性 −");
check(readdirSync(join(mapDir(), "versions")).length === 4, "连线只产生一个版本");
await page.click(".map-toolbar >> text=退出连线");
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
const lastPatch = json(join(mapDir(), "patches", "p005.json"));
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
check((await page.textContent(".msg.error"))?.includes("重置") ?? false, "额度用完时显示重置时间");
await page.click(".msg.error >> text=放弃这条消息");
await page.waitForSelector(".msg.user.abandoned");
check((await page.inputValue(".chat-input textarea")) === "还有什么遗漏？", "放弃后消息放回输入框，可以改写重发");
check(!(await page.isVisible(".msg.error")), "放弃后不再卡在重试");
await shot("abandoned");

// 版本：回看 v001（只读），恢复（产生新版本）
await page.click(".views >> text=版本");
await page.click(".timeline li >> text=v001");
await page.waitForSelector("text=正在查看 v001");
await page.click("text=恢复到这个版本");
await page.click("text=确认恢复");
await page.waitForTimeout(800);
const versions = readdirSync(join(mapDir(), "versions")).sort();
const restored = json(join(mapDir(), "versions", versions.at(-1)!));
check(restored.restored_from === "v001" && versions.length === 7, `恢复产生新版本 ${restored.version}（历史共 ${versions.length} 个版本）`);
await page.click(".views >> text=笔记");
await page.fill(".notes textarea", "先观察一周");
await page.waitForTimeout(1500);
check(readFileSync(join(mapDir(), "notes.md"), "utf8") === "先观察一周", "笔记自动保存");
await shot("versions");

// ---------- 详情卡片自动关闭：被拒绝、切换到历史版本、关掉"显示已拒绝的" ----------
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cardShown = () => page.isVisible(`${P} .aside-scroll > .card:not(.patch)`);
/** 在当前画布上"点击"一个元素（用 Cytoscape 的 tap 事件，不依赖坐标） */
const tapEl = (id: string) =>
  page.evaluate((i) => (document.querySelector(".tab-pane:not(.hidden) .graph") as unknown as { __cy: import("cytoscape").Core }).__cy.getElementById(i).emit("tap"), id);
const idOf = (label: string) =>
  page.evaluate((l) => (document.querySelector(".tab-pane:not(.hidden) .graph") as unknown as { __cy: import("cytoscape").Core }).__cy.nodes("node.var").filter((n) => n.data("label") === l)[0]?.id(), label);

await page.click(`${P} .views >> text=图`);
const liveEdge = json(join(mapDir(), "graph.json")).edges.find((e: { status: string }) => e.status === "accepted")!;
await tapEl(liveEdge.id);
await page.waitForTimeout(300);
const openedCard = await cardShown();
await page.click(`${P} .card >> text=不同意`);
await page.click(`${P} .card >> text=确认不同意`);
await page.waitForTimeout(800);
check(openedCard && !(await cardShown()), "详情卡片：选中的关系被拒绝后自动关闭");

const g2 = (await page.locator(`${P} .graph`).boundingBox())!;
await page.mouse.dblclick(g2.x + 160, g2.y + 140);
await page.fill(".new-node input", "测试变量");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
await tapEl((await idOf("测试变量"))!);
await page.waitForTimeout(300);
const openedCard2 = await cardShown();
await page.click(`${P} .views >> text=版本`);
await page.click(`${P} .timeline li:has(b:text-is("v001"))`);
await page.waitForSelector(`${P} >> text=正在查看 v001`);
await page.waitForTimeout(300);
check(openedCard2 && !(await cardShown()), "详情卡片：切换到没有这个变量的历史版本后自动关闭");
await page.click(`${P} .map-toolbar >> text=回到当前`);

await page.check(`${P} .map-toolbar input[type=checkbox]`);
await page.waitForTimeout(500);
const rejectedNode = json(join(mapDir(), "graph.json")).nodes.find((n: { status: string }) => n.status === "rejected")!;
await tapEl(rejectedNode.id);
await page.waitForTimeout(300);
const openedCard3 = await cardShown();
await page.uncheck(`${P} .map-toolbar input[type=checkbox]`);
await page.waitForTimeout(500);
check(openedCard3 && !(await cardShown()), `详情卡片：关掉"显示已拒绝的"后，已拒绝的变量（${rejectedNode.label}）的卡片自动关闭`);

// ---------- 工作台 ----------
/** 同一个状态截两套：1500×950 和 1100×640 */
const wbShot = async (name: string) => {
  await page.screenshot({ path: join(out, `wb-${name}-1500.png`) });
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `wb-${name}-1100.png`) });
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.waitForTimeout(300);
};
const jobsNow = async () => (await (await fetch(`${UI}/api/jobs`)).json()) as Record<string, { state: string; error?: { kind: string } }>;
const tab = (name: string) => page.click(`.tab[data-map="${name}"] .tab-main`);
const send = async (name: string, text: string) => {
  await tab(name);
  await page.click(`${P} .views >> text=对话`);
  await page.fill(`${P} .chat-input textarea`, text);
  await page.click(`${P} .chat-input button.primary`);
  await page.waitForTimeout(250);
};
const turnsOf = (name: string) => readFileSync(join(ws, "maps", name, "conversation.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { role: string; text: string });

const created: string[] = [];
for (const t of ["交通为什么越来越堵", "为什么选举越来越极化", "房价为什么一直涨"]) {
  await page.fill(".new-map input", t);
  await page.click(".new-map button.primary");
  await page.waitForFunction((x) => document.querySelector(".tab.on .t")?.textContent === x, t);
  created.push((await page.getAttribute(".tab.on", "data-map"))!); // 地址栏在渲染之后才更新，以标签为准
}
const [B, C, D] = created as [string, string, string];
check((await page.locator(".tab").count()) === 4, "多个图同时打开为标签页");
check((await page.inputValue(`${P} .chat-input textarea`)) === "房价为什么一直涨", "侧栏新建：主题预填进输入框");
await wbShot("overview");

// 三个图同时请 AI：最多 2 个同时思考，第 3 个排队
await send(B, "交通为什么越来越堵");
await send(C, "为什么选举越来越极化");
await send(D, "房价为什么一直涨");
await page.waitForTimeout(400);
let jobs = await jobsNow();
check(jobs[B]?.state === "running" && jobs[C]?.state === "running" && jobs[D]?.state === "queued", `全局最多 2 个同时思考，第 3 个排队（${[B, C, D].map((n) => jobs[n]?.state).join(" / ")}）`);
check((await page.textContent(`${P} .msg.thinking.queued`))?.includes("排队中") ?? false, "排队中的图显示\"排队中\"");
check(
  (await page.isVisible(`.map-item[data-map="${D}"] .dot-queued`)) && (await page.isVisible(`.map-item[data-map="${B}"] .dot-running`)) && (await page.isVisible(`.tab[data-map="${C}"] .dot-running`)),
  "侧栏和标签上的状态点：思考中 / 排队中",
);
await wbShot("queued");

// 切到别的图再回来：进度还在，没有重复发送
await tab(B);
await page.waitForSelector(`${P} .msg.thinking`);
const t1 = (await page.textContent(`${P} .msg.thinking`))!.replace(/\s+/g, " ");
await tab(C);
await page.waitForTimeout(1500);
await tab(B);
const t2 = (await page.textContent(`${P} .msg.thinking`))!.replace(/\s+/g, " ");
check(t1 !== t2 && /思考中|正在写/.test(t2), `切回来进度还在并继续：「${t1.slice(0, 24)}」→「${t2.slice(0, 24)}」`);
check((await page.locator(`${P} .msg.user`).count()) === 1, "切换标签不会重复发送");
await wbShot("thinking");

for (let i = 0; i < 80 && Object.keys(await jobsNow()).length; i++) await wait(250);
check(
  [B, C, D].every((n) => JSON.stringify(turnsOf(n).map((t) => t.role)) === JSON.stringify(["user", "ai"])),
  "三个图都得到回复，排队的那个在前面结束后接着执行",
);
await page.waitForTimeout(500);
check(await page.isVisible(`.map-item[data-map="${D}"] .dot-idle`), "回复后状态点变为空闲");

// 按图独立取消、放弃
await send(B, "再想想交通");
await send(C, "再想想选举");
await page.waitForTimeout(300);
await tab(B);
await page.click(`${P} .msg.thinking .cancel`);
await page.waitForTimeout(800);
jobs = await jobsNow();
check(jobs[B]?.error?.kind === "cancelled" && jobs[C]?.state === "running", "取消一个图不影响另一个图");
check(await page.isVisible(`.map-item[data-map="${B}"] .dot-failed`), "取消后状态点为\"上次失败\"");
await page.click(`${P} .msg.error >> text=放弃这条消息`);
await page.waitForTimeout(500);
check((await jobsNow())[C]?.state === "running", "放弃一个图的消息不影响另一个图");
await tab(C);
await page.click(`${P} .msg.thinking .cancel`);
await page.waitForTimeout(500);
await page.click(`${P} .msg.error >> text=放弃这条消息`);
await page.waitForTimeout(500);

// 重命名
await page.hover(`.map-item[data-map="${D}"] .map-row`);
await page.click(`.map-item[data-map="${D}"] button[title=重命名]`);
await page.fill(".rename-input", "一线城市房价");
await page.keyboard.press("Enter");
await page.waitForTimeout(600);
check(
  (await page.textContent(`.tab[data-map="${D}"] .t`)) === "一线城市房价" && json(join(ws, "maps", D, "map.json")).title === "一线城市房价",
  "重命名（标签和 map.json 的标题都更新，文件夹名不变）",
);

// 删除与撤销
await page.hover(`.map-item[data-map="${C}"] .map-row`);
await page.click(`.map-item[data-map="${C}"] button[title^=删除]`);
await page.waitForSelector(".toast");
const trashed = readdirSync(join(ws, ".trash"));
check(!readdirSync(join(ws, "maps")).includes(C) && trashed.some((e) => e.endsWith(`__${C}`)), "删除：文件夹移到 .trash/，没有直接删掉");
check((await page.locator(`.tab[data-map="${C}"]`).count()) === 0, "删除后关闭它的标签");
await wbShot("deleted");
await page.click(".toast >> text=撤销");
await page.waitForTimeout(800);
check(readdirSync(join(ws, "maps")).includes(C) && readdirSync(join(ws, ".trash")).length === 0 && (await page.isVisible(`.map-item[data-map="${C}"]`)), "撤销：移回 maps/，重新出现在列表里");
await page.hover(`.map-item[data-map="${C}"] .map-row`);
await page.click(`.map-item[data-map="${C}"] button[title^=删除]`);
await page.waitForTimeout(600);
await page.click(".trash-toggle");
check((await page.locator(".trash li").count()) === 1, "回收站列出删除的图");
await wbShot("trash");

// 侧栏子项：展开成 图 / 对话 / 回路 / 版本 / 笔记
await page.click(`.map-item[data-map="${B}"] .chev`);
await page.click(`.map-item[data-map="${B}"] .sub-items >> text=回路`);
await page.waitForTimeout(300);
check(
  page.url().includes(encodeURIComponent(B)) && ((await page.textContent(`${P} .views button.on`)) ?? "").startsWith("回路") && (await page.isVisible(`.map-item[data-map="${B}"] .sub-items button.on`)),
  "侧栏子项切换到对应视图",
);
await wbShot("subitems");

// Ctrl+K：按标题搜索并打开；或直接新建
await tab(A);
await page.keyboard.press("Control+k");
await page.waitForSelector(".palette");
await page.keyboard.type("交通");
check((await page.locator(".palette li").count()) === 2, "Ctrl+K 按标题过滤（1 个图 + 新建）");
await wbShot("palette");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check(page.url().includes(encodeURIComponent(B)) && !(await page.isVisible(".palette")), "Ctrl+K 回车打开选中的图");
await page.keyboard.press("Control+k");
await page.keyboard.type("睡眠和情绪");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector(".tab.on .t")?.textContent === "睡眠和情绪");
check(true, "Ctrl+K 直接新建");

// 侧栏折叠
await page.click(".side-toggle");
await page.waitForTimeout(300);
check(!(await page.isVisible(".sidebar")), "侧栏可以折叠");
await wbShot("collapsed");
await page.click(".side-toggle");
const small = await browser.newPage({ viewport: { width: 1000, height: 640 } });
await small.goto(UI);
await small.waitForSelector(".topbar");
await small.waitForTimeout(800);
const collapsed = !(await small.isVisible(".sidebar"));
await small.click(".side-toggle");
check(collapsed && (await small.isVisible(".sidebar")), "窗口窄于 1100 时侧栏默认折叠，可以展开");
await small.close();

await browser.close();
console.log(results.join("\n"));
console.log(problems.length ? `浏览器控制台问题：\n${problems.join("\n")}` : "浏览器控制台：没有错误或警告");
