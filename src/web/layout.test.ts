import { describe, expect, it } from "vitest";
import { findLoops } from "../core/loops";
import { applyOps } from "../core/patch";
import { Graph as GraphSchema, type Graph, type PatchOp } from "../core/schema";
import { current, demoState, resolvePending } from "./demo";
import fixtures from "./fixtures/real-graphs.json";
import { CURVE_BAND, MARKER_R, NODE_GAP, boxGap, computeLayout, markerEdges, nodeBoxes, placeLoopMarkers, segmentDistance, type Positions } from "./layout";

/** 合成的大图（不是 AI 生成的），用来压力测试 10 个变量的情况 */
function synthetic(): Graph {
  const labels = ["城市人口", "住房需求", "房价", "住房供给", "土地供应", "居民收入", "信贷条件", "涨价预期", "投资性购房", "租金水平"];
  const pairs = [[0, 1], [1, 2], [3, 2], [4, 3], [5, 1], [6, 1], [2, 7], [7, 8], [8, 2], [2, 9], [9, 1], [2, 3], [6, 8]];
  return GraphSchema.parse({
    schema_version: 1,
    version: "v001",
    frame: { topic: "合成：房价" },
    nodes: labels.map((label, i) => ({ id: `n${i + 1}`, label, status: "accepted", origin: "user" })),
    edges: pairs.map(([a, b], i) => ({ id: `e${i + 1}`, from: `n${a! + 1}`, to: `n${b! + 1}`, polarity: i % 3 ? "+" : "-", status: "accepted", origin: "user" })),
  });
}

const cases: { name: string; graph: Graph }[] = [
  ...(fixtures as { name: string; graph: unknown }[]).map((f) => ({ name: f.name, graph: GraphSchema.parse(f.graph) })),
  { name: "示例：越修路越堵", graph: current(resolvePending(demoState(), "all")) },
  { name: "合成：10 个变量", graph: synthetic() },
];

function expectNoOverlap(graph: Graph, pos: Positions, name: string) {
  const boxes = [...nodeBoxes(graph, pos).entries()];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const gap = boxGap(boxes[i]![1], boxes[j]![1]);
      expect(gap, `${name}：${boxes[i]![0]} 和 ${boxes[j]![0]} 的间隙 ${gap.toFixed(1)}`).toBeGreaterThanOrEqual(NODE_GAP - 1);
    }
  }
}

describe("自动布局（真实生成的图）", () => {
  it("测试数据覆盖 4 个以上变量的多张真实图", () => {
    const sizes = cases.map((c) => c.graph.nodes.filter((n) => n.status === "accepted").length);
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(Math.min(...sizes)).toBeLessThanOrEqual(5);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(7);
  });

  for (const { name, graph } of cases) {
    it(`${name}：节点外框不重叠、不挤成一条、回路标记不压节点`, () => {
      const pos = computeLayout(graph);
      const ids = graph.nodes.filter((n) => n.status === "accepted").map((n) => n.id);
      expect(Object.keys(pos).sort()).toEqual([...ids].sort());
      expectNoOverlap(graph, pos, name);

      // 不能挤成一条竖列或横条
      const boxes = [...nodeBoxes(graph, pos).values()];
      const w = Math.max(...boxes.map((b) => b.x + b.w / 2)) - Math.min(...boxes.map((b) => b.x - b.w / 2));
      const h = Math.max(...boxes.map((b) => b.y + b.h / 2)) - Math.min(...boxes.map((b) => b.y - b.h / 2));
      expect(w / h, `${name}：宽 ${w.toFixed(0)} 高 ${h.toFixed(0)}`).toBeGreaterThan(0.4);
      expect(w / h, `${name}：宽 ${w.toFixed(0)} 高 ${h.toFixed(0)}`).toBeLessThan(4);

      // 回路标记（全部同时显示的最坏情况）
      const loops = findLoops(graph).loops;
      const edges = markerEdges(graph);
      const markers = placeLoopMarkers(loops, nodeBoxes(graph, pos), edges);
      for (const [id, m] of Object.entries(markers)) {
        for (const b of boxes) {
          const clear = Math.abs(m.x - b.x) >= b.w / 2 + MARKER_R || Math.abs(m.y - b.y) >= b.h / 2 + MARKER_R;
          expect(clear, `${name}：回路标记 ${id} 压在节点上`).toBe(true);
        }
        for (const e of edges) {
          const d = segmentDistance(m, pos[e.from]!, pos[e.to]!);
          expect(d, `${name}：回路标记 ${id} 压在边 ${e.from}→${e.to} 上`).toBeGreaterThanOrEqual(MARKER_R + (e.curved ? CURVE_BAND : 0));
        }
      }
      const ms = Object.values(markers);
      for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) expect(Math.hypot(ms[i]!.x - ms[j]!.x, ms[i]!.y - ms[j]!.y)).toBeGreaterThanOrEqual(2 * MARKER_R);
    });
  }

  it("同一张图布局两次，结果相同", () => {
    const g = cases[0]!.graph;
    expect(computeLayout(g)).toEqual(computeLayout(g));
  });
});

describe("增量布局：新增变量或关系后，已有节点不动", () => {
  for (const { name, graph } of cases.slice(0, 6)) {
    it(name, () => {
      const before = computeLayout(graph);
      const live = graph.nodes.filter((n) => n.status === "accepted");
      const ops: PatchOp[] = [
        { op: "add_node", ref: "$x", label: "新增的变量甲" },
        { op: "add_node", ref: "$y", label: "乙" },
        { op: "add_edge", from: live[0]!.id, to: "$x", polarity: "+", rationale: "" },
        { op: "add_edge", from: "$x", to: live[1]!.id, polarity: "-", rationale: "" },
        { op: "add_edge", from: "$y", to: live[0]!.id, polarity: "+", rationale: "" },
      ];
      const after = applyOps(graph, ops.map((op, index) => ({ index, op })), "ai");
      const pos = computeLayout(after, before);
      for (const id of Object.keys(before)) expect(pos[id], `${name}：${id} 被移动了`).toEqual(before[id]);
      expectNoOverlap(after, pos, `${name}（新增后）`);
    });
  }

  it("只新增关系时，所有节点都不动", () => {
    const g = cases[0]!.graph;
    const before = computeLayout(g);
    const live = g.nodes.filter((n) => n.status === "accepted");
    const has = (x: string, y: string) => g.edges.some((e) => e.status !== "rejected" && e.from === x && e.to === y);
    const pair = live.flatMap((x) => live.map((y) => [x.id, y.id] as const)).find(([x, y]) => x !== y && !has(x, y))!;
    const after = applyOps(g, [{ index: 0, op: { op: "add_edge", from: pair[0], to: pair[1], polarity: "?", rationale: "" } }], "ai");
    expect(computeLayout(after, before)).toEqual(before);
  });
});
