// AI 输出的内容检查（设计文档第 8.1.2 节）。
// JSON 结构已由 CLI 的 --json-schema 和 zod 保证；这里检查内容规则。
// error（硬性违规）：会让 AI 重试一次；warning（软性违规）：只记录并提示，不重试。
import { MAX_NEW_ITEMS, isSeedTurn, rejectedItems } from "./ai-context";
import { labeler } from "./describe";
import { activeEdges, findLoops } from "./loops";
import { PatchError, applyOps } from "./patch";
import { isContextUnspecified, type AiOutput, type Graph, type Patch, type PatchOp } from "./schema";
import { directionalWord, normalizeLabel } from "./validate";

export type ViolationCode =
  // error：硬性违规，重试
  | "invalid_ops" // 引用不存在、重名、重复关系等，补丁无法应用
  | "kind_mismatch" // clarify / answer 带了 ops，或 patch 没有 ops（结构错误）
  | "too_many_new" // 非种子轮新增超过 3 个；种子图变量超过 5 个
  | "multiple_questions" // question 字段里不止一个问题
  // warning：软性违规，只记录
  | "question_in_message" // message 里夹带问题
  | "missing_question" // clarify / patch 没有问题
  | "seed_size" // 种子图变量少于 3 个
  | "seed_loops" // 种子图闭环多于 1 个
  | "loop_language" // 在文字中判断、描述或预告回路
  | "directional_label" // 变量名带方向
  | "contested_unjustified" // 标了有争议但理由中没写争议所在
  | "long_rationale" // 理由超过 2 句
  | "unverified_citation" // 引用具体研究者或文献，但没有标注"AI 记忆，未核实"
  | "region_assumed" // 地区未指定，但文字中出现了具体国家或地区制度
  | "internal_id" // 显示文字里出现内部 ID（已自动替换）
  | "ui_detail" // 提到界面细节（颜色、按钮等）
  | "reproposed_rejected" // 重新提出用户拒绝过的内容
  | "rejected_used_in_answer" // 回答中可能把被拒绝的关系当作事实
  | "rejected_bypass"; // 被拒绝的 A→B 经由新变量形成了 A ⇝ B 的路径

export interface Violation {
  code: ViolationCode;
  severity: "error" | "warning";
  message: string;
}

const ERROR_CODES = new Set<ViolationCode>(["invalid_ops", "kind_mismatch", "too_many_new", "multiple_questions"]);
export const isHardViolation = (code: ViolationCode) => ERROR_CODES.has(code);

/** 回路相关的具体说法（AI 不应自己判断或预告回路；单独的"增强""反馈"是普通用词，不算） */
export const LOOP_PHRASES =
  /回路|增强环|平衡环|正反馈|负反馈|反馈环|反馈机制|恶性循环|良性循环|循环往复|形成.{0,6}循环|闭环|闭合|自我强化|自我加强|自我放大|螺旋上升|新的结构|新结构|feedback loop|reinforcing|balancing loop|vicious (circle|cycle)|virtuous (circle|cycle)|\bloops?\b/i;
/** 标了 contested 时，理由中应体现争议所在 */
const CONTESTED_EXPLAINED = /争议|分歧|观点|看法|立场|一方|另一方|有人认为|也有人|另一些|另有|一些研究|有研究|批评|支持者|反对者|学界|debat|disput|contest/i;
/** 引用具体研究者、文献或年份 */
const CITATION = /[A-Z][a-zA-Z'-]+(\s(and|&)\s[A-Z][a-zA-Z'-]+)?\s*(等人|et al|的(研究|理论|实验|论文)|（\d{4}）|\(\d{4}\))|《[^》]{2,}》|\b(19|20)\d{2}\s*年的?(研究|论文|实验|调查)/;
export const CITATION_MARK = "AI 记忆，未核实";
/** 地区未指定时不应出现的国家、地区或地区特有的制度 */
const REGION_WORDS =
  /中国|美国|日本|英国|德国|法国|韩国|印度|俄罗斯|欧洲|欧盟|北美|拉美|北京|上海|深圳|广州|香港|台湾|新加坡|加拿大|澳大利亚|共和党|民主党|国会|特朗普|拜登|户籍|户口|限购|公积金|土地财政|学区房|一线城市|二线城市|高考|内卷|America|China|Japan|Europe|Republican|Democrat|Congress/;
