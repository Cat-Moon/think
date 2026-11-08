import { describe, expect, it } from "vitest";
import { buildTurnPrompt, isSeedTurn, rejectedItems } from "./ai-context";
import { checkAiOutput } from "./ai-check";
import { makePatch, resolvePatch } from "./patch";
import type { AiOutput, Graph, PatchOp } from "./schema";
import { NOW, makeGraph } from "./testkit";
import { initialVersion } from "./version";

const out = (o: Partial<AiOutput>): AiOutput => ({ kind: "patch", message: "说明。", question: "你怎么看？", ops: [], possible_duplicates: [], ...o });
const codes = (o: Partial<AiOutput>, g: Graph, patches = [] as Parameters<typeof checkAiOutput>[2]) =>
  checkAiOutput(out(o), g, patches).map((v) => `${v.severity}:${v.code}`);

const seedOps: PatchOp[] = [
  { op: "add_node", ref: "$a", label: "房价" },
  { op: "add_node", ref: "$b", label: "购房需求" },
  { op: "add_node", ref: "$c", label: "住房供给" },
  { op: "add_edge", from: "$b", to: "$a", polarity: "+", rationale: "需求推高价格" },
  { op: "add_edge", from: "$c", to: "$a", polarity: "-", rationale: "供给压低价格" },
];
const empty = () => initialVersion("房价", NOW).graph;
const twoNodes = () => makeGraph(["房价", "购房需求"], ["n2->n1 +"]);

describe("checkAiOutput", () => {
  it("合格的种子补丁没有问题", () => {
    expect(codes({ ops: seedOps }, empty())).toEqual([]);
  });

  it("种子图变量数和闭环数", () => {
    expect(codes({ ops: seedOps.slice(0, 2) }, empty())).toContain("error:seed_size");
    const loops: PatchOp[] = [
      ...seedOps.slice(0, 3),
      { op: "add_edge", from: "$a", to: "$b", polarity: "-", rationale: "" },
      { op: "add_edge", from: "$b", to: "$a", polarity: "+", rationale: "" },
      { op: "add_edge", from: "$a", to: "$c", polarity: "+", rationale: "" },
      { op: "add_edge", from: "$c", to: "$a", polarity: "-", rationale: "" },
    ];
    expect(codes({ ops: loops }, empty())).toEqual(["error:seed_loops"]);
  });

  it("非种子轮最多新增 3 个", () => {
    const ops: PatchOp[] = [
      { op: "add_node", ref: "$x", label: "贷款利率" },
      { op: "add_node", ref: "$y", label: "人口" },
      { op: "add_edge", from: "$x", to: "n2", polarity: "-", rationale: "" },
      { op: "add_edge", from: "$y", to: "n2", polarity: "+", rationale: "" },
    ];
    expect(codes({ ops }, twoNodes())).toEqual(["error:too_many_new"]);
    expect(codes({ ops: ops.slice(0, 3).filter((o) => o.op !== "add_node" || o.ref === "$x") }, twoNodes())).toEqual([]);
  });

  it("问题只能有一个，message 里不能有问号", () => {
    expect(codes({ question: "A 吗？B 呢？" }, twoNodes())).toContain("error:multiple_questions");
    expect(codes({ message: "你觉得呢?" }, twoNodes())).toContain("error:multiple_questions");
    expect(codes({ question: "" }, twoNodes())).toContain("error:missing_question");
    expect(codes({ kind: "answer", question: "" }, twoNodes())).toEqual([]);
  });

  it("kind 与 ops 匹配", () => {
    expect(codes({ kind: "clarify", ops: seedOps }, empty())).toContain("error:kind_mismatch");
    expect(codes({ kind: "patch", ops: [] }, twoNodes())).toContain("error:kind_mismatch");
  });

  it("补丁无法应用时报 invalid_ops", () => {
    expect(codes({ ops: [{ op: "add_edge", from: "n9", to: "n1", polarity: "+", rationale: "" }] }, twoNodes())).toEqual(["error:invalid_ops"]);
    expect(codes({ ops: [{ op: "add_node", ref: "$a", label: "房价" }] }, twoNodes())).toEqual(["error:invalid_ops"]);
  });

  it("文字中出现回路字眼时警告", () => {
    expect(codes({ kind: "answer", message: "这形成了一个增强回路。" }, twoNodes())).toEqual(["warning:loop_language"]);
    expect(codes({ ops: [{ op: "update_edge", id: "e1", rationale: "存在 feedback" }] }, twoNodes())).toEqual(["warning:loop_language"]);
    expect(codes({ kind: "answer", message: "可以看看 R1 里的变量。" }, twoNodes())).toEqual([]);
  });

  it("变量名带方向时警告", () => {
    expect(codes({ ops: [{ op: "add_node", ref: "$a", label: "利率上升" }] }, twoNodes())).toEqual(["warning:directional_label"]);
  });

  it("标了有争议却没写争议所在时警告", () => {
    const e = (rationale: string): PatchOp => ({ op: "add_edge", from: "n1", to: "n2", polarity: "-", rationale, contested: true });
    expect(codes({ ops: [e("房价高抑制需求")] }, twoNodes())).toEqual(["warning:contested_unjustified"]);
    expect(codes({ ops: [e("有人认为房价高抑制需求，也有人认为高房价反而刺激投资需求")] }, twoNodes())).toEqual([]);
  });

  it("重新提出被拒绝的变量或关系时警告", () => {
    const g0 = twoNodes();
    const p = makePatch(
      {
        patch_id: "p001",
        base_version: g0.version,
        origin: "ai",
        ops: [
          { op: "add_node", ref: "$r", label: "贷款利率" },
          { op: "add_edge", from: "n1", to: "n2", polarity: "-", rationale: "" },
        ],
      },
      NOW,
    );
    const { patch, version } = resolvePatch(g0, p, { 0: { decision: "rejected", reason: "不重要" }, 1: { decision: "rejected" } }, NOW);
    expect(version).toBeNull();
    expect(rejectedItems(g0, [patch]).map((r) => r.text)).toEqual(["变量「贷款利率」", "关系「房价 →(−) 购房需求」"]);
    expect(codes({ ops: [{ op: "add_node", ref: "$x", label: " 贷款利率" }] }, g0, [patch])).toEqual(["warning:reproposed_rejected"]);
    expect(codes({ ops: [{ op: "add_edge", from: "n1", to: "n2", polarity: "+", rationale: "" }] }, g0, [patch])).toEqual(["warning:reproposed_rejected"]);
  });
});

