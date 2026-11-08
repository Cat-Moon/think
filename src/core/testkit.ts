// 测试用的小工具：用简短的写法造图。只在测试中使用。
import { Graph as GraphSchema, type Graph } from "./schema";

/**
 * makeGraph(["房价", "需求"], ["n2->n1 +", "n1->n2 - uncertain", "n1->n2 ? rejected"])
 * 节点按顺序编号 n1, n2, …；边按顺序编号 e1, e2, …
 * 边的写法："from->to 极性 [状态]"，状态默认 accepted。
 */
export function makeGraph(labels: string[], edges: string[] = [], version = "v001"): Graph {
  return GraphSchema.parse({
    schema_version: 1,
    version,
    frame: { topic: "测试" },
    nodes: labels.map((label, i) => ({ id: `n${i + 1}`, label, status: "accepted", origin: "user" })),
    edges: edges.map((spec, i) => {
      const [path, polarity, status = "accepted"] = spec.split(/\s+/);
      const [from, to] = path!.split("->");
      return { id: `e${i + 1}`, from, to, polarity, status, origin: "user" };
    }),
  });
}

export const NOW = "2026-11-08T14:00:00.000Z";
