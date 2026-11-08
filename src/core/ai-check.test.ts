import { describe, expect, it } from "vitest";
import { buildTurnPrompt, isSeedTurn, rejectedItems } from "./ai-context";
import { checkAiOutput, rejectedBypasses, sanitizeAiOutput, sanitizeDisplayText } from "./ai-check";
import { applyOps, makePatch, resolvePatch } from "./patch";
import type { AiOutput, Graph, Patch, PatchOp } from "./schema";
import { NOW, makeGraph } from "./testkit";
import { initialVersion } from "./version";

const out = (o: Partial<AiOutput>): AiOutput => ({ kind: "patch", message: "说明。", question: "你怎么看？", ops: [], possible_duplicates: [], ...o });
const answer = (message: string): Partial<AiOutput> => ({ kind: "answer", message, question: "" });
const codes = (o: Partial<AiOutput>, g: Graph, patches: readonly Patch[] = []) =>
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

/** 在 g 上处理一个 AI 补丁，返回处理后的补丁（含拒绝记录） */
const decided = (g: Graph, ops: PatchOp[], choices: Parameters<typeof resolvePatch>[2]) =>
  resolvePatch(g, makePatch({ patch_id: "p001", base_version: g.version, origin: "ai", ops }, NOW), choices, NOW);

describe("硬性违规（重试）", () => {
  it("合格的种子补丁没有问题", () => {
    expect(codes({ ops: seedOps }, empty())).toEqual([]);
  });

  it("补丁无法应用", () => {
    expect(codes({ ops: [{ op: "add_edge", from: "n9", to: "n1", polarity: "+", rationale: "" }] }, twoNodes())).toEqual(["error:invalid_ops"]);
    expect(codes({ ops: [{ op: "add_node", ref: "$a", label: "房价" }] }, twoNodes())).toEqual(["error:invalid_ops"]);
  });

  it("非种子轮新增超过 3 个；种子图变量超过 5 个", () => {
    const ops: PatchOp[] = [
      { op: "add_node", ref: "$x", label: "贷款利率" },
      { op: "add_node", ref: "$y", label: "人口" },
      { op: "add_edge", from: "$x", to: "n2", polarity: "-", rationale: "" },
      { op: "add_edge", from: "$y", to: "n2", polarity: "+", rationale: "" },
    ];
    expect(codes({ ops }, twoNodes())).toEqual(["error:too_many_new"]);
    const six = ["A", "B", "C", "D", "E", "F"].map((l, i): PatchOp => ({ op: "add_node", ref: `$v${i}`, label: l }));
    expect(codes({ ops: six }, empty())).toContain("error:too_many_new");
  });

  it("question 字段里不止一个问题", () => {
    expect(codes({ question: "A 吗？B 呢？" }, twoNodes())).toContain("error:multiple_questions");
  });

  it("kind 与 ops 不匹配", () => {
    expect(codes({ kind: "clarify", ops: seedOps }, empty())).toContain("error:kind_mismatch");
  });
});

