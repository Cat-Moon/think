// 边的路由：弯曲量与标签位置（设计文档第 9.2.1 节）。
//
// 每条边画成二次贝塞尔曲线（Cytoscape 的 unbundled-bezier：控制点在两端连线中点的法向上，距离为 d；
// 曲线最大偏移约为 d / 2）。d = 0 时是直线。
// - 同一对变量之间的多条边（互逆、平行）分到两侧
// - 穿过其他变量、或与其他边重叠（共线）的边，改为弯曲，依次尝试不同的 d
// - 标签沿边滑动：避开变量、其他边（含交叉点）、其他标签和箭头
import type { Graph } from "../core/schema";
import { ARROW_ZONE, LABEL_H, NODE_GAP, boxGap, computeLayout, edgeLabelText, labelWidth, layoutNodes, nodeBoxes, segmentDistance, type Box, type Positions } from "./layout";

export { ARROW_ZONE, LABEL_H, labelWidth };

/**
 * 控制点方向：d > 0 时控制点所在的一侧。屏幕坐标 y 向下，法向取 (-dy, dx) * CP_SIGN。
 * 由截图脚本在浏览器中与 Cytoscape 实际的控制点逐条核对。
 */
export const CP_SIGN = 1;
/** 同一对变量之间多条边的控制点间距 */
export const PAIR_SPREAD = 140;
const CANDIDATE_D = [70, -70, 110, -110, 150, -150, 200, -200, 260, -260];
const NODE_CLEARANCE = 8;
const EDGE_OVERLAP_DIST = 7;

export type Pt = { x: number; y: number };

export interface EdgeRoute {
  id: string;
  from: string;
  to: string;
  /** 控制点到两端连线中点的距离（control-point-distances） */
  d: number;
  /** 标签中心到路径起点（起点变量外框边缘）沿路径的距离 */
  labelOffset: number;
  /** 标签中心的坐标 */
  labelAt: Pt;
}

export type RouteIssueKind = "through_node" | "overlap_edge" | "label_on_node" | "label_on_edge" | "label_on_arrow" | "label_on_label";
export interface RouteIssue {
  kind: RouteIssueKind;
  edge: string;
  other: string;
}

export interface RouteInput {
  id: string;
  from: string;
  to: string;
  label: string;
}

/** 从外框中心 c 朝 toward 方向，与外框边缘的交点 */
function exitPoint(c: Box, toward: Pt): Pt {
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const t = Math.min(Math.abs(dx) > 0.01 ? c.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 0.01 ? c.h / 2 / Math.abs(dy) : Infinity);
  return Number.isFinite(t) ? { x: c.x + dx * t, y: c.y + dy * t } : { x: c.x, y: c.y };
}

/**
 * 控制点：两端外框边缘交点的中点，沿法向偏移 d（与 Cytoscape 的 unbundled-bezier 一致，
 * 截图脚本在浏览器中逐条核对，偏差为 0）。
 */
export function controlPoint(a: Box, b: Box, d: number): Pt {
  const pa = exitPoint(a, b);
  const pb = exitPoint(b, a);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: (pa.x + pb.x) / 2 + (CP_SIGN * -dy * d) / len, y: (pa.y + pb.y) / 2 + (CP_SIGN * dx * d) / len };
}

const inBox = (p: Pt, b: Box, pad = 0) => Math.abs(p.x - b.x) <= b.w / 2 + pad && Math.abs(p.y - b.y) <= b.h / 2 + pad;

/**
 * 边的实际路径，按约 6px 的间距采样。与 Cytoscape 一致（截图脚本在浏览器中核对，偏差约 1px）：
 * 二次贝塞尔曲线从"起点外框朝控制点方向的交点"出发，经过控制点，到"终点外框朝控制点方向的交点"。
 * 标签的 source-text-offset 是沿这条曲线、从起点量的弧长。
 */
export function edgePath(a: Box, b: Box, d: number): Pt[] {
  const c = controlPoint(a, b, d);
  const p0 = exitPoint(a, c);
  const p2 = exitPoint(b, c);
  const approx = Math.hypot(p2.x - p0.x, p2.y - p0.y) + Math.abs(d);
  const n = Math.max(20, Math.ceil(approx / 6));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y });
  }
  return pts;
}

export function pathLength(pts: Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return s;
}

export function pointAt(pts: Pt[], s: number): Pt {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    if (acc + seg >= s) {
      const t = seg ? (s - acc) / seg : 0;
      return { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t };
    }
    acc += seg;
  }
  return pts.at(-1) ?? { x: 0, y: 0 };
}

function polyDistance(p: Pt, pts: Pt[]): number {
  let m = Infinity;
  for (let i = 1; i < pts.length; i++) m = Math.min(m, segmentDistance(p, pts[i - 1]!, pts[i]!));
  return m;
}

