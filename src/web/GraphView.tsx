// 图视图（设计文档第 9.2 节）：Cytoscape 渲染变量、关系、代码检测出的回路和补丁预览。
// 位置由 layout.ts 计算（与容器尺寸无关）；容器有了真实尺寸之后才缩放到合适大小。
// 已有变量的位置不会自动移动：新变量只在周围找位置；仍有关系穿过变量时提示"重新布局"。
import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from "cytoscape";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Loop } from "../core/loops";
import type { Preview } from "../core/preview";
import type { Graph } from "../core/schema";
import { MARKER_R, MAX_ALWAYS_SHOWN_LOOPS, NODE_H, edgeLabelText, nodeBoxes, nodeWidth, placeLoopMarkers, visibleLoopIds, type Positions } from "./layout";
import { arrange, edgePath, routeEdges, routeInputs, type EdgeRoute, type RouteIssue } from "./routing";

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
  /** 回路较多时，是否在图上显示全部回路标记（画布左上角的提示切换） */
  showAllLoops: boolean;
  onToggleAllLoops: () => void;
  /** 只读（查看旧版本）：不能拖动、不能编辑，位置不保存 */
  readOnly?: boolean;
  /** 连线模式：依次点击两个变量，新增一条关系 */
  connectMode?: boolean;
  /** rendered：终点变量在画布上的屏幕坐标（用来放极性选择） */
  onConnect?: (from: string, to: string, rendered: { x: number; y: number }) => void;
  /** 双击空白处（模型坐标和相对画布的屏幕坐标） */
  onCanvasDblClick?: (model: { x: number; y: number }, rendered: { x: number; y: number }) => void;
  /** 有关系穿过变量或互相重叠时（已有变量不会自动移动），提示重新布局 */
  onRelayout?: () => void;
  /** 叠在画布上的内容（图例、输入框等） */
  children?: ReactNode;
}

const MAX_FIT_ZOOM = 2.0;
/** 变量名 14px：缩放不低于 12/14，保证屏幕上不小于 12px（图放不下时可以拖动画布） */
const NODE_FONT = 14;
export const MIN_ZOOM = 12 / NODE_FONT;
const ORANGE = "#dd6b20";

