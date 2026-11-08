// AI 输出的内容检查（设计文档第 5.5 节、第 6 节第 4 条、M3 待办事项）。
// JSON 结构已由 CLI 的 --json-schema 和 zod 保证；这里检查内容规则。
// error：必须修正，会让 AI 重试；warning：记录并提示，不阻止。
import { MAX_NEW_ITEMS, isSeedTurn, rejectedItems } from "./ai-context";
import { labeler } from "./describe";
import { findLoops } from "./loops";
import { PatchError, applyOps } from "./patch";
import type { AiOutput, Graph, Patch } from "./schema";
import { directionalWord, normalizeLabel } from "./validate";

export type ViolationCode =
  // error
  | "invalid_ops" // 引用不存在、重名、重复关系等，补丁无法应用
  | "kind_mismatch" // clarify / answer 带了 ops，或 patch 没有 ops
  | "too_many_new" // 非种子轮新增超过 3 个
  | "seed_size" // 种子图变量不在 3–5 个之间
  | "seed_loops" // 种子图闭环多于 1 个
  | "multiple_questions" // 问题不止一个（含 message 里的问号）
  | "missing_question" // clarify / patch 没有问题
  // warning
  | "loop_language" // 在文字中自己判断或描述回路
  | "directional_label" // 变量名带方向
  | "contested_unjustified" // 标了有争议但理由中没写争议所在
  | "reproposed_rejected"; // 重新提出用户拒绝过的内容

export interface Violation {
  code: ViolationCode;
  severity: "error" | "warning";
  message: string;
}

const ERROR_CODES = new Set<ViolationCode>([
  "invalid_ops",
  "kind_mismatch",
  "too_many_new",
  "seed_size",
  "seed_loops",
  "multiple_questions",
  "missing_question",
]);

/** AI 不应使用的回路相关字眼（回路由代码检测） */
export const LOOP_WORDS = /回路|反馈|循环|增强|平衡|自我强化|自我加强|loop|feedback|reinforc|balanc/i;
/** 标了 contested 时，理由中应体现争议所在 */
const CONTESTED_EXPLAINED = /争议|分歧|观点|看法|立场|一方|另一方|有人认为|也有人|批评|支持者|反对者|学者|研究者|debat|disput|contest/i;

const countQuestions = (s: string) => (s.match(/[?？]/g) ?? []).length;

export function checkAiOutput(out: AiOutput, graph: Graph, patches: readonly Patch[] = []): Violation[] {
  const v: Violation[] = [];
  const push = (code: ViolationCode, message: string) => v.push({ code, severity: ERROR_CODES.has(code) ? "error" : "warning", message });

  // 类型与操作是否匹配
  if (out.kind !== "patch" && out.ops.length) push("kind_mismatch", `kind 为 ${out.kind} 时 ops 应为空`);
  if (out.kind === "patch" && !out.ops.length) push("kind_mismatch", "kind 为 patch 时 ops 不能为空");

  // 问题数
  const q = countQuestions(out.question);
  if (q > 1) push("multiple_questions", `question 中有 ${q} 个问号，只能问一个问题`);
  if (countQuestions(out.message) > 0) push("multiple_questions", "message 中不能包含问题（问号），问题只放在 question 里");
  if (out.kind !== "answer" && !out.question.trim()) push("missing_question", "clarify 和 patch 必须附一个问题");

  // 文字中的回路判断
  const texts: [string, string][] = [
    ["message", out.message],
    ["question", out.question],
    ...out.ops.flatMap((op, i): [string, string][] => ("rationale" in op && op.rationale ? [[`第 ${i + 1} 项的理由`, op.rationale]] : [])),
  ];
  for (const [where, text] of texts) {
    const m = text.match(LOOP_WORDS);
    if (m) push("loop_language", `${where}中出现了"${m[0]}"：回路由程序检测，不要自己判断`);
  }

  // 变量名与争议标记
  for (const op of out.ops) {
    const label = op.op === "add_node" || op.op === "update_node" || op.op === "merge_nodes" ? op.label : undefined;
    const word = label ? directionalWord(label) : null;
    if (label && word) push("directional_label", `变量名"${label}"含有方向词"${word}"`);
    if ((op.op === "add_edge" || op.op === "update_edge") && op.contested) {
      const why = op.rationale ?? (op.op === "update_edge" ? graph.edges.find((e) => e.id === op.id)?.rationale : "") ?? "";
      if (!CONTESTED_EXPLAINED.test(why)) push("contested_unjustified", `标了有争议，但理由中没有写明争议所在：${why || "（无理由）"}`);
    }
  }

  // 重新提出被拒绝的内容
  const rejected = rejectedItems(graph, patches);
  const rejectedKeys = new Set(rejected.map((r) => `${r.kind}:${r.key}`));
  const label = labeler(graph, out.ops);
  for (const op of out.ops) {
    if (op.op === "add_node" && rejectedKeys.has(`node:${normalizeLabel(op.label)}`)) {
      push("reproposed_rejected", `变量「${op.label}」之前被用户拒绝过`);
    }
    if (op.op === "add_edge" && rejectedKeys.has(`edge:${normalizeLabel(label(op.from))}->${normalizeLabel(label(op.to))}`)) {
      push("reproposed_rejected", `关系「${label(op.from)} → ${label(op.to)}」之前被用户拒绝过`);
    }
  }

  // 规模
  const newNodes = out.ops.filter((o) => o.op === "add_node").length;
  const newEdges = out.ops.filter((o) => o.op === "add_edge").length;
  const seed = isSeedTurn(graph) && out.kind === "patch";
  if (seed) {
    if (newNodes < 3 || newNodes > 5) push("seed_size", `种子图应有 3 到 5 个变量，实际 ${newNodes} 个`);
  } else if (newNodes + newEdges > MAX_NEW_ITEMS) {
    push("too_many_new", `新增变量和关系合计 ${newNodes + newEdges} 个，超过 ${MAX_NEW_ITEMS} 个`);
  }

  // 试应用：引用、重名、重复关系等；种子图再数闭环
  if (out.ops.length) {
    try {
      const after = applyOps(graph, out.ops.map((op, index) => ({ index, op })), "ai");
      if (seed) {
        const loops = findLoops(after).loops.length;
        if (loops > 1) push("seed_loops", `种子图中形成了 ${loops} 个闭环，最多 1 个`);
      }
    } catch (e) {
      if (!(e instanceof PatchError)) throw e;
      push("invalid_ops", e.message);
    }
  }

  return v;
}

export const errorsOf = (v: readonly Violation[]) => v.filter((x) => x.severity === "error");
export const warningsOf = (v: readonly Violation[]) => v.filter((x) => x.severity === "warning");
