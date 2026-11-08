import { describe, expect, it } from "vitest";
import { AiOutput, Graph, Patch, PatchOp, Version, aiOutputJsonSchema } from "./schema";

const validGraph = {
  schema_version: 1,
  version: "v001",
  frame: { topic: "房价为什么持续上涨", phenomenon: "房价随时间持续上升", perspective: "城市居民", time_horizon: "20 年" },
  nodes: [
    { id: "n1", label: "房价", status: "accepted", origin: "user" },
    { id: "n2", label: "购房需求", status: "accepted", origin: "ai" },
  ],
  edges: [
    { id: "e1", from: "n2", to: "n1", polarity: "+", status: "accepted", origin: "ai", rationale: "需求增加会推高成交价格" },
  ],
};

describe("Graph", () => {
  it("接受合法的图并补上默认值", () => {
    const g = Graph.parse(validGraph);
    expect(g.edges[0]).toMatchObject({ delay: false, contested: false, confidence: null, note: "" });
    expect(g.nodes[0]?.note).toBe("");
  });

  it("拒绝 proposed 状态（v2.1 起图中不存 proposed）", () => {
    const bad = structuredClone(validGraph);
    bad.edges[0]!.status = "proposed";
    expect(Graph.safeParse(bad).success).toBe(false);
  });

  it("拒绝重复的节点 ID", () => {
    const bad = structuredClone(validGraph);
    bad.nodes[1]!.id = "n1";
    expect(Graph.safeParse(bad).success).toBe(false);
  });

  it("拒绝引用不存在节点的边", () => {
    const bad = structuredClone(validGraph);
    bad.edges[0]!.from = "n9";
    const r = Graph.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("n9");
  });

  it("拒绝非法极性和空标签", () => {
    const bad1 = structuredClone(validGraph);
    bad1.edges[0]!.polarity = "++";
    expect(Graph.safeParse(bad1).success).toBe(false);
    const bad2 = structuredClone(validGraph);
    bad2.nodes[0]!.label = "  ";
    expect(Graph.safeParse(bad2).success).toBe(false);
  });

  it("接受未知极性 ?", () => {
    const g = structuredClone(validGraph);
    g.edges[0]!.polarity = "?";
    expect(Graph.safeParse(g).success).toBe(true);
  });
});

describe("PatchOp", () => {
  it("add_edge 可以引用临时 ID 和已有 ID", () => {
    expect(PatchOp.safeParse({ op: "add_edge", from: "$a", to: "n2", polarity: "-", rationale: "…" }).success).toBe(true);
  });

  it("add_node 必须使用 $ref，不能自带真实 ID", () => {
    expect(PatchOp.safeParse({ op: "add_node", ref: "n7", label: "贷款利率" }).success).toBe(false);
    expect(PatchOp.safeParse({ op: "add_node", id: "n7", label: "贷款利率" }).success).toBe(false);
  });

  it("拒绝未知操作", () => {
    expect(PatchOp.safeParse({ op: "delete_everything" }).success).toBe(false);
  });
});

describe("Patch", () => {
  const patch = {
    patch_id: "p001",
    base_version: "v000",
    origin: "ai",
    created_at: "2026-11-08T14:00:00Z",
    ops: [
      { op: "set_frame", phenomenon: "房价随时间持续上升" },
      { op: "add_node", ref: "$a", label: "房价" },
    ],
    resolution: null,
  };

  it("接受未处理的补丁", () => {
    expect(Patch.parse(patch).possible_duplicates).toEqual([]);
  });

  it("接受部分接受的处理结果", () => {
    const resolved = {
      ...patch,
      resolution: {
        resolved_at: "2026-11-08T14:02:00Z",
        decisions: [
          { op_index: 0, decision: "accepted" },
          { op_index: 1, decision: "rejected", reason: "不需要" },
        ],
        result_version: "v001",
      },
    };
    expect(Patch.safeParse(resolved).success).toBe(true);
  });

  it("拒绝格式错误的版本号", () => {
    expect(Patch.safeParse({ ...patch, base_version: "4" }).success).toBe(false);
  });
});

describe("Version", () => {
  it("接受与图版本一致的快照", () => {
    const v = { version: "v001", parent_version: "v000", patch_id: "p001", created_at: "2026-11-08T14:02:00Z", graph: validGraph };
    expect(Version.safeParse(v).success).toBe(true);
  });

  it("拒绝与图版本不一致的快照", () => {
    const v = { version: "v002", parent_version: "v001", patch_id: "p002", created_at: "2026-11-08T14:02:00Z", graph: validGraph };
    expect(Version.safeParse(v).success).toBe(false);
  });
});

describe("AiOutput", () => {
  it("接受种子补丁", () => {
    const out = {
      kind: "patch",
      message: "先从这三个变量开始，可能不对。",
      question: "你觉得房价上升会反过来影响购房需求吗？",
      ops: [
        { op: "add_node", ref: "$a", label: "房价" },
        { op: "add_node", ref: "$b", label: "购房需求" },
        { op: "add_edge", from: "$b", to: "$a", polarity: "+", rationale: "需求增加推高价格" },
      ],
      possible_duplicates: [],
    };
    expect(AiOutput.safeParse(out).success).toBe(true);
  });

  it("拒绝缺字段和未知 kind", () => {
    expect(AiOutput.safeParse({ kind: "patch", message: "", ops: [] }).success).toBe(false);
    expect(AiOutput.safeParse({ kind: "predict", message: "", question: "", ops: [], possible_duplicates: [] }).success).toBe(false);
  });

  it("能生成给 CLI 用的 JSON Schema", () => {
    const schema = aiOutputJsonSchema();
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(expect.arrayContaining(["kind", "message", "question", "ops", "possible_duplicates"]));
    expect(JSON.stringify(schema)).toContain("add_edge");
  });

  it("给 CLI 的 JSON Schema 不禁止多余字段，zod 解析时丢弃多余字段", () => {
    expect(JSON.stringify(aiOutputJsonSchema())).not.toContain('"additionalProperties":false');
    const out = AiOutput.parse({
      kind: "patch",
      message: "",
      question: "？",
      ops: [{ op: "reverse_edge", id: "e1", rationale: "多写的字段" }],
      possible_duplicates: [],
    });
    expect(out.ops[0]).toEqual({ op: "reverse_edge", id: "e1" });
  });

  it("临时引用可以用中文", () => {
    expect(PatchOp.safeParse({ op: "add_node", ref: "$焦虑", label: "焦虑程度" }).success).toBe(true);
    expect(PatchOp.safeParse({ op: "add_node", ref: "$ a", label: "x" }).success).toBe(false);
  });
});
