// 从 runs/ 中 M3 真实生成的会话里提取图，作为布局测试的固定数据（src/web/fixtures/real-graphs.json）。
// 每个会话两种：最终的图（按回归剧本拒绝过一部分），以及把 AI 所有补丁全部接受后的图（更大）。
// 用法：npx tsx scripts/extract-layout-fixtures.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PatchError, makePatch, resolvePatch } from "../src/core/patch";
import type { Graph, Patch } from "../src/core/schema";
import { initialVersion } from "../src/core/version";

const SESSIONS = [
  ["runs/2026-11-08T10-32-33", "contested-1"],
  ["runs/2026-11-08T10-32-33", "contested-3"],
  ["runs/2026-11-08T10-32-33", "social-1"],
  ["runs/2026-11-08T10-32-33", "social-3"],
  ["runs/2026-11-08T10-32-33", "region-2"],
  ["runs/2026-11-08T10-32-33", "traffic-1"],
  ["runs/2026-11-08T10-32-33", "procrastination-1"],
  ["runs/2026-11-08T07-48-00", "clear-1"],
] as const;

const out: { name: string; graph: Graph }[] = [];
for (const [run, s] of SESSIONS) {
  const maps = join(run, "workspace", s, "maps");
  const dir = join(maps, readdirSync(maps)[0]!);
  const final = JSON.parse(readFileSync(join(dir, "graph.json"), "utf8")) as Graph;
  out.push({ name: `${s}（最终）`, graph: final });
  const patches = readdirSync(join(dir, "patches")).sort().map((f) => JSON.parse(readFileSync(join(dir, "patches", f), "utf8")) as Patch);
  let g = initialVersion(final.frame.topic, final.frame.topic && new Date().toISOString()).graph;
  try {
    for (const p of patches.filter((x) => x.origin === "ai")) {
      g = resolvePatch(g, makePatch({ ...p, base_version: g.version }, p.created_at), "all", p.created_at).version!.graph;
    }
    out.push({ name: `${s}（全接受）`, graph: g });
  } catch (e) {
    if (!(e instanceof PatchError)) throw e;
    console.log(`${s}：全部接受时无法应用（${e.message}），跳过`);
  }
}
writeFileSync("src/web/fixtures/real-graphs.json", JSON.stringify(out, null, 1));
for (const { name, graph } of out) {
  console.log(name.padEnd(26), "变量", graph.nodes.filter((n) => n.status === "accepted").length, "关系", graph.edges.filter((e) => e.status !== "rejected").length);
}
