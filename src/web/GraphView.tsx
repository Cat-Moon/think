// 图视图（设计文档第 9.2 节）：Cytoscape 渲染变量、关系、代码检测出的回路和补丁预览。
// 位置由 layout.ts 计算（与容器尺寸无关）；容器有了真实尺寸之后才缩放到合适大小。
import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from "cytoscape";
import { useEffect, useRef } from "react";
import type { Loop } from "../core/loops";
import type { Preview } from "../core/preview";
import type { Graph } from "../core/schema";
import { MARKER_R, NODE_H, computeLayout, markerEdges, nodeBoxes, nodeWidth, placeLoopMarkers, visibleLoopIds, type Positions } from "./layout";

export type { Positions };
export type Selection = { kind: "node" | "edge"; id: string } | null;

export interface GraphViewProps {
  graph: Graph;
  loops: Loop[];
  /** 待处理补丁的预览；有则把补丁内容画成幽灵样式 */
  preview: Preview | null;
  /** 预览中每项操作是否勾选接受（未勾选的画得更淡） */
  accepted: Record<number, boolean>;
  /** 鼠标停在补丁列表某一项上时，高亮它涉及的元素 */
  hoverOp: number | null;
  positions: Positions;
  onPositions: (p: Positions) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  highlightLoop: string | null;
  /** 鼠标停在回路列表某一项上 */
  hoverLoop: string | null;
  onLoopClick: (id: string | null) => void;
  showRejected: boolean;
}

const POL = { "+": "+", "-": "−", "?": "?" } as const;
const MAX_FIT_ZOOM = 1.6;

export const STYLE: StylesheetJson = [
  {
    selector: "node.var",
    style: {
      shape: "roundrectangle",
      "background-color": "#ffffff",
      "border-width": 1.5,
      "border-color": "#4a5568",
      label: "data(label)",
      "text-valign": "center",
      "text-halign": "center",
      "font-size": 14,
      color: "#1a202c",
      width: "data(w)",
      height: NODE_H,
    },
  },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      // 互逆或平行的边错开弯曲
      "control-point-step-size": 70,
      width: 2,
      "line-color": "#718096",
      "target-arrow-color": "#718096",
      "target-arrow-shape": "triangle",
      "arrow-scale": 1.2,
      label: "data(label)",
      "font-size": 16,
      "font-weight": "bold",
      "text-background-color": "#ffffff",
      "text-background-opacity": 1,
      "text-background-padding": "2px",
      "text-background-shape": "roundrectangle",
    },
  },
  { selector: "edge.pos", style: { "line-color": "#2b6cb0", "target-arrow-color": "#2b6cb0", color: "#2b6cb0" } },
  { selector: "edge.neg", style: { "line-color": "#c53030", "target-arrow-color": "#c53030", color: "#c53030" } },
  { selector: "edge.unk", style: { "line-color": "#718096", "target-arrow-color": "#718096", color: "#4a5568" } },
  { selector: "edge.uncertain", style: { "line-style": "dashed", "line-dash-pattern": [8, 5] } },
  { selector: "edge.contested", style: { "line-outline-width": 3, "line-outline-color": "#d6bcfa" } },
  { selector: ".rejected", style: { opacity: 0.25, "line-style": "dotted" } },
  // 补丁预览
  { selector: "node.ghost", style: { "border-style": "dashed", "border-color": "#dd6b20", "border-width": 2, "background-color": "#fffaf0" } },
  { selector: "edge.ghost", style: { "line-style": "dashed", "line-dash-pattern": [4, 4], opacity: 0.85 } },
  { selector: "edge.ghost-mod", style: { "line-outline-width": 3, "line-outline-color": "#fbd38d" } },
  { selector: "node.ghost-mod", style: { "border-color": "#dd6b20", "border-width": 3 } },
  { selector: ".ghost-remove", style: { "line-style": "dashed", "line-color": "#e53e3e", "target-arrow-color": "#e53e3e", opacity: 0.6 } },
  { selector: ".ghost-off", style: { opacity: 0.15 } },
  { selector: ".hover-op", style: { "line-outline-width": 5, "line-outline-color": "#f6ad55", "border-width": 4, "border-color": "#dd6b20" } },
  // 回路标记
  {
    selector: "node.loop",
    style: {
      shape: "ellipse",
      width: MARKER_R * 2,
      height: MARKER_R * 2,
      label: "data(label)",
      "font-size": 12,
      "font-weight": "bold",
      "text-valign": "center",
      "text-halign": "center",
      "background-color": "#ffffff",
      "border-width": 2,
    },
  },
  { selector: "node.loop.R", style: { "border-color": "#2f855a", color: "#2f855a" } },
  { selector: "node.loop.B", style: { "border-color": "#b7791f", color: "#b7791f" } },
  { selector: "node.loop.U", style: { "border-color": "#718096", color: "#718096" } },
  { selector: "node.loop.dashed", style: { "border-style": "dashed" } },
  // 选中与高亮
  { selector: ":selected", style: { "border-color": "#3182ce", "border-width": 3, "line-outline-width": 3, "line-outline-color": "#90cdf4" } },
  { selector: ".dim", style: { opacity: 0.15 } },
  { selector: "edge.hl", style: { width: 4 } },
  { selector: "node.hl", style: { "border-width": 3 } },
];

