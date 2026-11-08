import { describe, expect, it } from "vitest";
import { findLoops } from "./loops";
import { PatchError, applyOps, edgeActionOps, makePatch, planDecisions, resolvePatch } from "./patch";
import { Patch as PatchSchema, Version as VersionSchema, type Graph, type PatchOp } from "./schema";
import { NOW, makeGraph } from "./testkit";
import { initialVersion } from "./version";

const seedOps: PatchOp[] = [
  { op: "set_frame", phenomenon: "房价随时间持续上升", perspective: "城市居民", time_horizon: "20 年" },
  { op: "add_node", ref: "$price", label: "房价" },
  { op: "add_node", ref: "$demand", label: "购房需求" },
  { op: "add_node", ref: "$expect", label: "涨价预期" },
  { op: "add_edge", from: "$demand", to: "$price", polarity: "+", rationale: "需求推高价格" },
  { op: "add_edge", from: "$price", to: "$expect", polarity: "+", rationale: "价格上涨强化预期", delay: true },
  { op: "add_edge", from: "$expect", to: "$demand", polarity: "+", rationale: "预期带动需求" },
];

const aiPatch = (base: Graph, ops: PatchOp[], id = "p001") =>
  makePatch({ patch_id: id, base_version: base.version, origin: "ai", ops }, NOW);

/** 应用一个补丁并返回新图（测试用） */
const apply = (g: Graph, ops: PatchOp[], choices: Parameters<typeof resolvePatch>[2] = "all") => {
  const r = resolvePatch(g, aiPatch(g, ops), choices, NOW);
  return r.version!.graph;
};

const seeded = () => apply(initialVersion("房价", NOW).graph, seedOps);

describe("resolvePatch：种子补丁", () => {
  it("从 v000 生成 v001，分配真实 ID，回路由代码检测", () => {
    const v0 = initialVersion("房价为什么持续上涨", NOW);
    const { patch, version } = resolvePatch(v0.graph, aiPatch(v0.graph, seedOps), "all", NOW);

    expect(version?.version).toBe("v001");
    expect(version?.parent_version).toBe("v000");
    expect(version?.patch_id).toBe("p001");
    expect(VersionSchema.safeParse(version).success).toBe(true);

    const g = version!.graph;
    expect(g.frame).toEqual({ topic: "房价为什么持续上涨", phenomenon: "房价随时间持续上升", perspective: "城市居民", time_horizon: "20 年", context: "未指定" });
    expect(g.nodes.map((n) => `${n.id}:${n.label}:${n.origin}`)).toEqual(["n1:房价:ai", "n2:购房需求:ai", "n3:涨价预期:ai"]);
    expect(g.edges.map((e) => `${e.id}:${e.from}->${e.to}`)).toEqual(["e1:n2->n1", "e2:n1->n3", "e3:n3->n2"]);
    expect(g.edges[1]?.delay).toBe(true);
    expect(findLoops(g).loops.map((l) => l.id)).toEqual(["R1"]);

    expect(patch.resolution?.result_version).toBe("v001");
    expect(patch.resolution?.decisions.every((d) => d.decision === "accepted")).toBe(true);
    expect(PatchSchema.safeParse(patch).success).toBe(true);
  });

  it("不修改传入的图和补丁", () => {
    const v0 = initialVersion("房价", NOW);
    const p = aiPatch(v0.graph, seedOps);
    const before = JSON.stringify([v0, p]);
    resolvePatch(v0.graph, p, "all", NOW);
    expect(JSON.stringify([v0, p])).toBe(before);
  });
});

describe("resolvePatch：版本与重复处理", () => {
  it("基于过期版本的补丁被拒绝", () => {
    const g = seeded(); // v001
    const stale = makePatch({ patch_id: "p002", base_version: "v000", origin: "ai", ops: [] }, NOW);
    expect(() => resolvePatch(g, stale, "all", NOW)).toThrow(/基于 v000.*当前版本是 v001/);
  });

  it("已处理的补丁不能再处理", () => {
    const v0 = initialVersion("房价", NOW);
    const { patch } = resolvePatch(v0.graph, aiPatch(v0.graph, seedOps), "all", NOW);
    expect(() => resolvePatch(v0.graph, patch, "all", NOW)).toThrow(/已经处理过/);
  });

  it("全部拒绝时不生成新版本", () => {
    const g = seeded();
    const r = resolvePatch(g, aiPatch(g, [{ op: "add_node", ref: "$a", label: "利率" }]), {}, NOW);
    expect(r.version).toBeNull();
    expect(r.patch.resolution).toMatchObject({ result_version: null, decisions: [{ decision: "rejected" }] });
  });
});

