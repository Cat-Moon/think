// M4 用的手写示例数据：用 core 的补丁函数从空图一步步搭出来，保证版本、补丁和拒绝记录都是一致的。
// 现在用于测试和 scripts/seed-workspace.ts（生成界面检查用的工作区）。
import { edgeActionOps, makePatch, resolvePatch, type Choices, type EdgeAction } from "../core/patch";
import type { Graph, Patch, PatchOp, Version } from "../core/schema";
import { initialVersion, restoreVersion } from "../core/version";

export interface DemoState {
  versions: Version[];
  patches: Patch[];
  /** 待处理的 AI 补丁 */
  pending: Patch | null;
}

const T = () => new Date().toISOString();
const pid = (s: DemoState) => `p${String(s.patches.length + (s.pending ? 2 : 1)).padStart(3, "0")}`;
export const current = (s: DemoState): Graph => s.versions.at(-1)!.graph;

function commit(s: DemoState, patch: Patch, choices: Choices): DemoState {
  const r = resolvePatch(current(s), patch, choices, T());
  return { ...s, versions: r.version ? [...s.versions, r.version] : s.versions, patches: [...s.patches, r.patch] };
}

/** 示例：越修路越堵 */
export function demoState(): DemoState {
  let s: DemoState = { versions: [initialVersion("城市交通为什么越修路越堵", T())], patches: [], pending: null };
  const ai = (ops: PatchOp[], message = "", question = ""): Patch =>
    makePatch({ patch_id: pid(s), base_version: current(s).version, origin: "ai", ops, message, question }, T());

  // 种子图（拒绝了最后一条）
  s = commit(
    s,
    ai([
      { op: "set_frame", phenomenon: "修了更多道路，拥堵却在几年后回升", perspective: "城市通勤者", time_horizon: "约 10 年", context: "未指定" },
      { op: "add_node", ref: "$jam", label: "交通拥堵程度" },
      { op: "add_node", ref: "$build", label: "修路投入" },
      { op: "add_node", ref: "$road", label: "道路容量" },
      { op: "add_node", ref: "$trips", label: "驾车出行量" },
      { op: "add_edge", from: "$jam", to: "$build", polarity: "+", rationale: "拥堵促使政府增加修路投入", delay: true },
      { op: "add_edge", from: "$build", to: "$road", polarity: "+", rationale: "修路增加道路容量", delay: true },
      { op: "add_edge", from: "$road", to: "$jam", polarity: "-", rationale: "容量增加在短期内缓解拥堵" },
      { op: "add_edge", from: "$road", to: "$trips", polarity: "+", rationale: "路好走吸引更多人开车（诱发需求）" },
      { op: "add_edge", from: "$trips", to: "$jam", polarity: "+", rationale: "车多了更堵" },
      { op: "add_edge", from: "$jam", to: "$trips", polarity: "-", rationale: "太堵时一部分人改用其他方式" },
    ]),
    { 0: { decision: "accepted" }, 1: { decision: "accepted" }, 2: { decision: "accepted" }, 3: { decision: "accepted" }, 4: { decision: "accepted" }, 5: { decision: "accepted" }, 6: { decision: "accepted" }, 7: { decision: "accepted" }, 8: { decision: "accepted" }, 9: { decision: "accepted" }, 10: { decision: "rejected", reason: "先不考虑" } },
  );
  // 第二轮：一个新变量（极性未知、不确定）和一条有争议的关系
  s = commit(
    s,
    ai([
      { op: "add_node", ref: "$transit", label: "公共交通吸引力" },
      { op: "add_edge", from: "$transit", to: "n4", polarity: "-", rationale: "公交更好时一部分人不开车" },
      { op: "add_edge", from: "n1", to: "$transit", polarity: "?", rationale: "拥堵可能让公交也变慢，也可能让人更愿意坐地铁" },
    ]),
    "all",
  );
  s = commit(s, makePatch({ patch_id: pid(s), base_version: current(s).version, origin: "user", ops: [{ op: "update_edge", id: "e7", status: "uncertain" }] }, T()), "all");
  s = commit(
    s,
    makePatch(
      {
        patch_id: pid(s),
        base_version: current(s).version,
        origin: "ai",
        ops: [{ op: "add_edge", from: "n2", to: "n5", polarity: "-", rationale: "有人认为修路挤占了公交预算；也有人认为两者资金来源不同，互不影响", contested: true }],
      },
      T(),
    ),
    "all",
  );
  // 待处理的 AI 补丁
  s = {
    ...s,
    pending: ai(
      [
        { op: "add_node", ref: "$sprawl", label: "城市蔓延程度" },
        { op: "add_edge", from: "n3", to: "$sprawl", polarity: "+", rationale: "新道路让远郊变得可达，住宅和商业向外扩散", delay: true },
        { op: "add_edge", from: "$sprawl", to: "n4", polarity: "+", rationale: "居住和工作地点更分散，出行距离变长，更依赖开车" },
        { op: "update_edge", id: "e4", delay: true, note: "诱发需求通常要几年才显现" },
      ],
      "这里补充一条城市蔓延的路径：新道路改变居住和工作的分布，而不只是改变出行方式。",
      "你所在的城市里，新修的道路周边是否出现了新的住宅区或商场？",
    ),
  };
  return s;
}

/** 点按边上的按钮：生成用户补丁并立即接受 */
export function applyEdgeAction(s: DemoState, edgeId: string, action: EdgeAction, opts: { reason?: string; polarity?: "+" | "-" } = {}): DemoState {
  const e = current(s).edges.find((x) => x.id === edgeId);
  if (!e) return s;
  const patch = makePatch({ patch_id: pid(s), base_version: current(s).version, origin: "user", ops: edgeActionOps(e, action, opts) }, T());
  return commit(s, patch, "all");
}

/** 处理待处理的 AI 补丁 */
export function resolvePending(s: DemoState, choices: Choices): DemoState {
  if (!s.pending) return s;
  return { ...commit(s, s.pending, choices), pending: null };
}

export function restoreTo(s: DemoState, versionId: string): DemoState {
  const target = s.versions.find((v) => v.version === versionId);
  if (!target) return s;
  return { ...s, versions: [...s.versions, restoreVersion(current(s), target.graph, T())] };
}