const UI_WORDS = /橙色|红色|绿色|蓝色|黄色|灰色|颜色|虚线|实线|高亮|按钮|点击(?![率量])|界面|画布|标成.色/;
const INTERNAL_ID = /(?<![A-Za-z0-9_])(?:[ne]\d+)(?![A-Za-z0-9_])|\$[^\s$，。、；：「」『』（）()《》,.;:!?！？"'“”]+/;

const countQuestions = (s: string) => (s.match(/[?？]/g) ?? []).length;
const sentenceCount = (s: string) => s.split(/[。！？!?；;]+/).filter((x) => x.trim().length > 1).length;

/** AI 输出中所有给用户看的文字：[位置, 文字] */
function displayTexts(out: AiOutput): [string, string][] {
  return [
    ["说明", out.message],
    ["问题", out.question],
    ...out.ops.flatMap((op, i): [string, string][] => {
      const t: [string, string][] = [];
      if ("rationale" in op && op.rationale) t.push([`第 ${i + 1} 项的理由`, op.rationale]);
      if ("reason" in op && op.reason) t.push([`第 ${i + 1} 项的原因`, op.reason]);
      return t;
    }),
  ];
}

export function checkAiOutput(out: AiOutput, graph: Graph, patches: readonly Patch[] = []): Violation[] {
  const v: Violation[] = [];
  const push = (code: ViolationCode, message: string) => v.push({ code, severity: isHardViolation(code) ? "error" : "warning", message });

  // 结构
  if (out.kind !== "patch" && out.ops.length) push("kind_mismatch", `kind 为 ${out.kind} 时 ops 应为空`);
  if (out.kind === "patch" && !out.ops.length) push("kind_mismatch", "kind 为 patch 时 ops 不能为空");

  // 问题
  const q = countQuestions(out.question);
  if (q > 1) push("multiple_questions", `question 中有 ${q} 个问号，只能问一个问题`);
  if (countQuestions(out.message) > 0) push("question_in_message", "message 中夹带了问题，问题应只放在 question 里");
  if (out.kind !== "answer" && !out.question.trim()) push("missing_question", "clarify 和 patch 应附一个问题");

  // 文字：回路、引用、地区、内部 ID、界面细节
  const regionOpen = isContextUnspecified(graph.frame.context) && !out.ops.some((o) => o.op === "set_frame" && !isContextUnspecified(o.context));
  for (const [where, text] of displayTexts(out)) {
    const loop = text.match(LOOP_PHRASES);
    if (loop) push("loop_language", `${where}中出现了"${loop[0]}"：回路由程序检测，不要判断或预告`);
    const cite = text.match(CITATION);
    if (cite && !text.includes(CITATION_MARK)) push("unverified_citation", `${where}引用了"${cite[0]}"，但没有标注"${CITATION_MARK}"`);
    const region = regionOpen ? text.match(REGION_WORDS) : null;
    if (region) push("region_assumed", `地区/语境未指定，但${where}中出现了"${region[0]}"`);
    const id = text.match(INTERNAL_ID);
    if (id) push("internal_id", `${where}中出现了内部 ID "${id[0]}"（已自动替换）`);
    const ui = text.match(UI_WORDS);
    if (ui) push("ui_detail", `${where}中提到了界面细节"${ui[0]}"`);
  }

  // 每条操作：变量名、理由长度、争议
  for (const [i, op] of out.ops.entries()) {
    const label = op.op === "add_node" || op.op === "update_node" || op.op === "merge_nodes" ? op.label : undefined;
    const word = label ? directionalWord(label) : null;
    if (label && word) push("directional_label", `变量名"${label}"含有方向词"${word}"`);
    if ("rationale" in op && op.rationale && sentenceCount(op.rationale) > 2) {
      push("long_rationale", `第 ${i + 1} 项的理由有 ${sentenceCount(op.rationale)} 句，应不超过 2 句`);
    }
    if ((op.op === "add_edge" || op.op === "update_edge") && op.contested) {
      const why = op.rationale ?? (op.op === "update_edge" ? graph.edges.find((e) => e.id === op.id)?.rationale : "") ?? "";
      if (!CONTESTED_EXPLAINED.test(why)) push("contested_unjustified", `标了有争议，但理由中没有写明争议所在：${why || "（无理由）"}`);
    }
  }

  // 被拒绝的内容
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
  if (out.kind === "answer") {
    for (const r of rejected) {
      if (r.kind !== "edge" || !r.from || !r.to) continue;
      if (out.message.includes(r.from) && out.message.includes(r.to) && !/不同意|拒绝|否定|不认同/.test(out.message)) {
        push("rejected_used_in_answer", `回答同时提到了「${r.from}」和「${r.to}」，而用户拒绝过「${r.from} → ${r.to}」，但回答中没有说明`);
      }
    }
  }

  // 规模
  const newNodes = out.ops.filter((o) => o.op === "add_node").length;
  const newEdges = out.ops.filter((o) => o.op === "add_edge").length;
  const seed = isSeedTurn(graph) && out.kind === "patch";
  if (seed) {
    if (newNodes > 5) push("too_many_new", `种子图应有 3 到 5 个变量，实际 ${newNodes} 个`);
    if (newNodes < 3) push("seed_size", `种子图应有 3 到 5 个变量，实际 ${newNodes} 个`);
  } else if (newNodes + newEdges > MAX_NEW_ITEMS) {
    push("too_many_new", `新增变量和关系合计 ${newNodes + newEdges} 个，超过 ${MAX_NEW_ITEMS} 个`);
  }

  // 试应用：引用、重名、重复关系等；种子图数闭环；绕道路径
  if (out.ops.length) {
    try {
      const after = applyOps(graph, out.ops.map((op, index) => ({ index, op })), "ai");
      if (seed) {
        const loops = findLoops(after).loops.length;
        if (loops > 1) push("seed_loops", `种子图中形成了 ${loops} 个闭环，最多 1 个`);
      }
      for (const msg of rejectedBypasses(graph, after, patches)) push("rejected_bypass", msg);
    } catch (e) {
      if (!(e instanceof PatchError)) throw e;
      push("invalid_ops", e.message);
    }
  }

  return v;
}

/**
 * 被拒绝的关系 A→B：如果应用补丁后出现了一条经由新变量的 A ⇝ B 路径（之前没有），返回提示。
 * 只提示，不阻止。路径只用参与计算的边，长度不超过 4 步。
 */
export function rejectedBypasses(before: Graph, after: Graph, patches: readonly Patch[]): string[] {
  const rejectedEdges = rejectedItems(before, patches).filter((r) => r.kind === "edge" && r.from && r.to);
  if (!rejectedEdges.length) return [];
  const newIds = new Set(after.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id)).map((n) => n.id));
  if (!newIds.size) return [];
  const byLabel = (g: Graph, l: string) => g.nodes.find((n) => n.status === "accepted" && normalizeLabel(n.label) === normalizeLabel(l))?.id;
  const label = labeler(after);

  const findPath = (g: Graph, from: string, to: string): string[] | null => {
    const out = new Map<string, string[]>();
    for (const e of activeEdges(g)) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    const queue: string[][] = [[from]];
    while (queue.length) {
      const path = queue.shift()!;
      if (path.length > 5) break;
      for (const next of out.get(path.at(-1)!) ?? []) {
        if (path.includes(next)) continue;
        const p = [...path, next];
        if (next === to) {
          if (p.length > 2) return p; // 直接边不算"绕道"
          continue;
        }
        queue.push(p);
      }
    }
    return null;
  };

  const msgs: string[] = [];
  for (const r of rejectedEdges) {
    const a = byLabel(after, r.from!);
    const b = byLabel(after, r.to!);
    if (!a || !b) continue;
    const path = findPath(after, a, b);
    if (!path || !path.some((id) => newIds.has(id))) continue;
    const a0 = byLabel(before, r.from!);
    const b0 = byLabel(before, r.to!);
    if (a0 && b0 && findPath(before, a0, b0)) continue; // 之前就有这条路径
    msgs.push(`你之前不同意「${r.from} → ${r.to}」；这个建议会形成路径 ${path.map(label).join(" → ")}`);
  }
  return msgs;
}

