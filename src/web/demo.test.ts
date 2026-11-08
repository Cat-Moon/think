import { describe, expect, it } from "vitest";
import { findLoops } from "../core/loops";
import { previewPatch } from "../core/preview";
import { applyEdgeAction, current, demoState, resolvePending, restoreTo } from "./demo";

describe("示例数据", () => {
  it("图的内容、状态和回路符合预期", () => {
    const s = demoState();
    const g = current(s);
    const label = (id: string) => g.nodes.find((n) => n.id === id)?.label;
    const edges = Object.fromEntries(g.edges.map((e) => [e.id, `${label(e.from)}→${label(e.to)} ${e.polarity} ${e.status}${e.delay ? " 延迟" : ""}${e.contested ? " 争议" : ""}`]));
    expect(edges).toEqual({
      e1: "交通拥堵程度→修路投入 + accepted 延迟",
      e2: "修路投入→道路容量 + accepted 延迟",
      e3: "道路容量→交通拥堵程度 - accepted",
      e4: "道路容量→驾车出行量 + accepted",
      e5: "驾车出行量→交通拥堵程度 + accepted",
      e6: "公共交通吸引力→驾车出行量 - accepted",
      e7: "交通拥堵程度→公共交通吸引力 ? uncertain",
      e8: "修路投入→公共交通吸引力 - accepted 争议",
    });
    expect(findLoops(g).loops.map((l) => l.id).sort()).toEqual(["?1", "B1", "R1", "R2"].sort());
    expect(s.patches.map((p) => p.patch_id)).toEqual(["p001", "p002", "p003", "p004"]);
    expect(s.pending?.patch_id).toBe("p005");
  });

  it("待处理补丁的预览写出具体改动", () => {
    const s = demoState();
    const p = previewPatch(current(s), s.pending!, s.patches);
    expect(p.error).toBeNull();
    expect(p.ops.map((o) => o.text)).toEqual([
      "新增变量「城市蔓延程度」",
      "新增关系「道路容量 →(+) 城市蔓延程度」 ‖延迟",
      "新增关系「城市蔓延程度 →(+) 驾车出行量」",
      "修改关系「道路容量 →(+) 驾车出行量」：标记延迟，笔记改为「诱发需求通常要几年才显现」",
    ]);
  });

  it("点按、处理补丁、恢复版本都生成新版本", () => {
    let s = resolvePending(demoState(), "all");
    const n = s.versions.length;
    expect(current(s).nodes.at(-1)?.label).toBe("城市蔓延程度");
    s = applyEdgeAction(s, "e3", "flip_polarity");
    expect(current(s).edges.find((e) => e.id === "e3")?.polarity).toBe("+");
    s = applyEdgeAction(s, "e7", "flip_polarity", { polarity: "-" });
    expect(current(s).edges.find((e) => e.id === "e7")?.polarity).toBe("-");
    s = restoreTo(s, s.versions[1]!.version);
    expect(s.versions).toHaveLength(n + 3);
  });
});
