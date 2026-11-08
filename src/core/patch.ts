// 补丁应用（设计文档第 6 节第 5 条、第 7.2–7.4 节）。
// 纯函数：不修改传入的图和补丁，返回新的对象。
import { nextItemId } from "./ids";
import {
  Graph as GraphSchema,
  type EdgeStatus,
  type Graph,
  type GraphEdge,
  type OpDecision,
  type Origin,
  type Patch,
  type PatchOp,
  type Version,
} from "./schema";
import { normalizeLabel } from "./validate";
import { nextVersion } from "./version";

export class PatchError extends Error {
  constructor(
    message: string,
    /** 出错的操作序号；null 表示整个补丁的问题 */
    readonly opIndex: number | null = null,
  ) {
    super(opIndex === null ? message : `第 ${opIndex + 1} 项操作：${message}`);
    this.name = "PatchError";
  }
}

export interface Choice {
  decision: "accepted" | "rejected";
  reason?: string;
}

/** "all" 表示全部接受；否则按序号给出选择，未给出的视为拒绝 */
export type Choices = "all" | Readonly<Record<number, Choice>>;

const isRef = (s: string) => s.startsWith("$");

/**
 * 检查补丁内部的 $ref：add_node 的 ref 不能重复；add_edge 引用的 ref 必须在前面定义过。
 * 返回 ref → 定义它的操作序号。
 */
export function collectRefs(ops: readonly PatchOp[]): Map<string, number> {
  const refs = new Map<string, number>();
  ops.forEach((op, i) => {
    if (op.op === "add_node") {
      if (refs.has(op.ref)) throw new PatchError(`临时引用 ${op.ref} 重复定义`, i);
      refs.set(op.ref, i);
    } else if (op.op === "add_edge") {
      for (const end of [op.from, op.to]) {
        if (isRef(end) && !refs.has(end)) throw new PatchError(`临时引用 ${end} 没有在前面定义`, i);
      }
    }
  });
  return refs;
}

/**
 * 把用户的选择展开成每一项的决定。
 * 如果某个新节点被拒绝，引用它的边自动拒绝（auto: true）。
 */
export function planDecisions(ops: readonly PatchOp[], choices: Choices): OpDecision[] {
  const refs = collectRefs(ops);
  const decisions: OpDecision[] = ops.map((_, i) => {
    const c = choices === "all" ? { decision: "accepted" as const } : choices[i];
    return { op_index: i, decision: c?.decision ?? "rejected", ...(c?.reason ? { reason: c.reason } : {}), auto: false };
  });
  ops.forEach((op, i) => {
    if (op.op !== "add_edge" || decisions[i]!.decision !== "accepted") return;
    const rejectedRef = [op.from, op.to].find((end) => isRef(end) && decisions[refs.get(end)!]!.decision === "rejected");
    if (rejectedRef) {
      decisions[i] = { op_index: i, decision: "rejected", reason: `依赖的新变量 ${rejectedRef} 没有被接受`, auto: true };
    }
  });
  return decisions;
}

