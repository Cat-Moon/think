// 把两次回归运行的种子图和"补充"轮次并排放在一起，便于比较覆盖面和理由深度（不调用 AI）。
// 用法：npx tsx scripts/compare-runs.ts <运行A目录> <运行B目录> <A的名字> <B的名字> [主题,…] [每个主题最多几次]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opReason, renderOps } from "../src/core/describe";
import type { Patch, Version } from "../src/core/schema";

const [dirA, dirB, nameA = "A", nameB = "B", topicArg, maxArg] = process.argv.slice(2);
const topics = topicArg ? topicArg.split(",") : null;
const max = Number(maxArg ?? 2);

interface SessionData {
  name: string;
  patches: Patch[];
  versions: Map<string, Version>;
  turns: { role: string; text: string; question?: string; patch_id?: string }[];
}

function load(runDir: string): Map<string, SessionData[]> {
  const ws = join(runDir, "workspace");
  const byTopic = new Map<string, SessionData[]>();
  for (const s of readdirSync(ws).sort()) {
    const topic = s.replace(/-\d+$/, "");
    if (topics && !topics.includes(topic)) continue;
    const maps = join(ws, s, "maps");
    if (!existsSync(maps)) continue;
    const dir = join(maps, readdirSync(maps)[0]!);
    const read = (sub: string) => readdirSync(join(dir, sub)).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), "utf8")));
    const versions = new Map((read("versions") as Version[]).map((v) => [v.version, v]));
    const turns = readFileSync(join(dir, "conversation.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const list = byTopic.get(topic) ?? [];
    if (list.length < max) list.push({ name: s, patches: read("patches"), versions, turns });
    byTopic.set(topic, list);
  }
  return byTopic;
}

function metrics(d: SessionData) {
  const ops = d.patches.flatMap((p) => p.ops);
  const reasons = ops.map(opReason).filter(Boolean);
  return {
    seedNodes: d.patches[0]?.ops.filter((o) => o.op === "add_node").length ?? 0,
    nodes: ops.filter((o) => o.op === "add_node").length,
    edges: ops.filter((o) => o.op === "add_edge").length,
    avgReason: reasons.length ? Math.round(reasons.reduce((n, r) => n + r.length, 0) / reasons.length) : 0,
    alternatives: reasons.filter((r) => /另一种|也有人|另一些|也可能|反过来/.test(r)).length,
    contested: ops.filter((o) => (o.op === "add_edge" || o.op === "update_edge") && o.contested).length,
  };
}

function renderSession(d: SessionData): string[] {
  const out: string[] = [`**${d.name}**`, ""];
  d.patches.forEach((p, i) => {
    const label = i === 0 ? "种子图" : `第 ${i + 1} 个补丁（补充）`;
    const turn = d.turns.find((t) => t.patch_id === p.patch_id);
    const before = d.versions.get(p.base_version)!.graph;
    out.push(`*${label}*：${turn?.text ?? p.message}`, "", "```", renderOps(p.ops, before, p.resolution?.decisions), "```", `问题：${p.question}`, "");
  });
  return out;
}

const A = load(dirA!);
const B = load(dirB!);
const lines = [`# ${nameA} 与 ${nameB} 并排对比（种子图与补充轮次）`, ""];
lines.push(`| 主题 | 设置 | 种子变量数 | 全部新增变量 / 关系 | 理由平均字数 | 提到另一种解释的理由 | 争议边 |`, `|---|---|---|---|---|---|---|`);
for (const topic of new Set([...A.keys(), ...B.keys()])) {
  for (const [name, runs] of [[nameA, A.get(topic) ?? []], [nameB, B.get(topic) ?? []]] as const) {
    for (const d of runs) {
      const m = metrics(d);
      lines.push(`| ${d.name} | ${name} | ${m.seedNodes} | ${m.nodes} / ${m.edges} | ${m.avgReason} | ${m.alternatives} | ${m.contested} |`);
    }
  }
}
lines.push("");
for (const topic of new Set([...A.keys(), ...B.keys()])) {
  lines.push(`## ${topic}`, "");
  lines.push(`### ${nameA}`, "", ...(A.get(topic) ?? []).flatMap(renderSession));
  lines.push(`### ${nameB}`, "", ...(B.get(topic) ?? []).flatMap(renderSession));
}
const out = join(dirB!, "side-by-side.md");
writeFileSync(out, lines.join("\n"));
console.log(lines.slice(0, 20).join("\n"));
console.log(`\n并排对比：${out}`);