describe("部分接受", () => {
  const ops: PatchOp[] = [
    { op: "add_node", ref: "$rate", label: "贷款利率" },
    { op: "add_node", ref: "$supply", label: "住房供给" },
    { op: "add_edge", from: "$rate", to: "n2", polarity: "-", rationale: "利率高抑制需求" },
    { op: "add_edge", from: "$supply", to: "n1", polarity: "-", rationale: "供给多压低价格" },
  ];

  it("拒绝新变量时，依赖它的边自动拒绝", () => {
    const g = seeded();
    const choices = { 0: { decision: "accepted" }, 1: { decision: "rejected", reason: "先不考虑" }, 2: { decision: "accepted" }, 3: { decision: "accepted" } } as const;
    const { patch, version } = resolvePatch(g, aiPatch(g, ops, "p002"), choices, NOW);
    expect(patch.resolution?.decisions).toEqual([
      { op_index: 0, decision: "accepted", auto: false },
      { op_index: 1, decision: "rejected", reason: "先不考虑", auto: false },
      { op_index: 2, decision: "accepted", auto: false },
      { op_index: 3, decision: "rejected", reason: "依赖的新变量 $supply 没有被接受", auto: true },
    ]);
    const labels = version!.graph.nodes.map((n) => n.label);
    expect(labels).toContain("贷款利率");
    expect(labels).not.toContain("住房供给");
    expect(version!.graph.edges.at(-1)).toMatchObject({ from: "n4", to: "n2", polarity: "-" });
  });

  it("未给出选择的项视为拒绝", () => {
    expect(planDecisions(ops, { 0: { decision: "accepted" } }).map((d) => d.decision)).toEqual([
      "accepted",
      "rejected",
      "rejected",
      "rejected",
    ]);
  });
});

describe("非法操作", () => {
  const expectOpError = (g: Graph, ops: PatchOp[], pattern: RegExp, opIndex: number | null = ops.length - 1) => {
    try {
      resolvePatch(g, aiPatch(g, ops, "p009"), "all", NOW);
      expect.unreachable("应该抛出 PatchError");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchError);
      expect((e as PatchError).message).toMatch(pattern);
      expect((e as PatchError).opIndex).toBe(opIndex);
    }
  };

  it("引用未定义或重复定义的临时引用", () => {
    const g = seeded();
    expectOpError(g, [{ op: "add_edge", from: "$x", to: "n1", polarity: "+", rationale: "" }], /\$x 没有在前面定义/);
    expectOpError(g, [{ op: "add_node", ref: "$a", label: "甲" }, { op: "add_node", ref: "$a", label: "乙" }], /\$a 重复定义/);
  });

  it("引用不存在的节点或边", () => {
    const g = seeded();
    expectOpError(g, [{ op: "add_edge", from: "n9", to: "n1", polarity: "+", rationale: "" }], /n9 不存在/);
    expectOpError(g, [{ op: "update_edge", id: "e9", polarity: "-" }], /e9 不存在/);
    expectOpError(g, [{ op: "remove_node", id: "n9" }], /n9 不存在/);
  });

  it("同名变量（归一化后）", () => {
    expectOpError(seeded(), [{ op: "add_node", ref: "$a", label: " 房价 " }], /已有同名变量"房价"（n1）/);
  });

  it("重复的同向关系、自环", () => {
    const g = seeded();
    expectOpError(g, [{ op: "add_edge", from: "n2", to: "n1", polarity: "-", rationale: "" }], /已有同向的关系 e1/);
    expectOpError(g, [{ op: "add_edge", from: "n1", to: "n1", polarity: "+", rationale: "" }], /指向自己/);
  });

  it("连接到已被拒绝的变量", () => {
    const g = apply(seeded(), [{ op: "remove_node", id: "n3" }]);
    expectOpError(g, [{ op: "add_edge", from: "n3", to: "n1", polarity: "+", rationale: "" }], /已被拒绝/);
  });

  it("重复拒绝", () => {
    const g = apply(seeded(), [{ op: "remove_edge", id: "e1" }]);
    expectOpError(g, [{ op: "remove_edge", id: "e1" }], /已经被拒绝/);
  });

  it("一项出错时整个补丁不生效", () => {
    const g = seeded();
    const ops: PatchOp[] = [
      { op: "add_node", ref: "$a", label: "利率" },
      { op: "add_edge", from: "n9", to: "n1", polarity: "+", rationale: "" },
    ];
    expect(() => resolvePatch(g, aiPatch(g, ops), "all", NOW)).toThrow(PatchError);
    expect(g.nodes).toHaveLength(3);
  });
});

