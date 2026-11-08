import { describe, expect, it } from "vitest";
import { makeGraph } from "./testkit";
import { directionalWord, normalizeLabel, validateGraph } from "./validate";

const codes = (g: ReturnType<typeof makeGraph>) => validateGraph(g).map((i) => `${i.code}:${i.ids.join(",")}`);

describe("normalizeLabel", () => {
  it("忽略空白、标点、全半角和大小写", () => {
    expect(normalizeLabel(" 房价 ")).toBe("房价");
    expect(normalizeLabel("ＧＤＰ")).toBe("gdp");
    expect(normalizeLabel("Housing-Price")).toBe("housingprice");
    expect(normalizeLabel("房价（新房）")).toBe("房价新房");
  });
});

describe("directionalWord", () => {
  it("识别带方向的变量名", () => {
    expect(directionalWord("房价上涨")).toBe("上涨");
    expect(directionalWord("缺乏睡眠")).toBe("缺乏");
    expect(directionalWord("rising prices")).toBe("rising");
  });
  it("中性名词不报", () => {
    expect(directionalWord("房价")).toBeNull();
    expect(directionalWord("购房需求")).toBeNull();
    expect(directionalWord("homelessness")).toBeNull();
  });
});

describe("validateGraph", () => {
  it("干净的图没有问题", () => {
    expect(codes(makeGraph(["房价", "购房需求"], ["n2->n1 +", "n1->n2 -"]))).toEqual([]);
  });

  it("重复和相似的标签", () => {
    const g = makeGraph(["房价", " 房价", "新房房价"], ["n1->n2 +", "n2->n3 +"]);
    expect(codes(g)).toEqual(["duplicate_label:n1,n2", "similar_label:n1,n3", "similar_label:n2,n3"]);
  });

  it("带方向的变量名", () => {
    expect(codes(makeGraph(["房价上涨", "需求"], ["n2->n1 +"]))).toEqual(["directional_label:n1"]);
  });

  it("孤立节点（只有一个节点时不报）", () => {
    expect(codes(makeGraph(["A", "B", "C"], ["n1->n2 +"]))).toEqual(["isolated_node:n3"]);
    expect(codes(makeGraph(["A"]))).toEqual([]);
  });

  it("rejected 的边不算连接", () => {
    expect(codes(makeGraph(["A", "B"], ["n1->n2 + rejected"]))).toEqual(["isolated_node:n1", "isolated_node:n2"]);
  });

  it("rejected 的节点不参与检查", () => {
    const g = makeGraph(["房价", "房价"], []);
    g.nodes[1]!.status = "rejected";
    expect(codes(g)).toEqual([]);
  });

  it("自环和平行边", () => {
    expect(codes(makeGraph(["A", "B"], ["n1->n1 +", "n1->n2 +", "n1->n2 -"]))).toEqual([
      "self_loop:e1",
      "parallel_edges:e2,e3",
    ]);
  });
});