/** 按顺序应用一组操作，返回新的图内容（version 不变）。任何一项不合法都会抛出 PatchError。 */
export function applyOps(graph: Graph, ops: readonly { index: number; op: PatchOp }[], origin: Origin): Graph {
  const g = structuredClone(graph);
  const refMap = new Map<string, string>();

  const node = (id: string, i: number) => {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) throw new PatchError(`变量 ${id} 不存在`, i);
    return n;
  };
  const liveNode = (ref: string, i: number) => {
    const id = isRef(ref) ? refMap.get(ref) : ref;
    if (!id) throw new PatchError(`临时引用 ${ref} 对应的变量没有被接受`, i);
    const n = node(id, i);
    if (n.status !== "accepted") throw new PatchError(`变量"${n.label}"（${id}）已被拒绝`, i);
    return n;
  };
  const edge = (id: string, i: number) => {
    const e = g.edges.find((x) => x.id === id);
    if (!e) throw new PatchError(`关系 ${id} 不存在`, i);
    return e;
  };
  const isActive = (e: GraphEdge) => e.status !== "rejected";
  const assertLabelFree = (label: string, exceptId: string | null, i: number) => {
    const norm = normalizeLabel(label);
    const dup = g.nodes.find((n) => n.status === "accepted" && n.id !== exceptId && normalizeLabel(n.label) === norm);
    if (dup) throw new PatchError(`已有同名变量"${dup.label}"（${dup.id}）`, i);
  };
  const assertNoActiveEdge = (from: string, to: string, exceptId: string | null, i: number) => {
    const dup = g.edges.find((e) => isActive(e) && e.id !== exceptId && e.from === from && e.to === to);
    if (dup) throw new PatchError(`已有同向的关系 ${dup.id}，请修改它而不是新增`, i);
  };

  for (const { index: i, op } of ops) {
    switch (op.op) {
      case "set_frame": {
        for (const k of ["phenomenon", "perspective", "time_horizon"] as const) {
          if (op[k] !== undefined) g.frame[k] = op[k];
        }
        break;
      }
      case "add_node": {
        assertLabelFree(op.label, null, i);
        const id = nextItemId("n", g.nodes);
        g.nodes.push({ id, label: op.label.trim(), status: "accepted", origin, note: "" });
        refMap.set(op.ref, id);
        break;
      }
      case "update_node": {
        const n = node(op.id, i);
        if (op.label !== undefined) {
          assertLabelFree(op.label, n.id, i);
          n.label = op.label.trim();
        }
        if (op.note !== undefined) n.note = op.note;
        break;
      }
      case "remove_node": {
        const n = node(op.id, i);
        if (n.status === "rejected") throw new PatchError(`变量"${n.label}"已经被拒绝`, i);
        n.status = "rejected";
        break;
      }
      case "merge_nodes": {
        if (op.keep === op.merge) throw new PatchError("不能把变量和自己合并", i);
        const keep = liveNode(op.keep, i);
        const merge = liveNode(op.merge, i);
        for (const e of g.edges) {
          if (e.from === merge.id) e.from = keep.id;
          if (e.to === merge.id) e.to = keep.id;
          // 原来连接两者的边合并后变成自环，没有意义，置为 rejected
          if (e.from === keep.id && e.to === keep.id && isActive(e)) e.status = "rejected";
        }
        merge.status = "rejected";
        if (op.label !== undefined) {
          assertLabelFree(op.label, keep.id, i);
          keep.label = op.label.trim();
        }
        break;
      }
      case "add_edge": {
        const from = liveNode(op.from, i);
        const to = liveNode(op.to, i);
        if (from.id === to.id) throw new PatchError(`关系不能从"${from.label}"指向自己`, i);
        assertNoActiveEdge(from.id, to.id, null, i);
        g.edges.push({
          id: nextItemId("e", g.edges),
          from: from.id,
          to: to.id,
          polarity: op.polarity,
          delay: op.delay ?? false,
          status: "accepted",
          origin,
          rationale: op.rationale,
          contested: op.contested ?? false,
          confidence: null,
          note: "",
        });
        break;
      }
      case "update_edge": {
        const e = edge(op.id, i);
        if (op.status && op.status !== "rejected" && e.status === "rejected") {
          // 重新启用被拒绝的边：两端变量必须仍然有效，且不能和已有的边重复
          liveNode(e.from, i);
          liveNode(e.to, i);
          assertNoActiveEdge(e.from, e.to, e.id, i);
        }
        for (const k of ["polarity", "delay", "status", "rationale", "note", "contested"] as const) {
          if (op[k] !== undefined) (e as Record<typeof k, unknown>)[k] = op[k];
        }
        break;
      }
      case "reverse_edge": {
        const e = edge(op.id, i);
        if (isActive(e)) assertNoActiveEdge(e.to, e.from, e.id, i);
        [e.from, e.to] = [e.to, e.from];
        break;
      }
      case "remove_edge": {
        const e = edge(op.id, i);
        if (e.status === "rejected") throw new PatchError(`关系 ${e.id} 已经被拒绝`, i);
        e.status = "rejected";
        break;
      }
    }
  }

  const checked = GraphSchema.safeParse(g);
  if (!checked.success) throw new PatchError(`应用后的图不合法：${checked.error.issues[0]?.message}`);
  return checked.data;
}

export interface ResolveResult {
  /** 写回了 resolution 的补丁 */
  patch: Patch;
  /** 新版本；全部拒绝时为 null */
  version: Version | null;
}

/** 处理一个补丁：检查版本、展开选择、应用被接受的操作、生成新版本 */
export function resolvePatch(graph: Graph, patch: Patch, choices: Choices, now: string): ResolveResult {
  if (patch.resolution !== null) throw new PatchError(`补丁 ${patch.patch_id} 已经处理过`);
  if (patch.base_version !== graph.version) {
    throw new PatchError(`补丁 ${patch.patch_id} 基于 ${patch.base_version}，但当前版本是 ${graph.version}，请重新生成`);
  }

  const decisions = planDecisions(patch.ops, choices);
  const accepted = decisions
    .filter((d) => d.decision === "accepted")
    .map((d) => ({ index: d.op_index, op: patch.ops[d.op_index]! }));

  let version: Version | null = null;
  if (accepted.length > 0) {
    const content = applyOps(graph, accepted, patch.origin);
    version = nextVersion(graph, content, patch.patch_id, now);
  }

  return {
    patch: {
      ...structuredClone(patch),
      resolution: { resolved_at: now, decisions, result_version: version?.version ?? null },
    },
    version,
  };
}

// ---------- 用户操作 ----------

export function makePatch(
  fields: Pick<Patch, "patch_id" | "base_version" | "origin" | "ops"> & Partial<Pick<Patch, "turn_id" | "message" | "question" | "possible_duplicates">>,
  now: string,
): Patch {
  return {
    turn_id: null,
    message: "",
    question: "",
    possible_duplicates: [],
    ...fields,
    created_at: now,
    resolution: null,
  };
}

export type EdgeAction = "agree" | "flip_polarity" | "reverse" | "disagree" | "uncertain";

/**
 * 点按边上的按钮对应的操作（第 7.3 节）。
 * 极性为 ? 时"极性相反"没有意义，需要用户选择 + 或 −（通过 polarity 传入）。
 */
export function edgeActionOps(
  e: Pick<GraphEdge, "id" | "polarity">,
  action: EdgeAction,
  opts: { reason?: string; polarity?: "+" | "-" } = {},
): PatchOp[] {
  const status = (s: EdgeStatus): PatchOp[] => [{ op: "update_edge", id: e.id, status: s }];
  switch (action) {
    case "agree":
      return status("accepted");
    case "uncertain":
      return status("uncertain");
    case "reverse":
      return [{ op: "reverse_edge", id: e.id }];
    case "disagree":
      return [{ op: "remove_edge", id: e.id, ...(opts.reason ? { reason: opts.reason } : {}) }];
    case "flip_polarity": {
      const polarity = e.polarity === "+" ? "-" : e.polarity === "-" ? "+" : opts.polarity;
      if (!polarity) throw new PatchError("当前极性未知，请选择 + 或 −");
      return [{ op: "update_edge", id: e.id, polarity }];
    }
  }
}