/** 图上实际显示的图：有预览时是"假装应用"之后的图 */
const viewGraph = (p: GraphViewProps) => p.preview?.after ?? p.graph;

export function buildElements(props: GraphViewProps): ElementDefinition[] {
  const { graph, preview, accepted, showRejected } = props;
  const base = viewGraph(props);
  const ghostOf = new Map<string, { op: number; effect: string }>();
  for (const o of preview?.ops ?? []) for (const id of o.elements) ghostOf.set(id, { op: o.index, effect: o.effect });

  const out: ElementDefinition[] = [];
  const liveNode = new Set<string>();
  for (const n of base.nodes) {
    const g = ghostOf.get(n.id);
    const before = graph.nodes.find((x) => x.id === n.id);
    const removedByPatch = g?.effect === "remove" && before?.status === "accepted";
    const rejected = n.status === "rejected" && !removedByPatch;
    if (rejected && !showRejected) continue;
    liveNode.add(n.id);
    const cls = ["var"];
    if (rejected) cls.push("rejected");
    if (g) cls.push(g.effect === "add" ? "ghost" : g.effect === "remove" ? "ghost-remove" : "ghost-mod");
    if (g && accepted[g.op] === false) cls.push("ghost-off");
    out.push({ group: "nodes", data: { id: n.id, label: n.label, w: nodeWidth(n.label) }, classes: cls.join(" ") });
  }
  for (const e of base.edges) {
    if (!liveNode.has(e.from) || !liveNode.has(e.to)) continue;
    const g = ghostOf.get(e.id);
    const before = graph.edges.find((x) => x.id === e.id);
    const removedByPatch = g?.effect === "remove" && before && before.status !== "rejected";
    const rejected = e.status === "rejected" && !removedByPatch;
    if (rejected && !showRejected) continue;
    const cls = [e.polarity === "+" ? "pos" : e.polarity === "-" ? "neg" : "unk"];
    if (e.status === "uncertain") cls.push("uncertain");
    if (e.contested) cls.push("contested");
    if (rejected) cls.push("rejected");
    if (g) cls.push(g.effect === "add" ? "ghost" : g.effect === "remove" ? "ghost-remove" : "ghost-mod");
    if (g && accepted[g.op] === false) cls.push("ghost-off");
    const label = `${POL[e.polarity]}${e.delay ? " ‖" : ""}${e.contested ? " ⚑" : ""}`;
    out.push({ group: "edges", data: { id: e.id, source: e.from, target: e.to, label }, classes: cls.join(" ") });
  }
  const shown = new Set(visibleLoopIds(props.loops.map((l) => l.id), props.highlightLoop, props.hoverLoop));
  for (const l of props.loops) {
    if (!shown.has(l.id)) continue;
    const cls = ["loop", l.polarity === "?" ? "U" : l.polarity];
    if (l.uncertain) cls.push("dashed");
    out.push({ group: "nodes", data: { id: `loop:${l.id}`, label: l.id, loop: l.id }, classes: cls.join(" "), grabbable: false, selectable: false });
  }
  return out;
}

