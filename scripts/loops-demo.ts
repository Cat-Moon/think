// M1 演示：用补丁从空图搭一张"越修路越堵"的图，打印代码检测出的回路和校验提示。
// 用法：npx tsx scripts/loops-demo.ts
import { diffGraphs, findLoops, initialVersion, makePatch, resolvePatch, validateGraph, type Graph, type PatchOp } from "../src/core";

const now = new Date().toISOString();
let graph = initialVersion("城市交通为什么越修路越堵", now).graph;
let seq = 1;

function apply(ops: PatchOp[], choices: Parameters<typeof resolvePatch>[2] = "all"): Graph {
  const patch = makePatch({ patch_id: `p${String(seq++).padStart(3, "0")}`, base_version: graph.version, origin: "ai", ops }, now);
  const { version } = resolvePatch(graph, patch, choices, now);
  return version ? version.graph : graph;
}

function show(g: Graph) {
  const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
  console.log(`\n== ${g.version} ==`);
  for (const e of g.edges.filter((e) => e.status !== "rejected")) {
    console.log(`  ${e.id}  ${label(e.from)} → ${label(e.to)}  (${e.polarity}${e.delay ? " ‖延迟" : ""}${e.status === "uncertain" ? " 不确定" : ""})`);
  }
  const { loops, truncated } = findLoops(g);
  console.log(`  回路${truncated ? "（已截断）" : ""}：`);
  for (const l of loops) console.log(`    ${l.id}${l.uncertain ? "（含不确定）" : ""}: ${[...l.nodes, l.nodes[0]!].map(label).join(" → ")}`);
  if (!loops.length) console.log("    （无）");
  for (const i of validateGraph(g)) console.log(`  ⚠ ${i.message}`);
}

// 种子补丁
graph = apply([
  { op: "set_frame", phenomenon: "道路越修越多，拥堵却没有缓解", perspective: "城市通勤者", time_horizon: "10 年" },
  { op: "add_node", ref: "$jam", label: "交通拥堵程度" },
  { op: "add_node", ref: "$road", label: "道路容量" },
  { op: "add_node", ref: "$build", label: "修路投入" },
  { op: "add_edge", from: "$jam", to: "$build", polarity: "+", rationale: "拥堵促使政府修路", delay: true },
  { op: "add_edge", from: "$build", to: "$road", polarity: "+", rationale: "修路增加容量", delay: true },
  { op: "add_edge", from: "$road", to: "$jam", polarity: "-", rationale: "容量增加缓解拥堵" },
]);
show(graph);

// 第二轮：诱发需求。用户拒绝了"公共交通"，依赖它的边自动拒绝
const before = graph;
graph = apply(
  [
    { op: "add_node", ref: "$trips", label: "驾车出行量" },
    { op: "add_node", ref: "$transit", label: "公共交通吸引力" },
    { op: "add_edge", from: "n2", to: "$trips", polarity: "+", rationale: "路好走吸引更多人开车（诱发需求）", delay: true },
    { op: "add_edge", from: "$trips", to: "n1", polarity: "+", rationale: "车多更堵" },
    { op: "add_edge", from: "$transit", to: "$trips", polarity: "-", rationale: "" },
  ],
  { 0: { decision: "accepted" }, 1: { decision: "rejected" }, 2: { decision: "accepted" }, 3: { decision: "accepted" }, 4: { decision: "accepted" } },
);
show(graph);

const d = diffGraphs(before, graph);
console.log(`\n差异 ${before.version} → ${graph.version}：新增节点 ${d.nodes.added.join(", ")}；新增边 ${d.edges.added.join(", ")}`);

// 第三轮：用户点"不确定"
graph = apply([{ op: "update_edge", id: "e4", status: "uncertain" }]);
show(graph);
