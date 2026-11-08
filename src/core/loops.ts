// 回路检测与极性（设计文档第 6 节第 1、2 条）。
// 极性必须由代码计算，不让 LLM 判断。
import { compareIds } from "./ids";
import type { Graph, GraphEdge, Polarity } from "./schema";

export type LoopPolarity = "R" | "B" | "?";

export interface Loop {
  /** 显示名：R1、B1、?1（按回路长度和节点顺序排序后编号，版本之间不保证稳定） */
  id: string;
  polarity: LoopPolarity;
  /** 回路上的节点，从编号最小的节点开始 */
  nodes: string[];
  /** 回路上的边，与 nodes 一一对应：edges[i] 从 nodes[i] 指向 nodes[i+1] */
  edges: string[];
  /** 回路中含有 uncertain 的边（界面以虚线显示） */
  uncertain: boolean;
}

export interface LoopResult {
  loops: Loop[];
  /** 回路数或搜索步数超过上限，结果不完整 */
  truncated: boolean;
}

export const DEFAULT_LOOP_LIMIT = 200;
const DEFAULT_MAX_STEPS = 200_000;

/** 参与计算的边：accepted / uncertain，且两端节点都是 accepted */
export function activeEdges(g: Graph): GraphEdge[] {
  const live = new Set(g.nodes.filter((n) => n.status === "accepted").map((n) => n.id));
  return g.edges.filter((e) => e.status !== "rejected" && live.has(e.from) && live.has(e.to));
}

/** 极性相乘：含 ? 为 ?；负边为偶数条是 R（增强），奇数条是 B（平衡） */
export function loopPolarity(polarities: readonly Polarity[]): LoopPolarity {
  if (polarities.includes("?")) return "?";
  return polarities.filter((p) => p === "-").length % 2 === 0 ? "R" : "B";
}

/**
 * 枚举所有基本回路（不重复经过节点的闭环）。
 * 做法：按编号依次以每个节点为起点做 DFS，只经过编号不小于起点的节点，
 * 因此每个回路只在其最小节点处被找到一次。平行边（同向的两条边）视为不同的回路。
 * 图很小，所以不需要更复杂的算法；回路数和搜索步数都有上限。
 */
export function findLoops(
  g: Graph,
  opts: { limit?: number; maxSteps?: number } = {},
): LoopResult {
  const limit = opts.limit ?? DEFAULT_LOOP_LIMIT;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  const edges = activeEdges(g);
  const nodeIds = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort(compareIds);
  const order = new Map(nodeIds.map((id, i) => [id, i]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const e of [...edges].sort((a, b) => compareIds(a.id, b.id))) {
    const list = outgoing.get(e.from) ?? [];
    list.push(e);
    outgoing.set(e.from, list);
  }

  const cycles: GraphEdge[][] = [];
  let truncated = false;
  let steps = 0;

  for (let s = 0; s < nodeIds.length && !truncated; s++) {
    const start = nodeIds[s]!;
    const onPath = new Set([start]);
    const path: GraphEdge[] = [];

    const dfs = (v: string): void => {
      for (const e of outgoing.get(v) ?? []) {
        if (truncated) return;
        if (++steps > maxSteps) {
          truncated = true;
          return;
        }
        const w = e.to;
        if (order.get(w)! < s) continue;
        if (w === start) {
          if (cycles.length >= limit) {
            truncated = true;
            return;
          }
          cycles.push([...path, e]);
        } else if (!onPath.has(w)) {
          onPath.add(w);
          path.push(e);
          dfs(w);
          path.pop();
          onPath.delete(w);
        }
      }
    };
    dfs(start);
  }

  const sortKey = (c: GraphEdge[]) => c.map((e) => e.from).join(",") + "|" + c.map((e) => e.id).join(",");
  cycles.sort((a, b) => a.length - b.length || compareKeys(sortKey(a), sortKey(b)));

  const counters: Record<LoopPolarity, number> = { R: 0, B: 0, "?": 0 };
  const loops = cycles.map((c): Loop => {
    const polarity = loopPolarity(c.map((e) => e.polarity));
    counters[polarity] += 1;
    return {
      id: `${polarity}${counters[polarity]}`,
      polarity,
      nodes: c.map((e) => e.from),
      edges: c.map((e) => e.id),
      uncertain: c.some((e) => e.status === "uncertain"),
    };
  });

  return { loops, truncated };
}

/** 逐段按 ID 规则比较 "n1,n2|e1,e3" 这样的键 */
function compareKeys(a: string, b: string): number {
  const pa = a.split(/[,|]/);
  const pb = b.split(/[,|]/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = compareIds(pa[i]!, pb[i]!);
    if (c !== 0) return c;
  }
  return pa.length - pb.length;
}