export function GraphView(props: GraphViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  /** 需要在容器有尺寸后缩放到合适大小（首次打开、重新布局） */
  const needsFit = useRef(true);

  const fitIfReady = () => {
    const cy = cyRef.current;
    const el = container.current;
    if (!cy || !el || !needsFit.current || el.clientWidth === 0 || el.clientHeight === 0) return;
    const vars = cy.nodes("node.var");
    if (vars.empty()) return;
    cy.resize();
    cy.fit(vars, 50);
    if (cy.zoom() > MAX_FIT_ZOOM) {
      cy.zoom(MAX_FIT_ZOOM);
      cy.center(vars);
    }
    needsFit.current = false;
  };

  // 创建一次
  useEffect(() => {
    const cy = cytoscape({ container: container.current, style: STYLE, minZoom: 0.3, maxZoom: 2.5 });
    cyRef.current = cy;
    cy.on("tap", "node.var", (e) => propsRef.current.onSelect({ kind: "node", id: e.target.id() }));
    cy.on("tap", "edge", (e) => propsRef.current.onSelect({ kind: "edge", id: e.target.id() }));
    cy.on("tap", "node.loop", (e) => {
      const id = e.target.data("loop") as string;
      propsRef.current.onLoopClick(propsRef.current.highlightLoop === id ? null : id);
    });
    cy.on("tap", (e) => {
      if (e.target === cy) {
        propsRef.current.onSelect(null);
        propsRef.current.onLoopClick(null);
      }
    });
    cy.on("drag", "node.var", () => placeMarkers(cy, propsRef.current));
    cy.on("dragfree", "node.var", () => {
      const positions: Positions = { ...propsRef.current.positions };
      cy.nodes("node.var").forEach((n) => {
        positions[n.id()] = { x: Math.round(n.position().x), y: Math.round(n.position().y) };
      });
      propsRef.current.onPositions(positions);
    });
    // 容器尺寸确定或变化时：更新 Cytoscape 的尺寸；首次有尺寸时缩放到合适大小
    const ro = new ResizeObserver(() => {
      cy.resize();
      fitIfReady();
    });
    if (container.current) ro.observe(container.current);
    return () => {
      ro.disconnect();
      cy.destroy();
    };
  }, []);

  // 内容变化：重建元素，计算缺少的位置（已有位置不动），保留缩放和平移
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const g = viewGraph(props);
    if (Object.keys(props.positions).length === 0) needsFit.current = true;
    const pos = computeLayout(g, props.positions, props.showRejected);
    cy.batch(() => {
      cy.elements().remove();
      cy.add(buildElements(props));
      cy.nodes("node.var").forEach((n) => {
        const p = pos[n.id()];
        if (p) n.position({ ...p });
      });
    });
    placeMarkers(cy, props);
    applyHighlight(cy, props);
    fitIfReady();
    if (Object.keys(pos).some((id) => !props.positions[id])) props.onPositions({ ...props.positions, ...pos });
  }, [props.graph, props.preview, props.accepted, props.showRejected, props.loops, props.positions]);

  // 选中、高亮或悬停回路、补丁项悬停
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const shown = new Set(visibleLoopIds(props.loops.map((l) => l.id), props.highlightLoop, props.hoverLoop));
    const present = new Set(cy.nodes("node.loop").map((n) => n.data("loop") as string));
    if ([...shown].some((id) => !present.has(id)) || [...present].some((id) => !shown.has(id))) {
      cy.nodes("node.loop").remove();
      cy.add(buildElements(props).filter((e) => String(e.classes).includes("loop")));
    }
    placeMarkers(cy, props);
    applyHighlight(cy, props);
  }, [props.selection, props.highlightLoop, props.hoverLoop, props.hoverOp]);

  return <div ref={container} className="graph" />;
}

/** 回路标记放在回路附近、避开所有节点和其他标记 */
function placeMarkers(cy: Core, props: GraphViewProps) {
  const markers = cy.nodes("node.loop");
  if (markers.empty()) return;
  const current: Positions = {};
  cy.nodes("node.var").forEach((n) => {
    current[n.id()] = n.position();
  });
  const boxes = nodeBoxes(viewGraph(props), current, props.showRejected);
  const ids = new Set(markers.map((m) => m.data("loop") as string));
  const placed = placeLoopMarkers(props.loops.filter((l) => ids.has(l.id)), boxes, markerEdges(viewGraph(props), props.showRejected));
  markers.forEach((m) => {
    const p = placed[m.data("loop") as string];
    if (p) m.position(p);
  });
}

function applyHighlight(cy: Core, props: GraphViewProps) {
  cy.batch(() => {
    cy.elements().removeClass("dim hl hover-op").unselect();
    if (props.selection) cy.getElementById(props.selection.id).select();
    const loop = props.loops.find((l) => l.id === (props.highlightLoop ?? props.hoverLoop));
    if (loop) {
      const keep = cy.collection();
      for (const id of [...loop.nodes, ...loop.edges, `loop:${loop.id}`]) keep.merge(cy.getElementById(id));
      cy.elements().difference(keep).addClass("dim");
      keep.addClass("hl");
    }
    const op = props.preview?.ops.find((o) => o.index === props.hoverOp);
    for (const id of op?.elements ?? []) cy.getElementById(id).addClass("hover-op");
  });
}
