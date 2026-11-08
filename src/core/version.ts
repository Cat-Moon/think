// 版本管理：快照、差异、恢复（设计文档第 6 节第 7 条、第 7.5 节）。
import { firstSeqId, nextSeqId } from "./ids";
import { SCHEMA_VERSION, UNSPECIFIED_CONTEXT, type Frame, type Graph, type OpDecision, type Version } from "./schema";

/** 创建 Map 时的空图 v000 */
export function initialVersion(topic: string, now: string): Version {
  const graph: Graph = {
    schema_version: SCHEMA_VERSION,
    version: firstSeqId("v"),
    frame: { topic, phenomenon: "", perspective: "", time_horizon: "", context: UNSPECIFIED_CONTEXT },
    nodes: [],
    edges: [],
  };
  return { version: graph.version, parent_version: null, patch_id: null, decisions: null, created_at: now, graph };
}

/** 以 parent 为基础生成下一个版本快照（graph 内容由调用方给出） */
export function nextVersion(
  parent: Graph,
  content: Pick<Graph, "frame" | "nodes" | "edges">,
  patchId: string | null,
  now: string,
  decisions: OpDecision[] | null = null,
): Version {
  const version = nextSeqId(parent.version);
  // 只取 frame / nodes / edges：content 可能是一张完整的图，不能让它的旧 version 覆盖新版本号
  const graph: Graph = structuredClone({
    schema_version: SCHEMA_VERSION,
    version,
    frame: content.frame,
    nodes: content.nodes,
    edges: content.edges,
  });
  return { version, parent_version: parent.version, patch_id: patchId, decisions, created_at: now, graph };
}

/**
 * 恢复到旧版本：生成一个新版本，内容是旧版本的图。
 * 当前图中有、旧版本中没有的节点和边会以 rejected 状态保留，
 * 这样 ID 不会被复用，被放弃的内容也留有记录。
 */
export function restoreVersion(current: Graph, target: Graph, now: string): Version {
  const nodes = structuredClone(target.nodes);
  const edges = structuredClone(target.edges);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));
  for (const n of current.nodes) {
    if (!nodeIds.has(n.id)) nodes.push({ ...structuredClone(n), status: "rejected" });
  }
  for (const e of current.edges) {
    if (!edgeIds.has(e.id)) edges.push({ ...structuredClone(e), status: "rejected" });
  }
  return nextVersion(current, { frame: structuredClone(target.frame), nodes, edges }, null, now);
}

// ---------- 差异 ----------

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ItemDiff {
  added: string[];
  deleted: string[];
  changed: { id: string; changes: FieldChange[] }[];
}

export interface GraphDiff {
  frame: FieldChange[];
  nodes: ItemDiff;
  edges: ItemDiff;
}

function diffFields<T extends object>(a: T, b: T, skip: readonly string[] = []): FieldChange[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: FieldChange[] = [];
  for (const k of keys) {
    if (skip.includes(k)) continue;
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ field: k, from: va, to: vb });
  }
  return out;
}

function diffItems<T extends { id: string }>(a: readonly T[], b: readonly T[]): ItemDiff {
  const ma = new Map(a.map((x) => [x.id, x]));
  const mb = new Map(b.map((x) => [x.id, x]));
  const diff: ItemDiff = { added: [], deleted: [], changed: [] };
  for (const [id, xb] of mb) {
    const xa = ma.get(id);
    if (!xa) diff.added.push(id);
    else {
      const changes = diffFields(xa, xb, ["id"]);
      if (changes.length) diff.changed.push({ id, changes });
    }
  }
  for (const id of ma.keys()) if (!mb.has(id)) diff.deleted.push(id);
  return diff;
}

/** 两个版本之间的差异（状态变化，如 accepted → rejected，体现在 changed 中） */
export function diffGraphs(a: Graph, b: Graph): GraphDiff {
  return {
    frame: diffFields<Frame>(a.frame, b.frame),
    nodes: diffItems(a.nodes, b.nodes),
    edges: diffItems(a.edges, b.edges),
  };
}

export function isEmptyDiff(d: GraphDiff): boolean {
  return (
    d.frame.length === 0 &&
    [d.nodes, d.edges].every((x) => x.added.length === 0 && x.deleted.length === 0 && x.changed.length === 0)
  );
}
