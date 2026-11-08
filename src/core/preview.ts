// 补丁预览（设计文档第 9.2 节）：把补丁"假装应用"后的图算出来，
// 并标出每项操作对应图上的哪个元素，界面据此画出幽灵样式。
import { rejectedBypasses } from "./ai-check";
import { describeOp, opReason } from "./describe";
import { PatchError, applyOps } from "./patch";
import type { Graph, Patch, PatchOp } from "./schema";

export type OpEffect = "add" | "modify" | "remove";

export interface PreviewOp {
  index: number;
  op: PatchOp;
  /** 具体改了什么，如「修改关系「A →(+) B」：极性 + → −，笔记改为「…」」 */
  text: string;
  reason: string;
  effect: OpEffect;
  /** 这项操作作用于图上的哪些元素（新增的、被修改的或被去掉的） */
  elements: string[];
}

export interface Preview {
  /** 应用全部操作后的图；补丁无法应用时为 null */
  after: Graph | null;
  ops: PreviewOp[];
  /** 补丁无法应用的原因 */
  error: string | null;
  /** 被拒绝的关系经由新变量绕道（只提示） */
  bypasses: string[];
}

function effectOf(op: PatchOp): OpEffect {
  if (op.op === "add_node" || op.op === "add_edge") return "add";
  if (op.op === "remove_node" || op.op === "remove_edge") return "remove";
  return "modify";
}

export function previewPatch(graph: Graph, patch: Pick<Patch, "ops" | "origin">, patches: readonly Patch[] = []): Preview {
  const trace = new Map<number, string>();
  let after: Graph | null = null;
  let error: string | null = null;
  try {
    after = applyOps(graph, patch.ops.map((op, index) => ({ index, op })), patch.origin, trace);
  } catch (e) {
    if (!(e instanceof PatchError)) throw e;
    error = e.message;
  }
  const ops = patch.ops.map((op, index): PreviewOp => {
    const elements: string[] = [];
    if (trace.has(index)) elements.push(trace.get(index)!);
    if ("id" in op) elements.push(op.id);
    if (op.op === "merge_nodes") elements.push(op.keep, op.merge);
    return { index, op, text: describeOp(op, graph, patch.ops), reason: opReason(op), effect: effectOf(op), elements };
  });
  return { after, ops, error, bypasses: after ? rejectedBypasses(graph, after, patches) : [] };
}
