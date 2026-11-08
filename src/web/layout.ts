// 自动布局（设计文档第 9.2.1 节）。与界面分离：在无界面的 Cytoscape 上运行 fcose，不依赖容器尺寸，
// 因此测试和浏览器用的是同一份代码。
// - 节点的实际尺寸（宽度随标签长度变化）计入避让，布局后再做一次去重叠，保证外框之间留有间距
// - 已有位置的节点固定不动，只给新节点找位置
// - 随机数用固定种子：同一张图每次布局结果相同
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import type { Graph } from "../core/schema";

cytoscape.use(fcose);

export type Positions = Record<string, { x: number; y: number }>;

export const NODE_H = 40;
/** 节点宽度：按字符数估算（中文约 15px / 字，字号 14），两侧留白 */
export const nodeWidth = (label: string) => Math.max(72, [...label].length * 15 + 32);
/** 节点外框之间至少留出的间距 */
export const NODE_GAP = 56;
export const MARKER_R = 16;
/** 边的标签高度、宽度估算；箭头附近不放标签的长度 */
export const LABEL_H = 20;
export const ARROW_ZONE = 26;
export const labelWidth = (text: string) => [...text].length * 10 + 10;
const POL_TEXT = { "+": "+", "-": "−", "?": "?" } as const;
export const edgeLabelText = (e: { polarity: "+" | "-" | "?"; delay: boolean; contested: boolean }) =>
  `${POL_TEXT[e.polarity]}${e.delay ? " ‖" : ""}${e.contested ? " ⚑" : ""}`;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 参与布局的节点：已接受的；showRejected 时也包括已拒绝的 */
export function layoutNodes(graph: Graph, showRejected = false) {
  return graph.nodes.filter((n) => showRejected || n.status === "accepted");
}

export function nodeBoxes(graph: Graph, positions: Positions, showRejected = false): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const n of layoutNodes(graph, showRejected)) {
    const p = positions[n.id];
    if (p) boxes.set(n.id, { x: p.x, y: p.y, w: nodeWidth(n.label), h: NODE_H });
  }
  return boxes;
}

/** 两个外框之间的间隙（负数表示重叠） */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
  const dy = Math.abs(a.y - b.y) - (a.h + b.h) / 2;
  return Math.max(dx, dy);
}

/** 固定种子的伪随机数（mulberry32） */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withSeededRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  Math.random = seeded(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

/**
 * 计算布局：fixed 中已有位置的节点不动，只给其余节点找位置。
 * 返回所有参与布局的节点的位置（含 fixed 中的）。
 */
export function computeLayout(graph: Graph, fixed: Positions = {}, showRejected = false): Positions {
  const nodes = layoutNodes(graph, showRejected);
  const ids = new Set(nodes.map((n) => n.id));
  const missing = nodes.filter((n) => !fixed[n.id]);
  const result: Positions = {};
  for (const n of nodes) if (fixed[n.id]) result[n.id] = { ...fixed[n.id]! };
  if (!missing.length) return result;

  const edges = graph.edges.filter((e) => e.status !== "rejected" && ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const hasFixed = Object.keys(result).length > 0;

  // 新节点的初始位置：已有邻居的中心附近；没有邻居就放在已有节点的右下方
  const initial: Positions = Object.fromEntries(Object.entries(result).map(([id, p]) => [id, { ...p }]));
  if (hasFixed) {
    const all = Object.values(result);
    const cx = all.reduce((s, p) => s + p.x, 0) / all.length;
    const cy0 = all.reduce((s, p) => s + p.y, 0) / all.length;
    missing.forEach((n, i) => {
      const nbrs = edges.flatMap((e) => (e.from === n.id ? [e.to] : e.to === n.id ? [e.from] : [])).filter((id) => result[id]);
      const c = nbrs.length ? { x: nbrs.reduce((s, id) => s + result[id]!.x, 0) / nbrs.length, y: nbrs.reduce((s, id) => s + result[id]!.y, 0) / nbrs.length } : { x: cx, y: cy0 };
      initial[n.id] = { x: c.x + 120 + i * 40, y: c.y + 90 + i * 40 };
    });
  }

  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    style: [{ selector: "node", style: { shape: "roundrectangle", width: "data(w)", height: NODE_H } }],
    elements: [
      ...nodes.map((n) => ({ group: "nodes" as const, data: { id: n.id, w: nodeWidth(n.label) }, position: { ...(initial[n.id] ?? { x: 0, y: 0 }) } })), // 传副本：Cytoscape 会就地改写坐标
      ...edges.map((e) => ({ group: "edges" as const, data: { id: e.id, source: e.from, target: e.to } })),
    ],
  });

  withSeededRandom(nodes.length * 7919 + edges.length, () => {
    cy.layout({
      name: "fcose",
      quality: "proof",
      randomize: !hasFixed,
      animate: false,
      fit: false,
      nodeDimensionsIncludeLabels: false,
      uniformNodeDimensions: false,
      packComponents: true,
      nodeSeparation: 120,
      idealEdgeLength: () => 200,
      edgeElasticity: () => 0.3,
      nodeRepulsion: () => 12000,
      gravity: 0.2,
      numIter: 4000,
      tile: true,
      // 传副本：fcose 会就地改写约束中的坐标
      fixedNodeConstraint: hasFixed ? Object.entries(result).map(([nodeId, position]) => ({ nodeId, position: { ...position } })) : undefined,
    } as cytoscape.LayoutOptions).run();
  });

  const placed: Positions = {};
  cy.nodes().forEach((n) => {
    placed[n.id()] = { ...n.position() };
  });
  cy.destroy();
  // 固定节点以原位置为准（约束求解可能有微小偏差）
  for (const id of Object.keys(result)) placed[id] = { ...result[id]! };

  const movable = new Set(missing.map((n) => n.id));
  const sized = nodes.map((n) => ({ id: n.id, w: nodeWidth(n.label) }));
  removeOverlaps(placed, sized, movable);
  if (!hasFixed) normalizeAspect(placed, sized);
  ensureEdgeRoom(placed, sized, edges, movable);
  removeOverlaps(placed, sized, movable);
  settleStuck(placed, sized, movable);
  for (const id of Object.keys(placed)) placed[id] = { x: Math.round(placed[id]!.x), y: Math.round(placed[id]!.y) };
  return placed;
}

