// 检查默认布局下边的路由：穿过变量、边重叠、标签位置。不调用 AI。
// 用法：npx tsx scripts/check-layout.ts
import { Graph as GraphSchema, type Graph } from "../src/core/schema";
import { current, demoState, resolvePending } from "../src/web/demo";
import fixtures from "../src/web/fixtures/real-graphs.json";
import { computeLayout, nodeBoxes } from "../src/web/layout";
import { routeEdges, routeInputs, type RouteIssue } from "../src/web/routing";

const NAMES: Record<RouteIssue["kind"], string> = {
  through_node: "边穿过变量",
  overlap_edge: "边与边重叠",
  label_on_node: "标签压在变量上",
  label_on_edge: "标签压在其他边上",
  label_on_arrow: "标签压住箭头",
  label_on_label: "标签互相重叠",
};

const cases: { name: string; graph: Graph }[] = [
  ...(fixtures as { name: string; graph: unknown }[]).map((f, i) => ({ name: `#${i} ${f.name}`, graph: GraphSchema.parse(f.graph) })),
  { name: "示例：越修路越堵", graph: current(resolvePending(demoState(), "all")) },
];

let before = 0;
let after = 0;
for (const { name, graph } of cases) {
  const pos = computeLayout(graph);
  const boxes = nodeBoxes(graph, pos);
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const edge = (id: string) => {
    const e = graph.edges.find((x) => x.id === id)!;
    return `「${label(e.from)} → ${label(e.to)}」`;
  };
  const fmt = (i: RouteIssue) => `${NAMES[i.kind]}：${edge(i.edge)}${i.other ? ` / ${i.other.startsWith("e") ? edge(i.other) : `「${label(i.other)}」`}` : ""}`;
  const straight = routeEdges(routeInputs(graph), boxes, { reroute: false }).issues;
  const routed = routeEdges(routeInputs(graph), boxes).issues;
  before += straight.length;
  after += routed.length;
  if (!straight.length && !routed.length) continue;
  console.log(`\n${name}`);
  for (const i of straight) console.log(`  不弯曲时  ${fmt(i)}`);
  for (const i of routed) console.log(`  路由之后  ${fmt(i)}`);
}
console.log(`\n共 ${cases.length} 张图。不弯曲时 ${before} 个问题；路由之后 ${after} 个问题。`);
