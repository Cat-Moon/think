// 把图和补丁操作转成可读的文字：给 AI 的上下文和给人看的报告都用它。
import { findLoops, type Loop } from "./loops";
import type { Graph, GraphEdge, OpDecision, PatchOp } from "./schema";

const POL: Record<string, string> = { "+": "+", "-": "−", "?": "?" };
const clip = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n)}…` : t || "（空）");

/** 节点标签查找：先查本补丁的 $ref，再查图 */
export function labeler(graph: Graph, ops: readonly PatchOp[] = []) {
  const refs = new Map(ops.flatMap((o) => (o.op === "add_node" ? [[o.ref, o.label] as const] : [])));
  return (id: string) => refs.get(id) ?? graph.nodes.find((n) => n.id === id)?.label ?? id;
}

export function edgeText(e: Pick<GraphEdge, "from" | "to" | "polarity">, label: (id: string) => string): string {
  return `${label(e.from)} →(${POL[e.polarity]}) ${label(e.to)}`;
}

/** 一项补丁操作的中文描述，如「新增关系 贷款利率 →(−) 购房需求」 */
export function describeOp(op: PatchOp, graph: Graph, patchOps: readonly PatchOp[] = []): string {
  const label = labeler(graph, patchOps);
  const edge = (id: string) => graph.edges.find((e) => e.id === id);
  const edgeById = (id: string) => {
    const e = edge(id);
    return e ? `「${edgeText(e, label)}」` : id;
  };
  switch (op.op) {
    case "set_frame":
      return `设定框架：${[op.phenomenon && `现象「${op.phenomenon}」`, op.perspective && `视角「${op.perspective}」`, op.time_horizon && `时间「${op.time_horizon}」`, op.context && `地区/语境「${op.context}」`].filter(Boolean).join("，")}`;
    case "add_node":
      return `新增变量「${op.label}」`;
    case "update_node":
      return `修改变量「${label(op.id)}」：${[op.label && `改名为「${op.label}」`, op.note !== undefined && `笔记改为「${clip(op.note)}」`].filter(Boolean).join("，")}`;
    case "remove_node":
      return `去掉变量「${label(op.id)}」`;
    case "merge_nodes":
      return `合并变量「${label(op.merge)}」到「${label(op.keep)}」${op.label ? `，改名为「${op.label}」` : ""}`;
    case "add_edge":
      return `新增关系「${edgeText(op, label)}」${op.delay ? " ‖延迟" : ""}${op.contested ? " ⚑有争议" : ""}`;
    case "update_edge": {
      const before = edge(op.id);
      const changes = [
        op.polarity && `极性${before ? ` ${POL[before.polarity]}` : ""} → ${POL[op.polarity]}`,
        op.delay !== undefined && (op.delay ? "标记延迟" : "取消延迟"),
        op.status && { accepted: "同意", uncertain: "标为不确定", rejected: "拒绝" }[op.status],
        op.contested !== undefined && (op.contested ? "标为有争议" : "取消争议"),
        op.rationale !== undefined && `理由改为「${clip(op.rationale)}」`,
        op.note !== undefined && `笔记改为「${clip(op.note)}」`,
      ].filter(Boolean);
      return `修改关系${edgeById(op.id)}：${changes.join("，")}`;
    }
    case "reverse_edge":
      return `掉转关系${edgeById(op.id)}的方向`;
    case "remove_edge":
      return `去掉关系${edgeById(op.id)}`;
  }
}

export function opReason(op: PatchOp): string {
  if ("rationale" in op && op.rationale) return op.rationale;
  if ("reason" in op && op.reason) return op.reason;
  return "";
}

/** 给人看的图：现象、变量、关系（带理由）、代码检测出的回路 */
export function renderGraph(graph: Graph, opts: { showRejected?: boolean; loops?: Loop[] } = {}): string {
  const label = labeler(graph);
  const f = graph.frame;
  const lines: string[] = [];
  lines.push(`主题：${f.topic}`);
  lines.push(`现象：${f.phenomenon || "（未定）"}｜视角：${f.perspective || "（未定）"}｜时间：${f.time_horizon || "（未定）"}｜地区/语境：${f.context || "未指定"}`);
  const nodes = graph.nodes.filter((n) => opts.showRejected || n.status === "accepted");
  lines.push(`变量（${nodes.length}）：${nodes.map((n) => `${n.label}${n.status === "rejected" ? "[已拒绝]" : ""}`).join("、") || "（无）"}`);
  const edges = graph.edges.filter((e) => opts.showRejected || e.status !== "rejected");
  lines.push(`关系（${edges.length}）：`);
  for (const e of edges) {
    const tags = [e.delay && "‖延迟", e.status === "uncertain" && "不确定", e.contested && "⚑有争议", e.status === "rejected" && "已拒绝"].filter(Boolean);
    lines.push(`  ${edgeText(e, label)}${tags.length ? `  [${tags.join("，")}]` : ""}`);
    if (e.rationale) lines.push(`      理由：${e.rationale}`);
  }
  if (!edges.length) lines.push("  （无）");
  const loops = opts.loops ?? findLoops(graph).loops;
  lines.push(`回路（代码检测）：${loops.length ? "" : "（无）"}`);
  for (const l of loops) {
    lines.push(`  ${l.id}${l.uncertain ? "（含不确定）" : ""}  ${[...l.nodes, l.nodes[0]!].map(label).join(" → ")}`);
  }
  return lines.join("\n");
}

/** 给人看的补丁：每一项操作及其处理结果 */
export function renderOps(ops: readonly PatchOp[], graphBefore: Graph, decisions?: readonly OpDecision[]): string {
  return ops
    .map((op, i) => {
      const d = decisions?.[i];
      const mark = !d ? "·" : d.decision === "accepted" ? "✔" : "✘";
      const reason = opReason(op);
      const verdict = d?.decision === "rejected" ? `  〔拒绝${d.auto ? "（自动）" : ""}${d.reason ? `：${d.reason}` : ""}〕` : "";
      return `  ${mark} ${describeOp(op, graphBefore, ops)}${reason ? `\n      理由：${reason}` : ""}${verdict}`;
    })
    .join("\n");
}