describe("软性违规（只记录）", () => {
  const edge = (rationale: string, extra: Partial<PatchOp> = {}): PatchOp =>
    ({ op: "add_edge", from: "n1", to: "n2", polarity: "-", rationale, ...extra }) as PatchOp;

  it("message 里夹带问题、缺少问题、种子图偏小或闭环多", () => {
    expect(codes({ ...answer("你觉得呢？") }, twoNodes())).toEqual(["warning:question_in_message"]);
    expect(codes({ ops: [edge("高价抑制需求")], question: "" }, twoNodes())).toEqual(["warning:missing_question"]);
    expect(codes({ ops: seedOps.slice(0, 2) }, empty())).toEqual(["warning:seed_size"]);
    const loops: PatchOp[] = [
      ...seedOps.slice(0, 3),
      { op: "add_edge", from: "$a", to: "$b", polarity: "-", rationale: "" },
      { op: "add_edge", from: "$b", to: "$a", polarity: "+", rationale: "" },
      { op: "add_edge", from: "$a", to: "$c", polarity: "+", rationale: "" },
      { op: "add_edge", from: "$c", to: "$a", polarity: "-", rationale: "" },
    ];
    expect(codes({ ops: loops }, empty())).toEqual(["warning:seed_loops"]);
  });

  it("回路说法：具体短语才算，普通的'增强''反馈'不算", () => {
    for (const m of ["这形成了一个增强回路。", "这是一个恶性循环。", "加上这条关系，机制就闭合了。", "补上后图里会出现一个新的结构。", "存在正反馈。"]) {
      expect(codes(answer(m), twoNodes()), m).toEqual(["warning:loop_language"]);
    }
    for (const m of ["购车意愿增强。", "做事时没有即时反馈。", "可以看看 R1 里的变量。"]) {
      expect(codes(answer(m), twoNodes()), m).toEqual([]);
    }
  });

  it("变量名带方向", () => {
    expect(codes({ ops: [{ op: "add_node", ref: "$a", label: "利率上升" }] }, twoNodes())).toEqual(["warning:directional_label"]);
  });

  it("理由超过 2 句", () => {
    expect(codes({ ops: [edge("高价抑制需求。买不起就不买。也有人等降价。")] }, twoNodes())).toEqual(["warning:long_rationale"]);
    expect(codes({ ops: [edge("高价抑制需求；买不起的人会推迟购买。")] }, twoNodes())).toEqual([]);
  });

  it("标了有争议却没写争议所在", () => {
    expect(codes({ ops: [edge("房价高抑制需求", { contested: true })] }, twoNodes())).toEqual(["warning:contested_unjustified"]);
    expect(codes({ ops: [edge("有人认为高价抑制需求，也有人认为反而刺激投资", { contested: true })] }, twoNodes())).toEqual([]);
    expect(codes({ ops: [edge("一些研究认为不平等推动对立；另一些研究认为身份因素才是主因", { contested: true })] }, twoNodes())).toEqual([]);
  });

  it("引用具体研究者或文献时要标注 AI 记忆，未核实", () => {
    expect(codes({ ops: [edge("Guess 等人的研究发现影响有限")] }, twoNodes())).toEqual(["warning:unverified_citation"]);
    expect(codes({ ops: [edge("见《思考，快与慢》")] }, twoNodes())).toEqual(["warning:unverified_citation"]);
    expect(codes({ ops: [edge("Guess 等人的研究发现影响有限（AI 记忆，未核实）")] }, twoNodes())).toEqual([]);
    expect(codes({ ops: [edge("一些研究发现影响有限")] }, twoNodes())).toEqual([]);
  });

  it("地区未指定时出现具体国家或地区制度；指定了地区则不报", () => {
    expect(codes({ ops: [edge("限购政策抑制需求")] }, twoNodes())).toEqual(["warning:region_assumed"]);
    expect(codes(answer("在美国，这种情况很常见。"), twoNodes())).toEqual(["warning:region_assumed"]);
    const g = twoNodes();
    g.frame.context = "中国一线城市";
    expect(codes({ ops: [edge("限购政策抑制需求")] }, g)).toEqual([]);
    // AI 写成"未指定地区""未指定（不默认任何国家）"也算未指定
    for (const c of ["未指定地区", "未指定（不默认任何国家）"]) {
      const u = twoNodes();
      u.frame.context = c;
      expect(codes({ ops: [edge("限购政策抑制需求")] }, u), c).toEqual(["warning:region_assumed"]);
    }
    // 本补丁里用 set_frame 写明了地区，也不报
    expect(codes({ ops: [{ op: "set_frame", context: "日本" }, edge("在日本，高价抑制需求")] }, twoNodes())).toEqual([]);
  });

  it("内部 ID 和界面细节", () => {
    expect(codes(answer("n1 很重要。"), twoNodes())).toEqual(["warning:internal_id"]);
    expect(codes(answer("争议边已标成橙色。"), twoNodes())).toEqual(["warning:ui_detail"]);
    expect(codes(answer("情绪化内容的点击率更高。"), twoNodes())).toEqual([]);
    expect(codes(answer("R1 和 B2 都值得看。"), twoNodes())).toEqual([]);
  });
});

