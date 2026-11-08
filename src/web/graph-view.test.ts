import cytoscape from "cytoscape";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findLoops } from "../core/loops";
import { previewPatch } from "../core/preview";
import { current, demoState } from "./demo";
import { STYLE, buildElements, type GraphViewProps } from "./GraphView";

const props = (over: Partial<GraphViewProps> = {}): GraphViewProps => {
  const s = demoState();
  const graph = current(s);
  return {
    graph,
    loops: findLoops(graph).loops,
    preview: previewPatch(graph, s.pending!, s.patches),
    accepted: { 1: false },
    hoverOp: null,
    positions: {},
    onPositions: () => undefined,
    selection: null,
    onSelect: () => undefined,
    highlightLoop: null,
    onLoopClick: () => undefined,
    showRejected: true,
    ...over,
  };
};

afterEach(() => vi.restoreAllMocks());

describe("图视图（无界面模式）", () => {
  it("样式表和元素都能被 Cytoscape 接受，没有警告", () => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const cy = cytoscape({ headless: true, styleEnabled: true, style: STYLE, elements: buildElements(props()) });
    cy.elements().forEach((e) => void e.style("opacity"));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    cy.destroy();
  });

  it("幽灵样式、极性、延迟、争议、回路标记都打上了对应的类", () => {
    const els = buildElements(props());
    const cls = (id: string) => els.find((e) => e.data.id === id)?.classes;
    const data = (id: string) => els.find((e) => e.data.id === id)?.data;
    expect(cls("n6")).toContain("ghost"); // 待处理补丁新增的变量
    expect(cls("e9")).toContain("ghost-off"); // 第 2 项（序号 1）没有勾选
    expect(cls("e4")).toContain("ghost-mod"); // 被修改的关系
    expect(cls("e3")).toContain("neg");
    expect(cls("e7")).toContain("uncertain");
    expect(cls("e8")).toContain("contested");
    expect(data("e1")?.label).toBe("+ ‖");
    expect(data("e8")?.label).toBe("− ⚑");
    expect(els.filter((e) => String(e.classes).includes("loop")).map((e) => e.data.label).sort()).toEqual(["?1", "B1", "R1", "R2"]);
  });

  it("没有预览时不画幽灵；默认隐藏已拒绝的内容", () => {
    const els = buildElements(props({ preview: null, showRejected: false }));
    expect(els.some((e) => String(e.classes).includes("ghost"))).toBe(false);
    expect(els.some((e) => e.data.id === "n6")).toBe(false);
  });
});