/** 适合横向屏幕的长宽比范围 */
export const ASPECT_MIN = 0.8;
export const ASPECT_MAX = 2.4;

function bbox(pos: Positions, nodes: { id: string; w: number }[]) {
  const xs = nodes.flatMap((n) => [pos[n.id]!.x - n.w / 2, pos[n.id]!.x + n.w / 2]);
  const ys = nodes.flatMap((n) => [pos[n.id]!.y - NODE_H / 2, pos[n.id]!.y + NODE_H / 2]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/**
 * 整张图从零布局时，把太高或太扁的形状收拢到适合横向屏幕的长宽比：
 * 太高先旋转 90 度；太扁则横向压缩，再用去重叠沿纵向推开，重复几次。
 */
export function normalizeAspect(pos: Positions, nodes: { id: string; w: number }[]) {
  if (nodes.length < 3) return;
  const all = new Set(nodes.map((n) => n.id));
  let { w, h } = bbox(pos, nodes);
  if (w / h < ASPECT_MIN) {
    for (const n of nodes) pos[n.id] = { x: pos[n.id]!.y * 1.4, y: pos[n.id]!.x / 1.4 };
    removeOverlaps(pos, nodes, all);
    ({ w, h } = bbox(pos, nodes));
  }
  for (let i = 0; i < 8 && w / h > ASPECT_MAX; i++) {
    const cx = nodes.reduce((s, n) => s + pos[n.id]!.x, 0) / nodes.length;
    const cy = nodes.reduce((s, n) => s + pos[n.id]!.y, 0) / nodes.length;
    // 横向压缩，纵向略微拉开，让去重叠更倾向于沿纵向推开
    for (const n of nodes) pos[n.id] = { x: cx + (pos[n.id]!.x - cx) * 0.7, y: cy + (pos[n.id]!.y - cy) * 1.25 + (n.id.length % 2 ? 1 : -1) };
    removeOverlaps(pos, nodes, all);
    ({ w, h } = bbox(pos, nodes));
  }
}

/**
 * 边要有足够的长度放下标签而不压住箭头：两端外框之间（沿连线方向）至少留出
 * 标签宽度 + 箭头区域 + 余量；不够时沿连线方向把可移动的节点推开。
 */
export function ensureEdgeRoom(pos: Positions, nodes: { id: string; w: number }[], edges: Graph["edges"], movable: Set<string>) {
  const width = new Map(nodes.map((n) => [n.id, n.w]));
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    for (const e of edges) {
      const a = pos[e.from];
      const b = pos[e.to];
      if (!a || !b) continue;
      const ma = movable.has(e.from);
      const mb = movable.has(e.to);
      if (!ma && !mb) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      // 连线穿出两端外框的长度（矩形中心沿方向 (dx, dy) 到边界的距离）
      const exit = (w: number) => Math.min(Math.abs(dx) > 0.01 ? (w / 2) * (len / Math.abs(dx)) : Infinity, Math.abs(dy) > 0.01 ? (NODE_H / 2) * (len / Math.abs(dy)) : Infinity);
      const visible = len - exit(width.get(e.from)!) - exit(width.get(e.to)!);
      const need = labelWidth(edgeLabelText(e)) + ARROW_ZONE + 16;
      if (visible >= need) continue;
      const push = need - visible + 1;
      const ux = dx / len;
      const uy = dy / len;
      const sa = ma && mb ? push / 2 : ma ? push : 0;
      const sb = ma && mb ? push / 2 : mb ? push : 0;
      a.x -= ux * sa;
      a.y -= uy * sa;
      b.x += ux * sb;
      b.y += uy * sb;
      moved = true;
    }
    if (!moved) return;
  }
}

/**
 * 兜底：去重叠后仍与其他节点间距不足的可移动节点（被几个固定节点夹住时会来回推不出去），
 * 从当前位置向外螺旋搜索第一个空位。
 */
export function settleStuck(pos: Positions, nodes: { id: string; w: number }[], movable: Set<string>, gap = NODE_GAP) {
  const box = (id: string, p = pos[id]!) => ({ x: p.x, y: p.y, w: nodes.find((n) => n.id === id)!.w, h: NODE_H });
  const clear = (id: string, p: { x: number; y: number }) => nodes.every((o) => o.id === id || boxGap(box(id, p), box(o.id)) >= gap);
  for (const n of nodes) {
    if (!movable.has(n.id) || clear(n.id, pos[n.id]!)) continue;
    const c = pos[n.id]!;
    search: for (let r = 20; r < 3000; r += 20) {
      for (let k = 0; k < 32; k++) {
        const a = (k / 32) * Math.PI * 2;
        const p = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * 0.6 };
        if (clear(n.id, p)) {
          pos[n.id] = p;
          break search;
        }
      }
    }
  }
}