/** 路径穿过的非端点变量 */
export function throughNodes(path: Pt[], from: string, to: string, boxes: Map<string, Box>): string[] {
  const hit: string[] = [];
  for (const [id, b] of boxes) {
    if (id === from || id === to) continue;
    if (path.some((p) => inBox(p, b, NODE_CLEARANCE))) hit.push(id);
  }
  return hit;
}

/** 两条路径是否有一段重叠：连续约 24px 以上相距不到 7px（去掉两端各两个采样点，避免共用端点处误报） */
export function overlaps(p1: Pt[], p2: Pt[]): boolean {
  if (p1.length < 6 || p2.length < 2) return false;
  let run = 0;
  for (let i = 2; i < p1.length - 2; i++) {
    if (polyDistance(p1[i]!, p2) < EDGE_OVERLAP_DIST) {
      if (++run >= 4) return true;
    } else run = 0;
  }
  return false;
}

export function routeInputs(graph: Graph, showRejected = false): RouteInput[] {
  const live = new Set(layoutNodes(graph, showRejected).map((n) => n.id));
  return graph.edges
    .filter((e) => (showRejected || e.status !== "rejected") && live.has(e.from) && live.has(e.to) && e.from !== e.to)
    .map((e) => ({ id: e.id, from: e.from, to: e.to, label: edgeLabelText(e) }));
}

