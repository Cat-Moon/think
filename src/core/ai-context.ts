// 组装每次发给 AI 的上下文（设计文档第 5.4 节）。每次调用都是无状态的。
import { describeOp, edgeText, labeler } from "./describe";
import { idNumber } from "./ids";
import { findLoops } from "./loops";
import { isContextUnspecified, type Graph, type Patch, type Turn } from "./schema";
import { normalizeLabel } from "./validate";

export const RECENT_TURNS = 8;

/** 去掉用户放弃的消息和标记它的 system 回合（它们不发给 AI） */
export function withoutAbandoned<T extends { turn_id: string; abandoned_turn?: string }>(turns: readonly T[]): T[] {
  const gone = new Set(turns.flatMap((t) => (t.abandoned_turn ? [t.abandoned_turn, t.turn_id] : [])));
  return turns.filter((t) => !gone.has(t.turn_id));
}
export const MAX_NEW_ITEMS = 3;

export interface TurnContext {
  graph: Graph;
  /** 这个 Map 的所有补丁（按编号排序） */
  patches: readonly Patch[];
  /** 对话记录，最后一条是本轮的用户消息 */
  turns: readonly Turn[];
  /** 上一次输出没通过检查时，把问题告诉 AI 让它修正 */
  retryErrors?: readonly string[];
}

/**
 * 回合长短，用于选择思考程度（设计文档第 8.1.1 节）。
 * 长：种子图（图为空时，可能是澄清也可能是种子图，按长处理）和一般的补充请求；
 * 短：用户在问"为什么"、请求解释。
 */
export function turnLength(graph: Graph, userText: string): "short" | "long" {
  if (isSeedTurn(graph)) return "long";
  return /^s*(为什么|为何|怎么理解|能不能解释|请解释|解释一下|why)|为什么你(认为|觉得)/i.test(userText) ? "short" : "long";
}

/** 图中还没有任何有效变量：下一个补丁是种子图 */
export const isSeedTurn = (g: Graph) => !g.nodes.some((n) => n.status === "accepted");

export interface RejectedItem {
  kind: "node" | "edge";
  text: string;
  /** 用于比较是否被重新提出：变量为归一化标签，关系为 "from标签->to标签" */
  key: string;
  reason?: string;
  /** 关系两端的变量名（kind 为 edge 时） */
  from?: string;
  to?: string;
}

const edgeKey = (from: string, to: string) => `${normalizeLabel(from)}->${normalizeLabel(to)}`;

/** 用户拒绝过的内容：图中 rejected 的项 + 补丁中被拒绝的新增操作（去重） */
export function rejectedItems(graph: Graph, patches: readonly Patch[]): RejectedItem[] {
  const out = new Map<string, RejectedItem>();
  const add = (item: RejectedItem) => {
    const k = `${item.kind}:${item.key}`;
    if (!out.has(k) || (!out.get(k)!.reason && item.reason)) out.set(k, item);
  };
  const label = labeler(graph);
  const liveLabels = new Set(graph.nodes.filter((n) => n.status === "accepted").map((n) => normalizeLabel(n.label)));

  for (const p of patches) {
    for (const d of p.resolution?.decisions ?? []) {
      const op = p.ops[d.op_index];
      if (d.decision !== "rejected" || !op) continue;
      const opLabel = labeler(graph, p.ops);
      if (op.op === "add_node" && !d.auto) {
        add({ kind: "node", text: `变量「${op.label}」`, key: normalizeLabel(op.label), reason: d.reason });
      } else if (op.op === "add_edge" && !d.auto) {
        add({ kind: "edge", text: `关系「${edgeText(op, opLabel)}」`, key: edgeKey(opLabel(op.from), opLabel(op.to)), reason: d.reason, from: opLabel(op.from), to: opLabel(op.to) });
      }
    }
  }
  for (const n of graph.nodes) {
    // 后来又以同名加回图中的变量不算"被拒绝"
    if (n.status === "rejected" && !liveLabels.has(normalizeLabel(n.label))) {
      add({ kind: "node", text: `变量「${n.label}」`, key: normalizeLabel(n.label) });
    }
  }
  for (const e of graph.edges) {
    if (e.status === "rejected") add({ kind: "edge", text: `关系「${edgeText(e, label)}」`, key: edgeKey(label(e.from), label(e.to)), from: label(e.from), to: label(e.to) });
  }
  return [...out.values()];
}