/**
 * 显示文字的安全网：把内部 ID 换成变量名。
 * n5「房价」→ 「房价」；n5 → 「房价」；e3 → 「A → B」这条关系；$ref → 「变量名」
 */
export function sanitizeDisplayText(text: string, graph: Graph, ops: readonly PatchOp[] = []): string {
  const label = labeler(graph, ops);
  const edge = (id: string) => graph.edges.find((e) => e.id === id);
  // ID 两边为了和中文隔开而加的单个空格，替换后一并去掉
  return text
    .replace(/ ?(?<![A-Za-z0-9_])(n\d+)(?![A-Za-z0-9_]) ?([「『（(][^」』）)]*[」』）)])? ?/g, (m, id: string, quoted?: string) => {
      const l = label(id);
      if (l === id) return m; // 不认识的 ID 保持原样
      return quoted ?? `「${l}」`;
    })
    .replace(/ ?(?<![A-Za-z0-9_])(e\d+)(?![A-Za-z0-9_]) ?/g, (m, id: string) => {
      const e = edge(id);
      return e ? `「${label(e.from)} → ${label(e.to)}」这条关系` : "这条关系";
    })
    .replace(/ ?(\$[^\s$，。、；：「」『』（）()《》,.;:!?！？"'“”]+) ?/g, (m, ref: string) => {
      const l = label(ref);
      return l === ref ? m : `「${l}」`;
    })
    .replace(/「「([^」]*)」」/g, "「$1」");
}

/** 对 AI 输出中所有显示文字做 sanitizeDisplayText（ops 的结构字段不变） */
export function sanitizeAiOutput(out: AiOutput, graph: Graph): AiOutput {
  const s = (t: string) => sanitizeDisplayText(t, graph, out.ops);
  return {
    ...out,
    message: s(out.message),
    question: s(out.question),
    ops: out.ops.map((op) => {
      const o = { ...op } as PatchOp & { rationale?: string; reason?: string };
      if (o.rationale) o.rationale = s(o.rationale);
      if (o.reason) o.reason = s(o.reason);
      return o;
    }),
    possible_duplicates: out.possible_duplicates.map((d) => ({ ...d, reason: s(d.reason) })),
  };
}

export const errorsOf = (v: readonly Violation[]) => v.filter((x) => x.severity === "error");
export const warningsOf = (v: readonly Violation[]) => v.filter((x) => x.severity === "warning");
