// 图校验（设计文档第 6 节第 3 条）。
// 结构错误（重复 ID、引用不存在的节点）由 schema.ts 的 Graph 模式负责；
// 这里只做"内容提示"，全部是 warning，不阻止操作。
import { activeEdges } from "./loops";
import type { Graph } from "./schema";

export type IssueCode =
  | "duplicate_label" // 标签归一化后相同
  | "similar_label" // 一个标签包含另一个
  | "directional_label" // 疑似带方向的变量名
  | "isolated_node" // 没有任何参与计算的边
  | "self_loop" // 自己指向自己
  | "parallel_edges"; // 同向的两条边

export interface Issue {
  code: IssueCode;
  message: string;
  /** 涉及的节点或边 ID */
  ids: string[];
}

/** 标签归一化：全角转半角、去空白和标点、转小写 */
export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * 疑似带方向的词。变量名应是可增可减的中性名词（写"房价"，不写"房价上涨"）。
 * 只做提示：像"降水量"这样的词也可能误报。
 */
const DIRECTIONAL_WORDS_ZH = [
  "上涨", "上升", "下降", "下跌", "增加", "减少", "降低", "提高", "提升",
  "过多", "过少", "过高", "过低", "缺乏", "不足", "变多", "变少", "恶化", "改善",
];
const DIRECTIONAL_WORDS_EN = /\b(increas\w*|decreas\w*|ris(e|es|ing)|fall(s|ing)?|more|less|higher|lower|lack\w*|too)\b/i;

export function directionalWord(label: string): string | null {
  const zh = DIRECTIONAL_WORDS_ZH.find((w) => label.includes(w));
  if (zh) return zh;
  const en = label.match(DIRECTIONAL_WORDS_EN);
  return en ? en[0] : null;
}

export function validateGraph(g: Graph): Issue[] {
  const issues: Issue[] = [];
  const nodes = g.nodes.filter((n) => n.status === "accepted");
  const edges = activeEdges(g);

  // 标签：重复、相似、带方向
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    const na = normalizeLabel(a.label);
    const word = directionalWord(a.label);
    if (word) {
      issues.push({ code: "directional_label", message: `变量名"${a.label}"含有方向词"${word}"，建议改成中性名词`, ids: [a.id] });
    }
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      const nb = normalizeLabel(b.label);
      if (na === nb) {
        issues.push({ code: "duplicate_label", message: `"${a.label}"和"${b.label}"是同一个名称`, ids: [a.id, b.id] });
      } else if (Math.min(na.length, nb.length) >= 2 && (na.includes(nb) || nb.includes(na))) {
        issues.push({ code: "similar_label", message: `"${a.label}"和"${b.label}"可能指同一件事`, ids: [a.id, b.id] });
      }
    }
  }

  // 孤立节点（只有一个节点时不提示）
  if (nodes.length > 1) {
    const touched = new Set(edges.flatMap((e) => [e.from, e.to]));
    for (const n of nodes) {
      if (!touched.has(n.id)) {
        issues.push({ code: "isolated_node", message: `"${n.label}"还没有和其他变量连接`, ids: [n.id] });
      }
    }
  }

  // 自环、平行边
  const seen = new Map<string, string>();
  for (const e of edges) {
    if (e.from === e.to) {
      issues.push({ code: "self_loop", message: `边 ${e.id} 指向自己`, ids: [e.id] });
    }
    const key = `${e.from}->${e.to}`;
    const other = seen.get(key);
    if (other) {
      issues.push({ code: "parallel_edges", message: `边 ${other} 和 ${e.id} 方向相同，可能需要合并`, ids: [other, e.id] });
    } else {
      seen.set(key, e.id);
    }
  }

  return issues;
}
