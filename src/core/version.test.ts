import { describe, expect, it } from "vitest";
import { nextItemId, nextSeqId } from "./ids";
import { makePatch, resolvePatch } from "./patch";
import { Version as VersionSchema, type Graph, type PatchOp } from "./schema";
import { NOW, makeGraph } from "./testkit";
import { diffGraphs, initialVersion, isEmptyDiff, restoreVersion } from "./version";

const apply = (g: Graph, ops: PatchOp[]) =>
  resolvePatch(g, makePatch({ patch_id: "p001", base_version: g.version, origin: "user", ops }, NOW), "all", NOW).version!.graph;

describe("ID", () => {
  it("序号 ID 递增并补足 3 位", () => {
    expect(nextSeqId("v000")).toBe("v001");
    expect(nextSeqId("v099")).toBe("v100");
    expect(nextSeqId("p999")).toBe("p1000");
  });
  it("节点 / 边 ID 取最大编号 + 1", () => {
    expect(nextItemId("n", [])).toBe("n1");
    expect(nextItemId("n", [{ id: "n2" }, { id: "n10" }, { id: "n3" }])).toBe("n11");
  });
});

describe("initialVersion", () => {
  it("v000 是合法的空图", () => {
    const v = initialVersion("拖延", NOW);
    expect(VersionSchema.safeParse(v).success).toBe(true);
    expect(v).toMatchObject({ version: "v000", parent_version: null, patch_id: null, graph: { nodes: [], edges: [], frame: { topic: "拖延" } } });
  });
});

describe("diffGraphs", () => {
  it("相同的图没有差异", () => {
    const g = makeGraph(["A", "B"], ["n1->n2 +"]);
    expect(isEmptyDiff(diffGraphs(g, structuredClone(g)))).toBe(true);
  });

  it("报告新增、修改（含状态变化）和 frame 变化，忽略 version", () => {
    const a = makeGraph(["A", "B"], ["n1->n2 +"]);
    const b = apply(a, [
      { op: "set_frame", time_horizon: "5 年" },
      { op: "add_node", ref: "$c", label: "C" },
      { op: "update_edge", id: "e1", polarity: "-" },
      { op: "remove_node", id: "n2" },
    ]);
    const d = diffGraphs(a, b);
    expect(d.frame).toEqual([{ field: "time_horizon", from: "", to: "5 年" }]);
    expect(d.nodes.added).toEqual(["n3"]);
    expect(d.nodes.changed).toEqual([{ id: "n2", changes: [{ field: "status", from: "accepted", to: "rejected" }] }]);
    expect(d.edges.changed).toEqual([{ id: "e1", changes: [{ field: "polarity", from: "+", to: "-" }] }]);
    expect(d.nodes.deleted).toEqual([]);
  });
});

describe("restoreVersion", () => {
  it("恢复旧版本生成新版本，后来新增的内容以 rejected 保留，ID 不复用", () => {
    const v1 = makeGraph(["A", "B"], ["n1->n2 +"], "v001");
    const v2 = apply(v1, [
      { op: "add_node", ref: "$c", label: "C" },
      { op: "add_edge", from: "$c", to: "n1", polarity: "+", rationale: "" },
      { op: "update_edge", id: "e1", polarity: "-" },
    ]);
    expect(v2.version).toBe("v002");

    const restored = restoreVersion(v2, v1, NOW);
    expect(VersionSchema.safeParse(restored).success).toBe(true);
    expect(restored).toMatchObject({ version: "v003", parent_version: "v002", patch_id: null });

    const g = restored.graph;
    expect(g.edges.find((e) => e.id === "e1")?.polarity).toBe("+");
    expect(g.nodes.find((n) => n.id === "n3")?.status).toBe("rejected");
    expect(g.edges.find((e) => e.id === "e2")?.status).toBe("rejected");

    // 恢复后再新增，编号继续增长
    const g4 = apply(g, [{ op: "add_node", ref: "$d", label: "D" }]);
    expect(g4.nodes.at(-1)?.id).toBe("n4");
  });
});