describe("被拒绝的内容", () => {
  const g0 = twoNodes();
  const rejected = decided(
    g0,
    [
      { op: "add_node", ref: "$r", label: "贷款利率" },
      { op: "add_edge", from: "n1", to: "n2", polarity: "-", rationale: "" },
    ],
    { 0: { decision: "rejected", reason: "不重要" }, 1: { decision: "rejected" } },
  ).patch;

  it("拒绝清单", () => {
    expect(rejectedItems(g0, [rejected]).map((r) => r.text)).toEqual(["变量「贷款利率」", "关系「房价 →(−) 购房需求」"]);
  });

  it("重新提出被拒绝的变量或关系", () => {
    expect(codes({ ops: [{ op: "add_node", ref: "$x", label: " 贷款利率" }] }, g0, [rejected])).toEqual(["warning:reproposed_rejected"]);
    expect(codes({ ops: [{ op: "add_edge", from: "n1", to: "n2", polarity: "+", rationale: "" }] }, g0, [rejected])).toEqual(["warning:reproposed_rejected"]);
  });

  it("回答中提到被拒绝关系的两端却没有说明", () => {
    expect(codes(answer("因为房价会压低购房需求。"), g0, [rejected])).toEqual(["warning:rejected_used_in_answer"]);
    expect(codes(answer("你之前不同意房价会影响购房需求，所以这里不依赖它。"), g0, [rejected])).toEqual([]);
  });

  it("绕道：被拒绝的 A→B 经由新变量形成 A ⇝ B 的路径", () => {
    const ops: PatchOp[] = [
      { op: "add_node", ref: "$x", label: "投资需求" },
      { op: "add_edge", from: "n1", to: "$x", polarity: "+", rationale: "" },
      { op: "add_edge", from: "$x", to: "n2", polarity: "+", rationale: "" },
    ];
    expect(codes({ ops }, g0, [rejected])).toEqual(["warning:rejected_bypass"]);
    const after = applyOps(g0, ops.map((op, index) => ({ index, op })), "ai");
    expect(rejectedBypasses(g0, after, [rejected])).toEqual(["你之前不同意「房价 → 购房需求」；这个建议会形成路径 房价 → 投资需求 → 购房需求"]);
    // 没有经过新变量的路径不提示
    expect(codes({ ops: [{ op: "add_node", ref: "$x", label: "投资需求" }, { op: "add_edge", from: "$x", to: "n2", polarity: "+", rationale: "" }] }, g0, [rejected])).toEqual([]);
  });
});

describe("sanitizeDisplayText（内部 ID 安全网）", () => {
  const g = makeGraph(["房价", "购房需求"], ["n2->n1 +"]);
  it("替换节点、边和临时引用", () => {
    expect(sanitizeDisplayText("n2 推高 n1。", g)).toBe("「购房需求」推高「房价」。");
    expect(sanitizeDisplayText("图里的 n1「房价」还缺输入", g)).toBe("图里的「房价」还缺输入");
    expect(sanitizeDisplayText("e1 可能有延迟", g)).toBe("「购房需求 → 房价」这条关系可能有延迟");
    expect(sanitizeDisplayText("$rate 会影响需求", g, [{ op: "add_node", ref: "$rate", label: "贷款利率" }])).toBe("「贷款利率」会影响需求");
  });
  it("不认识的 ID 和普通文字保持原样", () => {
    expect(sanitizeDisplayText("n9 和 R1、iPhone15、e9 不变", g)).toBe("n9 和 R1、iPhone15、这条关系不变");
  });
  it("sanitizeAiOutput 只改显示文字，不改结构字段", () => {
    const o = sanitizeAiOutput(out({ message: "把 n1 接上。", ops: [{ op: "add_edge", from: "n1", to: "n2", polarity: "-", rationale: "n1 高了 n2 就少" }] }), g);
    expect(o.message).toBe("把「房价」接上。");
    expect(o.ops[0]).toMatchObject({ from: "n1", to: "n2", rationale: "「房价」高了「购房需求」就少" });
  });
});

describe("buildTurnPrompt", () => {
  it("种子轮：空图、提示可以澄清、地区未指定的提醒", () => {
    const g = empty();
    expect(isSeedTurn(g)).toBe(true);
    const prompt = buildTurnPrompt({ graph: g, patches: [], turns: [{ turn_id: "t001", role: "user", text: "房价", created_at: NOW }] });
    expect(prompt).toContain("（空）");
    expect(prompt).toContain("clarify");
    expect(prompt).toContain("地区/语境：未指定（不要默认任何国家");
    expect(prompt).toContain("用户的新消息：房价");
  });

  it("包含图、代码检测的闭环、拒绝清单、上一轮处理结果、最近对话和重试原因", () => {
    const g0 = makeGraph(["房价", "购房需求"], ["n2->n1 +", "n1->n2 -"]);
    const { patch, version } = decided(
      g0,
      [
        { op: "add_node", ref: "$r", label: "贷款利率" },
        { op: "add_node", ref: "$s", label: "人口" },
      ],
      { 0: { decision: "accepted" }, 1: { decision: "rejected", reason: "先不考虑" } },
    );
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
    expect(prompt).not.toContain("用户：为什么需求会推高房价");
    expect(prompt).toContain("- 问题太多");
  });
});