/**
 * 去重叠：两个外框间隙小于 NODE_GAP 时，沿穿透较小的方向把它们推开。
 * 固定节点不动；两个都可移动时各推一半。
 */
export function removeOverlaps(pos: Positions, nodes: { id: string; w: number }[], movable: Set<string>, gap = NODE_GAP) {
  for (let iter = 0; iter < 500; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const pa = pos[a.id]!;
        const pb = pos[b.id]!;
        const ma = movable.has(a.id);
        const mb = movable.has(b.id);
        if (!ma && !mb) continue;
        const needX = (a.w + b.w) / 2 + gap - Math.abs(pa.x - pb.x);
        const needY = NODE_H + gap - Math.abs(pa.y - pb.y);
        if (needX <= 0 || needY <= 0) continue;
        moved = true;
        // 沿需要移动更少的方向推开
        const alongX = needX < needY;
        const sign = alongX ? (pa.x <= pb.x ? -1 : 1) : pa.y <= pb.y ? -1 : 1;
        const need = (alongX ? needX : needY) + 1;
        const shareA = ma && mb ? need / 2 : ma ? need : 0;
        const shareB = ma && mb ? need / 2 : mb ? need : 0;
        if (alongX) {
          pa.x += sign * shareA;
          pb.x -= sign * shareB;
        } else {
          pa.y += sign * shareA;
          pb.y -= sign * shareB;
        }
      }
    }
    if (!moved) return;
  }
}

/**
 * 回路标记的位置：从回路各节点的中心开始，向外螺旋搜索，找到第一个不压在任何节点上、
 * 也不压在其他标记上的位置。
 */
/** 点到线段的距离 */
export function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * paths：各条边路由之后的实际路径（采样点），标记要与之保持距离。
 */
export function placeLoopMarkers(loops: { id: string; nodes: string[] }[], boxes: Map<string, Box>, paths: { x: number; y: number }[][] = []): Positions {
  const out: Positions = {};
  const r = MARKER_R + 8;
  const segs = paths.flatMap((p) => p.slice(1).map((q, i) => ({ a: p[i]!, b: q, clearance: MARKER_R + 4 })));
  const free = (x: number, y: number) =>
    [...boxes.values()].every((b) => Math.abs(x - b.x) >= b.w / 2 + r || Math.abs(y - b.y) >= b.h / 2 + r) &&
    Object.values(out).every((m) => Math.hypot(m.x - x, m.y - y) >= 2 * r) &&
    segs.every((s) => segmentDistance({ x, y }, s.a, s.b) >= s.clearance);
  for (const l of loops) {
    const ps = l.nodes.map((id) => boxes.get(id)).filter((b): b is Box => Boolean(b));
    if (!ps.length) continue;
    const c = { x: ps.reduce((s, b) => s + b.x, 0) / ps.length, y: ps.reduce((s, b) => s + b.y, 0) / ps.length };
    let found: { x: number; y: number } | null = free(c.x, c.y) ? c : null;
    for (let radius = 12; !found && radius < 1200; radius += 12) {
      for (let k = 0; k < 24 && !found; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = c.x + Math.cos(a) * radius;
        const y = c.y + Math.sin(a) * radius;
        if (free(x, y)) found = { x, y };
      }
    }
    out[l.id] = found ?? c;
  }
  return out;
}

/** 回路标记的显示策略：回路不多时全部显示；较多时只显示选中或悬停的那个 */
export const MAX_ALWAYS_SHOWN_LOOPS = 2;
export function visibleLoopIds(loopIds: string[], highlighted: string | null, hovered: string | null, showAll = false): string[] {
  if (showAll || loopIds.length <= MAX_ALWAYS_SHOWN_LOOPS) return loopIds;
  return loopIds.filter((id) => id === highlighted || id === hovered);
}