/** 紧凑的图表示（带 ID，供 AI 引用） */
export function graphForAi(g: Graph): string {
  const label = labeler(g);
  const nodes = g.nodes.filter((n) => n.status === "accepted");
  const edges = g.edges.filter((e) => e.status !== "rejected" && nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to));
  const lines = [`变量：`];
  for (const n of nodes) lines.push(`- ${n.id} ${n.label}${n.note ? `（用户笔记：${n.note}）` : ""}`);
  if (!nodes.length) lines.push("（空）");
  lines.push(`关系：`);
  for (const e of edges) {
    const tags = [e.delay && "延迟", e.status === "uncertain" && "用户不确定", e.contested && "有争议"].filter(Boolean);
    lines.push(`- ${e.id}: ${e.from} ${label(e.from)} →(${e.polarity}) ${e.to} ${label(e.to)}${tags.length ? ` [${tags.join("，")}]` : ""}${e.rationale ? ` 理由：${e.rationale}` : ""}`);
  }
  if (!edges.length) lines.push("（空）");
  return lines.join("\n");
}

/** 组装用户消息部分的完整上下文 */
export function buildTurnPrompt(ctx: TurnContext): string {
  const { graph, patches, turns } = ctx;
  const f = graph.frame;
  const seed = isSeedTurn(graph);
  const sections: string[] = [];

  sections.push(
    `## 主题框架\n主题：${f.topic}\n现象：${f.phenomenon || "（未定）"}\n视角：${f.perspective || "（未定）"}\n时间范围：${f.time_horizon || "（未定）"}\n地区/语境：${f.context || "未指定"}${isContextUnspecified(f.context) ? "（不要默认任何国家；理由中不要写具体国家的事实）" : ""}`,
  );
  sections.push(`## 当前的图（版本 ${graph.version}）\n${graphForAi(graph)}`);

  const { loops } = findLoops(graph);
  const label = labeler(graph);
  sections.push(
    `## 程序检测到的闭环（由代码计算，不要自己判断）\n${loops.length ? loops.map((l) => `- ${l.id}: ${[...l.nodes, l.nodes[0]!].map((id) => `${label(id)}`).join(" → ")}`).join("\n") : "（无）"}`,
  );

  const rejected = rejectedItems(graph, patches);
  sections.push(
    `## 用户拒绝过的内容（不要再提出，也不要换个说法重新提出）\n${rejected.length ? rejected.map((r) => `- ${r.text}${r.reason ? `，理由：${r.reason}` : ""}`).join("\n") : "（无）"}`,
  );

  const lastAi = [...patches].reverse().find((p) => p.origin === "ai" && p.resolution);
  if (lastAi?.resolution) {
    const lines = lastAi.resolution.decisions.map((d) => {
      const op = lastAi.ops[d.op_index]!;
      const verdict = d.decision === "accepted" ? "接受" : d.auto ? "未采用（依赖的变量被拒绝）" : `拒绝${d.reason ? `（${d.reason}）` : ""}`;
      return `- ${describeOp(op, graph, lastAi.ops)}：${verdict}`;
    });
    sections.push(`## 你上一轮建议的处理结果\n${lines.join("\n")}`);
  }

  const lastAiNo = lastAi ? idNumber(lastAi.patch_id) : 0;
  const userChanges = patches.filter((p) => p.origin === "user" && idNumber(p.patch_id) > lastAiNo && p.resolution?.result_version);
  if (userChanges.length) {
    const lines = userChanges.flatMap((p) => p.ops.map((op) => `- ${describeOp(op, graph, p.ops)}`));
    sections.push(`## 用户自上一轮以来的直接修改\n${lines.join("\n")}`);
  }

  const history = withoutAbandoned(turns.slice(0, -1)).slice(-RECENT_TURNS);
  if (history.length) {
    const lines = history.map((t) => {
      if (t.role === "user") return `用户：${t.text}`;
      if (t.role === "ai") return `你：${t.text}${t.question ? `（问题：${t.question}）` : ""}`;
      return `（系统：${t.text}）`;
    });
    sections.push(`## 最近的对话\n${lines.join("\n")}`);
  }

  const current = turns.at(-1);
  const rule = seed
    ? "图还是空的。如果主题足够清楚，给出种子图（set_frame + 3 到 5 个变量，最多一个闭环）；如果主题太模糊，用 clarify 问一个澄清问题。"
    : `新增的变量和关系合计不超过 ${MAX_NEW_ITEMS} 个。用户在问"为什么"时，用 answer 回答，不改图。`;
  sections.push(`## 本轮\n${rule}\n\n用户的新消息：${current?.role === "user" ? current.text : "（无）"}`);

  if (ctx.retryErrors?.length) {
    sections.push(`## 你上一次的输出没有通过检查，请修正后重新输出\n${ctx.retryErrors.map((e) => `- ${e}`).join("\n")}`);
  }
  return sections.join("\n\n");
}