/** 需要提示"重新布局"的问题：边穿过变量、边互相重叠（标签会自动滑开，不提示） */
const seriousIssues = (issues: RouteIssue[]) => issues.filter((i) => i.kind === "through_node" || i.kind === "overlap_edge");

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
      "font-size": NODE_FONT,
      color: "#1a202c",
      width: "data(w)",
      height: NODE_H,
    },
  },
  {
    selector: "edge",
    style: {
      // 弯曲量由 routing.ts 决定：互逆或平行的边分到两侧，穿过变量或与其他边重叠的边绕开
      "curve-style": "unbundled-bezier",
      "control-point-distances": "data(cpd)",
      "control-point-weights": 0.5,
      width: 2,
      "line-color": "#718096",
      "target-arrow-color": "#718096",
      "target-arrow-shape": "triangle",
      "arrow-scale": 1.2,
      // 标签沿边滑动到 routing.ts 选好的位置（离起点的距离），避开变量、其他边和箭头
      "source-label": "data(label)",
      "source-text-offset": "data(lo)" as unknown as number,
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
  // 有争议：紫色描边加 ⚑（与 AI 建议的橙色、选中的蓝色区分）
  { selector: "edge.contested", style: { "line-outline-width": 3, "line-outline-color": "#d6bcfa" } },
  // 已拒绝（打开"显示已拒绝的"时）：淡灰色实线（虚线只用于"不确定"）
  { selector: ".rejected", style: { opacity: 0.25, "line-color": "#a0aec0", "target-arrow-color": "#a0aec0" } },
  // 补丁预览一律用橙色：新增为橙色实线 / 橙色边框加浅橙底；修改为粗橙色描边加"改"；去掉为淡红色实线并加 ✕
  { selector: "node.ghost", style: { "border-color": ORANGE, "border-width": 2.5, "background-color": "#fffaf0" } },
  { selector: "edge.ghost", style: { "line-color": ORANGE, "target-arrow-color": ORANGE } },
  {
    selector: "edge.ghost-mod",
    style: {
      width: 3,
      "line-outline-width": 5,
      "line-outline-color": "#f6ad55",
      "text-border-width": 2,
      "text-border-color": ORANGE,
      "text-border-opacity": 1,
      "text-background-color": "#fffaf0",
    },
  },
  { selector: "node.ghost-mod", style: { "border-color": ORANGE, "border-width": 4, "background-color": "#fffaf0" } },
  { selector: ".ghost-remove", style: { "line-color": "#e53e3e", "target-arrow-color": "#e53e3e", "border-color": "#e53e3e", opacity: 0.45 } },
  { selector: ".ghost-off", style: { opacity: 0.15 } },
  { selector: ".hover-op", style: { "line-outline-width": 5, "line-outline-color": "#f6ad55", "border-width": 4, "border-color": "#dd6b20" } },
  // 连线模式中选中的起点
  { selector: "node.connect-src", style: { "border-color": "#3182ce", "border-width": 4, "background-color": "#ebf8ff" } },
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
    const label = `${edgeLabelText(e)}${g?.effect === "remove" ? " ✕" : g?.effect === "modify" ? " 改" : ""}`;
    out.push({ group: "edges", data: { id: e.id, source: e.from, target: e.to, label, cpd: 0, lo: 20 }, classes: cls.join(" ") });
  }
  const shown = new Set(visibleLoopIds(props.loops.map((l) => l.id), props.highlightLoop, props.hoverLoop, props.showAllLoops));
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
  /** 连线模式中已选的起点 */
  const connectFrom = useRef<string | null>(null);
  const [issueCount, setIssueCount] = useState(0);
  const [connectHint, setConnectHint] = useState<string | null>(null);

  const fitIfReady = () => {
    const cy = cyRef.current;
    const el = container.current;
    if (!cy || !el || !needsFit.current || el.clientWidth === 0 || el.clientHeight === 0) return;
    const vars = cy.nodes("node.var");
    if (vars.empty()) return;
    cy.resize();
    // 缩放到合适大小，并给展开的图例留出底部空间（小窗口里图例不压住图）
    const legend = el.parentElement?.querySelector(".legend[open]") as HTMLElement | null;
    const reserve = legend ? legend.offsetHeight + 12 : 0;
    const pad = 50;
    const bb = vars.boundingBox();
    const w = el.clientWidth;
    const h = Math.max(el.clientHeight - reserve, el.clientHeight * 0.5);
    const z = Math.max(cy.minZoom(), Math.min(MAX_FIT_ZOOM, (w - 2 * pad) / Math.max(bb.w, 1), (h - 2 * pad) / Math.max(bb.h, 1)));
    cy.zoom(z);
    cy.pan({ x: w / 2 - z * (bb.x1 + bb.w / 2), y: h / 2 - z * (bb.y1 + bb.h / 2) });
    needsFit.current = false;
  };

  const clearConnect = (cy: Core) => {
    cy.nodes().removeClass("connect-src");
    connectFrom.current = null;
    setConnectHint(propsRef.current.connectMode ? "点击起点变量" : null);
  };

  // 创建一次
  useEffect(() => {
    const cy = cytoscape({ container: container.current, style: STYLE, minZoom: MIN_ZOOM, maxZoom: 3 });
    cyRef.current = cy;
    // 新的实例总要缩放一次（开发模式下 StrictMode 会销毁并重建实例）
    needsFit.current = true;
    // 开发时供截图脚本核对几何（控制点、标签位置）
    if (import.meta.env.DEV) (window as unknown as { __cy?: Core }).__cy = cy;
    cy.on("tap", "node.var", (e) => {
      const p = propsRef.current;
      const id = e.target.id() as string;
      if (p.connectMode && !p.readOnly) {
        const from = connectFrom.current;
        if (!from) {
          connectFrom.current = id;
          e.target.addClass("connect-src");
          setConnectHint(`起点「${String(e.target.data("label"))}」，再点击终点变量`);
        } else if (from !== id) {
          clearConnect(cy);
          p.onConnect?.(from, id, { ...e.target.renderedPosition() });
        }
        return;
      }
      p.onSelect({ kind: "node", id });
    });
    cy.on("tap", "edge", (e) => propsRef.current.onSelect({ kind: "edge", id: e.target.id() }));
    cy.on("tap", "node.loop", (e) => {
      const id = e.target.data("loop") as string;
      propsRef.current.onLoopClick(propsRef.current.highlightLoop === id ? null : id);
    });
    cy.on("tap", (e) => {
      if (e.target === cy) {
        propsRef.current.onSelect(null);
        propsRef.current.onLoopClick(null);
        if (connectFrom.current) clearConnect(cy);
      }
    });
    cy.on("dbltap", (e) => {
      const p = propsRef.current;
      if (e.target !== cy || p.readOnly || !p.onCanvasDblClick) return;
      p.onCanvasDblClick({ ...e.position }, { ...e.renderedPosition });
    });
    cy.on("drag", "node.var", () => placeMarkers(cy, propsRef.current));
    cy.on("dragfree", "node.var", () => {
      setIssueCount(seriousIssues(applyRoutes(cy, propsRef.current)).length);
      placeMarkers(cy, propsRef.current);
      if (propsRef.current.readOnly) return;
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
    const incremental = Object.keys(props.positions).length > 0;
    if (!incremental) needsFit.current = true;
    const { positions: pos } = arrange(g, props.positions, props.showRejected);
    cy.batch(() => {
      cy.elements().remove();
      cy.add(buildElements(props));
      cy.nodes("node.var").forEach((n) => {
        const p = pos[n.id()];
        if (p) n.position({ ...p });
      });
    });
    cy.autoungrabify(Boolean(props.readOnly));
    const issues = seriousIssues(applyRoutes(cy, props));
    // 从零布局时 arrange 已尽量消除问题；增量布局时已有变量不动，剩下的问题提示用户重新布局
    setIssueCount(incremental ? issues.length : 0);
    placeMarkers(cy, props);
    applyHighlight(cy, props);
    fitIfReady();
    // 新变量有了位置，或重叠的变量被放开、重新找了位置：保存
    const changed = Object.keys(pos).some((id) => !props.positions[id] || props.positions[id]!.x !== pos[id]!.x || props.positions[id]!.y !== pos[id]!.y);
    if (!props.readOnly && changed) props.onPositions({ ...props.positions, ...pos });
  }, [props.graph, props.preview, props.accepted, props.showRejected, props.loops, props.positions, props.readOnly]);

  // 连线模式开关
  useEffect(() => {
    const cy = cyRef.current;
    connectFrom.current = null;
    cy?.nodes().removeClass("connect-src");
    setConnectHint(props.connectMode ? "点击起点变量" : null);
  }, [props.connectMode]);

  // 选中、高亮或悬停回路、补丁项悬停
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const shown = new Set(visibleLoopIds(props.loops.map((l) => l.id), props.highlightLoop, props.hoverLoop, props.showAllLoops));
    const present = new Set(cy.nodes("node.loop").map((n) => n.data("loop") as string));
    if ([...shown].some((id) => !present.has(id)) || [...present].some((id) => !shown.has(id))) {
      cy.nodes("node.loop").remove();
      cy.add(buildElements(props).filter((e) => String(e.classes).includes("loop")));
    }
    placeMarkers(cy, props);
    applyHighlight(cy, props);
  }, [props.selection, props.highlightLoop, props.hoverLoop, props.hoverOp, props.showAllLoops]);

  const many = props.loops.length > MAX_ALWAYS_SHOWN_LOOPS;
  return (
    <div className={`graph-wrap${props.connectMode ? " connecting" : ""}`}>
      <div ref={container} className="graph" />
      <div className="canvas-hints">
        {many && (
          <button className="loop-hint" onClick={props.onToggleAllLoops}>
            {props.showAllLoops ? "收起回路标记" : `${props.loops.length} 个回路 · 点击查看`}
          </button>
        )}
        {issueCount > 0 && !props.readOnly && props.onRelayout && (
          <button className="relayout-hint" onClick={props.onRelayout} title="已有变量的位置不会自动移动；重新布局会重新排列所有变量">
            有 {issueCount} 处关系穿过变量或重叠 · 重新布局
          </button>
        )}
        {connectHint && <span className="connect-hint">连线：{connectHint}</span>}
      </div>
      {props.children}
    </div>
  );
}

