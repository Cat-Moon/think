import { describe, expect, it } from "vitest";
import { findLoops, loopPolarity } from "./loops";
import { makeGraph } from "./testkit";

const summary = (g: ReturnType<typeof makeGraph>, opts?: Parameters<typeof findLoops>[1]) =>
  findLoops(g, opts).loops.map((l) => `${l.id}:${l.nodes.join(">")}`);

describe("loopPolarity", () => {
  it("偶数条负边是 R，奇数条是 B", () => {
    expect(loopPolarity(["+", "+"])).toBe("R");
    expect(loopPolarity(["-", "-"])).toBe("R");
    expect(loopPolarity(["+", "-"])).toBe("B");
    expect(loopPolarity(["-", "-", "-"])).toBe("B");
    expect(loopPolarity([])).toBe("R");
  });
  it("含 ? 时为 ?", () => {
    expect(loopPolarity(["+", "?", "-"])).toBe("?");
  });
});

describe("findLoops", () => {
  it("没有回路", () => {
    const g = makeGraph(["A", "B", "C"], ["n1->n2 +", "n2->n3 +", "n1->n3 -"]);
    expect(findLoops(g)).toEqual({ loops: [], truncated: false });
  });

  it("单个增强回路", () => {
    const g = makeGraph(["A", "B"], ["n1->n2 +", "n2->n1 +"]);
    const { loops } = findLoops(g);
    expect(loops).toEqual([{ id: "R1", polarity: "R", nodes: ["n1", "n2"], edges: ["e1", "e2"], uncertain: false }]);
  });

  it("单个平衡回路（奇数条负边）", () => {
    const g = makeGraph(["A", "B", "C"], ["n1->n2 +", "n2->n3 -", "n3->n1 +"]);
    expect(summary(g)).toEqual(["B1:n1>n2>n3"]);
  });

  it("偶数条负边仍是增强回路", () => {
    const g = makeGraph(["A", "B", "C"], ["n1->n2 -", "n2->n3 -", "n3->n1 +"]);
    expect(summary(g)).toEqual(["R1:n1>n2>n3"]);
  });

  it("多个独立回路", () => {
    const g = makeGraph(["A", "B", "C", "D"], ["n1->n2 +", "n2->n1 +", "n3->n4 +", "n4->n3 -"]);
    expect(summary(g)).toEqual(["R1:n1>n2", "B1:n3>n4"]);
  });

  it("共享节点的嵌套回路（8 字形）", () => {
    // A→B→A 和 A→C→A 共享 A；A→B→C→A 是外圈
    const g = makeGraph(["A", "B", "C"], ["n1->n2 +", "n2->n1 -", "n1->n3 +", "n3->n1 +", "n2->n3 +"]);
    expect(summary(g)).toEqual(["B1:n1>n2", "R1:n1>n3", "R2:n1>n2>n3"]);
  });

  it("自环算作长度为 1 的回路", () => {
    const g = makeGraph(["人口"], ["n1->n1 +"]);
    expect(summary(g)).toEqual(["R1:n1"]);
  });

  it("平行边产生两个不同的回路", () => {
    const g = makeGraph(["A", "B"], ["n1->n2 +", "n1->n2 -", "n2->n1 +"]);
    const { loops } = findLoops(g);
    expect(loops.map((l) => [l.id, l.edges])).toEqual([
      ["R1", ["e1", "e3"]],
      ["B1", ["e2", "e3"]],
    ]);
  });

  it("含未知极性的边时极性为 ?", () => {
    const g = makeGraph(["A", "B", "C"], ["n1->n2 +", "n2->n1 ?", "n2->n3 +", "n3->n2 +"]);
    expect(summary(g)).toEqual(["?1:n1>n2", "R1:n2>n3"]);
  });

  it("含 uncertain 边的回路被标记", () => {
    const g = makeGraph(["A", "B"], ["n1->n2 + uncertain", "n2->n1 +"]);
    expect(findLoops(g).loops[0]?.uncertain).toBe(true);
  });

  it("rejected 的边不参与", () => {
    const g = makeGraph(["A", "B"], ["n1->n2 +", "n2->n1 + rejected"]);
    expect(summary(g)).toEqual([]);
  });

  it("连接 rejected 节点的边不参与", () => {
    const g = makeGraph(["A", "B"], ["n1->n2 +", "n2->n1 +"]);
    g.nodes[1]!.status = "rejected";
    expect(summary(g)).toEqual([]);
  });

  it("节点 ID 按数字排序（n2 在 n10 之前）", () => {
    const labels = Array.from({ length: 10 }, (_, i) => `V${i + 1}`);
    const g = makeGraph(labels, ["n10->n2 +", "n2->n10 +"]);
    expect(summary(g)).toEqual(["R1:n2>n10"]);
  });

  it("完全图 K5 的基本回路数正确（84 个），没有重复", () => {
    const n = 5;
    const edges: string[] = [];
    for (let a = 1; a <= n; a++) for (let b = 1; b <= n; b++) if (a !== b) edges.push(`n${a}->n${b} +`);
    const g = makeGraph(Array.from({ length: n }, (_, i) => `V${i}`), edges);
    const { loops, truncated } = findLoops(g);
    expect(truncated).toBe(false);
    expect(loops).toHaveLength(84);
    expect(new Set(loops.map((l) => l.edges.join())).size).toBe(84);
  });

  it("超过上限时截断并标记", () => {
    const n = 6; // K6 有 409 个基本回路
    const edges: string[] = [];
    for (let a = 1; a <= n; a++) for (let b = 1; b <= n; b++) if (a !== b) edges.push(`n${a}->n${b} +`);
    const g = makeGraph(Array.from({ length: n }, (_, i) => `V${i}`), edges);
    const r = findLoops(g);
    expect(r.truncated).toBe(true);
    expect(r.loops).toHaveLength(200);
    expect(findLoops(g, { limit: 1000 }).loops).toHaveLength(409);
  });
});
