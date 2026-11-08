import { describe, expect, it } from "vitest";
import { previewPatch } from "./preview";
import type { PatchOp } from "./schema";
import { makeGraph } from "./testkit";

describe("previewPatch", () => {
  const g = makeGraph(["道路容量", "交通拥堵程度"], ["n1->n2 -", "n2->n1 +"]);

  it("标出每项操作对应的元素和具体改动", () => {
    const ops: PatchOp[] = [
      { op: "add_node", ref: "$a", label: "驾车出行量" },
      { op: "add_edge", from: "n1", to: "$a", polarity: "+", rationale: "路多了开车的人多", delay: true },
      { op: "update_edge", id: "e2", delay: true, note: "修路要好几年" },
      { op: "remove_edge", id: "e1", reason: "不确定" },
    ];
    const p = previewPatch(g, { ops, origin: "ai" });
    expect(p.error).toBeNull();
    expect(p.ops.map((o) => [o.effect, o.elements])).toEqual([
      ["add", ["n3"]],
      ["add", ["e3"]],
      ["modify", ["e2"]],
      ["remove", ["e1"]],
    ]);
    expect(p.ops[2]?.text).toBe("修改关系「交通拥堵程度 →(+) 道路容量」：标记延迟，笔记改为「修路要好几年」");
    expect(p.ops[1]?.reason).toBe("路多了开车的人多");
    expect(p.after?.edges.find((e) => e.id === "e3")).toMatchObject({ from: "n1", to: "n3", delay: true });
  });

  it("补丁无法应用时给出原因，仍列出各项操作", () => {
    const p = previewPatch(g, { ops: [{ op: "add_edge", from: "n9", to: "n1", polarity: "+", rationale: "" }], origin: "ai" });
    expect(p.after).toBeNull();
    expect(p.error).toMatch(/n9 不存在/);
    expect(p.ops).toHaveLength(1);
  });
});