describe("buildTurnPrompt", () => {
  it("种子轮：空图、提示可以澄清", () => {
    const g = empty();
    expect(isSeedTurn(g)).toBe(true);
    const prompt = buildTurnPrompt({ graph: g, patches: [], turns: [{ turn_id: "t001", role: "user", text: "房价", created_at: NOW }] });
    expect(prompt).toContain("（空）");
    expect(prompt).toContain("clarify");
    expect(prompt).toContain("用户的新消息：房价");
  });

  it("包含图、代码检测的闭环、拒绝清单、上一轮处理结果、最近对话和重试原因", () => {
    const g0 = makeGraph(["房价", "购房需求"], ["n2->n1 +", "n1->n2 -"]);
    const p = makePatch(
      { patch_id: "p001", base_version: g0.version, origin: "ai", ops: [{ op: "add_node", ref: "$r", label: "贷款利率" }, { op: "add_node", ref: "$s", label: "人口" }] },
      NOW,
    );
    const { patch, version } = resolvePatch(g0, p, { 0: { decision: "accepted" }, 1: { decision: "rejected", reason: "先不考虑" } }, NOW);
    const turns = [
      { turn_id: "t001", role: "user" as const, text: "房价为什么涨", created_at: NOW },
      { turn_id: "t002", role: "ai" as const, text: "先看供需。", question: "利率呢？", created_at: NOW },
      { turn_id: "t003", role: "user" as const, text: "为什么需求会推高房价", created_at: NOW },
    ];
    const prompt = buildTurnPrompt({ graph: version!.graph, patches: [patch], turns, retryErrors: ["问题太多"] });
    expect(prompt).toContain("- e1: n2 购房需求 →(+) n1 房价");
    expect(prompt).toContain("B1: 房价 → 购房需求 → 房价");
    expect(prompt).toContain("变量「人口」，理由：先不考虑");
    expect(prompt).toContain("新增变量「贷款利率」：接受");
    expect(prompt).toContain("你：先看供需。（问题：利率呢？）");
    expect(prompt).toContain("用户的新消息：为什么需求会推高房价");
    expect(prompt).not.toContain("用户：为什么需求会推高房价"); // 本轮消息不重复出现在历史里
    expect(prompt).toContain("- 问题太多");
  });
});