function currentPositions(cy: Core): Positions {
  const out: Positions = {};
  cy.nodes("node.var").forEach((n) => {
    out[n.id()] = { ...n.position() };
  });
  return out;
}

/** 当前位置下的边路由（只针对图上显示的边） */
function routeFor(cy: Core, props: GraphViewProps): { routes: Map<string, EdgeRoute>; issues: RouteIssue[] } {
  const g = viewGraph(props);
  const shownEdges = new Set(cy.edges().map((e) => e.id()));
  // 标签按图上实际显示的文字计算宽度（预览中带"改"或 ✕）
  const inputs = routeInputs(g, props.showRejected)
    .filter((e) => shownEdges.has(e.id))
    .map((e) => ({ ...e, label: String(cy.getElementById(e.id).data("label") ?? e.label) }));
  return routeEdges(inputs, nodeBoxes(g, currentPositions(cy), props.showRejected));
}

/** 把每条边的弯曲量和标签位置写进元素数据；返回仍然存在的问题 */
function applyRoutes(cy: Core, props: GraphViewProps): RouteIssue[] {
  const { routes, issues } = routeFor(cy, props);
  cy.batch(() => {
    for (const r of routes.values()) cy.getElementById(r.id).data({ cpd: r.d, lo: r.labelOffset });
  });
  return issues;
}

/** 回路标记放在回路附近、避开所有节点和其他标记 */
function placeMarkers(cy: Core, props: GraphViewProps) {
  const markers = cy.nodes("node.loop");
  if (markers.empty()) return;
  const boxes = nodeBoxes(viewGraph(props), currentPositions(cy), props.showRejected);
  const paths = [...routeFor(cy, props).routes.values()].flatMap((r) => (boxes.has(r.from) && boxes.has(r.to) ? [edgePath(boxes.get(r.from)!, boxes.get(r.to)!, r.d)] : []));
  const ids = new Set(markers.map((m) => m.data("loop") as string));
  const placed = placeLoopMarkers(props.loops.filter((l) => ids.has(l.id)), boxes, paths);
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