/** 计算每条边的弯曲量和标签位置；同时返回仍然存在的问题（理想情况下为空） */
export function routeEdges(
  edges: RouteInput[],
  boxes: Map<string, Box>,
  /** reroute: false 时不为了避让而弯曲（只把多条边分到两侧），用于对比 */
  opts: { reroute?: boolean } = {},
): { routes: Map<string, EdgeRoute>; issues: RouteIssue[] } {
  const usable = edges.filter((e) => boxes.has(e.from) && boxes.has(e.to));
  const d = new Map<string, number>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const groups = new Map<string, RouteInput[]>();
  for (const e of usable) groups.set(key(e.from, e.to), [...(groups.get(key(e.from, e.to)) ?? []), e]);

  // 1. 同一对变量之间的多条边：分到两侧（反向的边法向相反，所以取相反数）
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.forEach((e, i) => {
      const o = (i - (g.length - 1) / 2) * PAIR_SPREAD;
      d.set(e.id, e.from < e.to ? o : -o);
    });
  }
  const path = (e: RouteInput, dd = d.get(e.id) ?? 0) => edgePath(boxes.get(e.from)!, boxes.get(e.to)!, dd);

  // 2. 穿过变量或与其他边重叠的边：尝试其他弯曲量（多条边的组只整体放大）
  const score = (e: RouteInput, dd: number) => {
    const p = path(e, dd);
    let s = throughNodes(p, e.from, e.to, boxes).length * 10;
    for (const o of usable) if (o.id !== e.id && overlaps(p, path(o))) s += 3;
    return s + Math.abs(dd) / 1000; // 同样没问题时，弯得越少越好
  };
  for (let round = 0; round < (opts.reroute === false ? 0 : 3); round++) {
    let changed = false;
    for (const e of usable) {
      const cur = d.get(e.id) ?? 0;
      let bestScore = score(e, cur);
      if (bestScore < 1) continue;
      const inGroup = (groups.get(key(e.from, e.to))?.length ?? 1) > 1;
      const candidates = inGroup ? [cur * 1.5, cur * 2, cur * 2.6] : CANDIDATE_D;
      let best = cur;
      for (const c of candidates) {
        const s = score(e, c);
        if (s < bestScore) {
          best = c;
          bestScore = s;
        }
      }
      if (best !== cur) {
        d.set(e.id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 3. 标签：从中点向两侧滑动，找第一个不压变量、不压其他边、不压其他标签、不压箭头的位置
  const paths = new Map(usable.map((e) => [e.id, path(e)]));
  const routes = new Map<string, EdgeRoute>();
  const placedLabels: Box[] = [];
  const issues: RouteIssue[] = [];
  for (const e of usable) {
    const p = paths.get(e.id)!;
    const L = pathLength(p);
    const w = labelWidth(e.label);
    const lo = w / 2 + 2;
    const hi = L - ARROW_ZONE - w / 2;
    const mid = Math.max(lo, Math.min(hi, L / 2));
    const candidates: number[] = [];
    for (let k = 0; k <= 80; k++) for (const s of k ? [mid + k * 3, mid - k * 3] : [mid]) if (s >= lo && s <= hi) candidates.push(s);
    if (!candidates.length) candidates.push(Math.max(0, L - ARROW_ZONE - w / 2));
    const check = (s: number): RouteIssue[] => {
      const at = pointAt(p, s);
      const box: Box = { x: at.x, y: at.y, w, h: LABEL_H };
      const found: RouteIssue[] = [];
      for (const [id, b] of boxes) if (boxGap(box, b) < 2) found.push({ kind: "label_on_node", edge: e.id, other: id });
      for (const o of usable) {
        if (o.id === e.id) continue;
        if (paths.get(o.id)!.some((q) => inBox(q, box, 2))) found.push({ kind: "label_on_edge", edge: e.id, other: o.id });
      }
      for (const l of placedLabels) if (boxGap(box, l) < 2) found.push({ kind: "label_on_label", edge: e.id, other: "" });
      if (s > L - ARROW_ZONE - w / 2 + 0.5) found.push({ kind: "label_on_arrow", edge: e.id, other: "" });
      return found;
    };
    let chosen = candidates[0]!;
    let chosenIssues = check(chosen);
    for (const s of candidates) {
      if (!chosenIssues.length) break;
      const f = check(s);
      if (f.length < chosenIssues.length) {
        chosen = s;
        chosenIssues = f;
      }
    }
    const at = pointAt(p, chosen);
    placedLabels.push({ x: at.x, y: at.y, w, h: LABEL_H });
    routes.set(e.id, { id: e.id, from: e.from, to: e.to, d: d.get(e.id) ?? 0, labelOffset: Math.round(chosen), labelAt: at });
    issues.push(...chosenIssues);
  }

  // 4. 最终检查：穿过变量、与其他边重叠
  for (const e of usable) {
    const p = paths.get(e.id)!;
    for (const id of throughNodes(p, e.from, e.to, boxes)) issues.push({ kind: "through_node", edge: e.id, other: id });
    for (const o of usable) if (o.id > e.id && overlaps(p, paths.get(o.id)!)) issues.push({ kind: "overlap_edge", edge: e.id, other: o.id });
  }
  return { routes, issues };
}

export interface Arrangement {
  positions: Positions;
  routes: Map<string, EdgeRoute>;
  issues: RouteIssue[];
}

/**
 * 布局 + 路由。路由之后仍有问题时（例如新节点恰好落在已有边的延长线上），
 * 为可移动的节点（fixed 之外的；从零布局时为与问题有关的节点）在周围找候选位置，
 * 选路由问题最少的那个。fixed 中的节点始终不动。
 */
export function arrange(graph: Graph, fixed: Positions = {}, showRejected = false): Arrangement {
  let pos = computeLayout(graph, fixed, showRejected);
  const inputs = routeInputs(graph, showRejected);
  const run = (ps: Positions) => routeEdges(inputs, nodeBoxes(graph, ps, showRejected));
  let r = run(pos);
  if (!r.issues.length) return { positions: pos, routes: r.routes, issues: r.issues };

  const hasFixed = Object.keys(fixed).length > 0;
  const involved = new Set(
    r.issues.flatMap((i) => {
      const e = inputs.find((x) => x.id === i.edge);
      return e ? [e.from, e.to, i.other] : [];
    }),
  );
  const movable = Object.keys(pos).filter((id) => !fixed[id] && (hasFixed || involved.has(id)));
  for (const id of movable) {
    // 快速评分：与 id 相连的边按直线计算，是否穿过其他变量、是否与其他边重叠
    const quick = (ps: Positions) => {
      const boxes = nodeBoxes(graph, ps, showRejected);
      const straight = new Map(inputs.filter((e) => boxes.has(e.from) && boxes.has(e.to)).map((e) => [e.id, edgePath(boxes.get(e.from)!, boxes.get(e.to)!, 0)]));
      let score = 0;
      for (const e of inputs) {
        if (e.from !== id && e.to !== id) continue;
        const p = straight.get(e.id);
        if (!p) continue;
        score += throughNodes(p, e.from, e.to, boxes).length;
        for (const [oid, op] of straight) if (oid !== e.id && (overlaps(p, op) || overlaps(op, p))) score++;
      }
      // 其他边是否穿过 id 的外框
      const own = boxes.get(id);
      if (own) for (const e of inputs) if (e.from !== id && e.to !== id && straight.has(e.id) && throughNodes(straight.get(e.id)!, e.from, e.to, new Map([[id, own]])).length) score++;
      return score;
    };
    const boxOf = (ps: Positions) => nodeBoxes(graph, ps, showRejected);
    let best = pos;
    let bestScore = quick(pos);
    const base = pos[id]!;
    search: for (let radius = 40; radius <= 480 && bestScore > 0; radius += 40) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const cand = { ...pos, [id]: { x: Math.round(base.x + Math.cos(a) * radius), y: Math.round(base.y + Math.sin(a) * radius * 0.7) } };
        const boxes = boxOf(cand);
        const me = boxes.get(id)!;
        if (![...boxes].every(([o, b]) => o === id || boxGap(me, b) >= NODE_GAP)) continue;
        const sc = quick(cand);
        if (sc < bestScore) {
          best = cand;
          bestScore = sc;
          if (!sc) break search;
        }
      }
    }
    if (best !== pos) {
      const rr = run(best);
      if (rr.issues.length < r.issues.length) {
        pos = best;
        r = rr;
      }
    }
    if (!r.issues.length) break;
  }
  return { positions: pos, routes: r.routes, issues: r.issues };
}