describe("各种操作", () => {
  it("remove_node 保留记录，相连的回路消失，ID 不复用", () => {
    const g1 = apply(seeded(), [{ op: "remove_node", id: "n3", reason: "不需要" }]);
    expect(g1.nodes.find((n) => n.id === "n3")?.status).toBe("rejected");
    expect(findLoops(g1).loops).toEqual([]);
    const g2 = apply(g1, [{ op: "add_node", ref: "$a", label: "利率" }]);
    expect(g2.nodes.at(-1)?.id).toBe("n4");
  });

  it("remove_edge 置为 rejected，新边编号继续增长", () => {
    const g1 = apply(seeded(), [{ op: "remove_edge", id: "e3" }]);
    expect(g1.edges.find((e) => e.id === "e3")?.status).toBe("rejected");
    const g2 = apply(g1, [{ op: "add_edge", from: "n3", to: "n2", polarity: "-", rationale: "" }]);
    expect(g2.edges.at(-1)?.id).toBe("e4");
  });

  it("update_node 改名，不能和别的变量重名", () => {
    const g = apply(seeded(), [{ op: "update_node", id: "n3", label: "价格预期", note: "笔记" }]);
    expect(g.nodes[2]).toMatchObject({ label: "价格预期", note: "笔记" });
    expect(() => apply(g, [{ op: "update_node", id: "n3", label: "房价" }])).toThrow(/已有同名变量/);
    // 改成自己原来的名字是允许的
    expect(() => apply(g, [{ op: "update_node", id: "n3", label: "价格预期" }])).not.toThrow();
  });

  it("merge_nodes 把边改接到保留的变量，合并产生的自环置为 rejected", () => {
    // n2 购房需求、n4 住房需求（同义）；n4 -> n2 合并后会变成自环
    const g1 = apply(seeded(), [
      { op: "add_node", ref: "$a", label: "住房需求" },
      { op: "add_edge", from: "$a", to: "n1", polarity: "+", rationale: "" },
      { op: "add_edge", from: "$a", to: "n2", polarity: "+", rationale: "" },
    ]);
    const g2 = apply(g1, [{ op: "merge_nodes", keep: "n2", merge: "n4", label: "住房需求" }]);
    expect(g2.nodes.find((n) => n.id === "n4")?.status).toBe("rejected");
    expect(g2.nodes.find((n) => n.id === "n2")?.label).toBe("住房需求");
    expect(g2.edges.find((e) => e.id === "e4")).toMatchObject({ from: "n2", to: "n1", status: "accepted" });
    expect(g2.edges.find((e) => e.id === "e5")).toMatchObject({ from: "n2", to: "n2", status: "rejected" });
  });

  it("reverse_edge 掉头；与已有反向边冲突时报错", () => {
    const g = apply(seeded(), [{ op: "reverse_edge", id: "e1" }]);
    expect(g.edges[0]).toMatchObject({ from: "n1", to: "n2" });
    const g2 = apply(seeded(), [{ op: "add_edge", from: "n1", to: "n2", polarity: "-", rationale: "" }]);
    expect(() => apply(g2, [{ op: "reverse_edge", id: "e1" }])).toThrow(/已有同向的关系 e4/);
  });

  it("update_edge 修改极性后回路极性随之改变", () => {
    const g = apply(seeded(), [{ op: "update_edge", id: "e3", polarity: "-" }]);
    expect(findLoops(g).loops.map((l) => l.id)).toEqual(["B1"]);
  });

  it("update_edge 重新启用被拒绝的边", () => {
    const g1 = apply(seeded(), [{ op: "remove_edge", id: "e3" }]);
    const g2 = apply(g1, [{ op: "update_edge", id: "e3", status: "accepted" }]);
    expect(findLoops(g2).loops).toHaveLength(1);
    // 两端变量被拒绝后不能重新启用
    const g3 = apply(g1, [{ op: "remove_node", id: "n3" }]);
    expect(() => apply(g3, [{ op: "update_edge", id: "e3", status: "accepted" }])).toThrow(/已被拒绝/);
  });

  it("用户补丁的 origin 为 user", () => {
    const g = seeded();
    const p = makePatch({ patch_id: "p002", base_version: g.version, origin: "user", ops: [{ op: "add_node", ref: "$a", label: "利率" }] }, NOW);
    const { version } = resolvePatch(g, p, "all", NOW);
    expect(version?.graph.nodes.at(-1)?.origin).toBe("user");
  });

  it("applyOps 只应用给出的操作", () => {
    const g = applyOps(seeded(), [{ index: 0, op: { op: "set_frame", time_horizon: "10 年" } }], "user");
    expect(g.frame.time_horizon).toBe("10 年");
  });
});

describe("edgeActionOps（点按按钮）", () => {
  const e = { id: "e1", polarity: "+" as const };
  it("五个按钮对应的操作", () => {
    expect(edgeActionOps(e, "agree")).toEqual([{ op: "update_edge", id: "e1", status: "accepted" }]);
    expect(edgeActionOps(e, "uncertain")).toEqual([{ op: "update_edge", id: "e1", status: "uncertain" }]);
    expect(edgeActionOps(e, "flip_polarity")).toEqual([{ op: "update_edge", id: "e1", polarity: "-" }]);
    expect(edgeActionOps(e, "reverse")).toEqual([{ op: "reverse_edge", id: "e1" }]);
    expect(edgeActionOps(e, "disagree", { reason: "不对" })).toEqual([{ op: "remove_edge", id: "e1", reason: "不对" }]);
  });
  it("极性未知时需要指定新极性", () => {
    expect(() => edgeActionOps({ id: "e1", polarity: "?" }, "flip_polarity")).toThrow(/请选择/);
    expect(edgeActionOps({ id: "e1", polarity: "?" }, "flip_polarity", { polarity: "-" })).toEqual([
      { op: "update_edge", id: "e1", polarity: "-" },
    ]);
  });
});

describe("makeGraph 自检", () => {
  it("testkit 造出的图合法", () => {
    expect(makeGraph(["A", "B"], ["n1->n2 - uncertain"]).edges[0]).toMatchObject({ polarity: "-", status: "uncertain" });
  });
});
