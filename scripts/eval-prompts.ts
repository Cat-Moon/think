// 提示词回归 + 检查点：对每个主题跑若干次模拟多轮对话，统计耗时和违规，生成可读的报告。
// 用法：npx tsx scripts/eval-prompts.ts [--runs 3] [--concurrency 3] [--model sonnet] [--topics vague,clear]
// 输出：runs/<时间>/report.md、stats.json、workspace/（每次会话一个 Map 文件夹，含完整日志）
// 注意：会真实调用 Claude，消耗订阅额度。runs/ 不进 git。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { renderGraph, renderOps } from "../src/core/describe";
import type { Choices } from "../src/core/patch";
import type { Graph, Patch } from "../src/core/schema";
import type { ViolationCode } from "../src/core/ai-check";
import { ClaudeCodeProvider } from "../src/server/ai/claude-provider";
import { loadSystemPrompt } from "../src/server/ai/system-prompt";
import { takeTurn, type TurnResult } from "../src/server/ai/turn";
import { commitPatch, readGraph, readPatch } from "../src/server/storage/map-store";
import { createMap } from "../src/server/storage/workspace";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    concurrency: { type: "string", default: "3" },
    model: { type: "string", default: "sonnet" },
    topics: { type: "string" },
  },
});

interface Topic {
  id: string;
  kind: string;
  text: string;
  /** AI 先澄清时用户的回答 */
  clarifyAnswer?: string;
}

const TOPICS: Topic[] = [
  { id: "vague", kind: "模糊", text: "房价", clarifyAnswer: "我想弄明白为什么过去二十年大城市的房价一直在涨，从普通购房者的角度，时间范围大约 20 年。" },
  { id: "clear", kind: "现象清楚", text: "为什么大城市的房价这些年一直在涨" },
  { id: "contested", kind: "有争议", text: "为什么选举中的政治两极分化越来越严重", clarifyAnswer: "我想理解过去二三十年里，选民之间的对立为什么越来越强，从普通选民的角度看。" },
  { id: "procrastination", kind: "个人", text: "为什么我总是拖延" },
  { id: "traffic", kind: "反直觉", text: "城市交通为什么越修路越堵" },
  { id: "social", kind: "较宽", text: "社交媒体与注意力", clarifyAnswer: "我想理解为什么用了社交媒体之后，我越来越难长时间专注，从个人用户的角度，看几年。" },
];
const GENERIC_CLARIFY = "就按你的理解来，从普通人的角度，时间范围大约 10 年。";

const SCRIPT = {
  round2: "我拒绝了其中一条关系。你的问题我还没想好，请先按你的思路补充一个你认为最重要的遗漏。",
  round3: (from: string, to: string) => `为什么你认为「${from}」会影响「${to}」？`,
  round4: "明白了。按你的看法，现在图里最值得补充的是什么？",
};

const runs = Number(args.runs);
const concurrency = Number(args.concurrency);
const model = args.model!;
const topics = args.topics ? TOPICS.filter((t) => args.topics!.split(",").includes(t.id)) : TOPICS;
const system = loadSystemPrompt();
const provider = new ClaudeCodeProvider();

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join("runs", stamp);
const ws = join(outDir, "workspace");
mkdirSync(ws, { recursive: true });

// ---------- 一次会话 ----------

interface Round {
  label: string;
  userText: string;
  result: TurnResult;
  graphBefore: Graph;
  resolved?: Patch;
  graphAfter?: Graph;
}

interface Session {
  topic: Topic;
  run: number;
  folder: string;
  rounds: Round[];
  error?: string;
  totalMs: number;
}

async function runSession(topic: Topic, run: number): Promise<Session> {
  const t0 = Date.now();
  // 每次会话一个独立的工作区：主题名保持原样，并发时也不会争用文件夹名
  const sessionWs = join(ws, `${topic.id}-${run}`);
  const map = await createMap(sessionWs, topic.text, new Date().toISOString());
  const s: Session = { topic, run, folder: `${topic.id}-${run}/maps/${map.name}`, rounds: [], totalMs: 0 };

  const send = async (label: string, userText: string, decide: (p: Patch) => Choices) => {
    const graphBefore = await readGraph(map.dir);
    const result = await takeTurn(map.dir, provider, { userText, model, systemPrompt: system, timeoutMs: 300_000 });
    const round: Round = { label, userText, result, graphBefore };
    s.rounds.push(round);
    if (result.ok && result.patch) {
      await commitPatch(map.dir, result.patch.patch_id, decide(result.patch), new Date().toISOString());
      round.resolved = await readPatch(map.dir, result.patch.patch_id);
      round.graphAfter = await readGraph(map.dir);
    }
    return result;
  };
  const acceptAll = (): Choices => "all";
  const rejectAt = (p: Patch, index: number, reason: string): Choices =>
    Object.fromEntries(p.ops.map((_, i) => [i, i === index ? { decision: "rejected" as const, reason } : { decision: "accepted" as const }]));
  const lastIndex = (p: Patch, op: string) => p.ops.map((o) => o.op).lastIndexOf(op as never);
  const firstIndex = (p: Patch, op: string) => p.ops.findIndex((o) => o.op === op);

  try {
    // 第 1 轮：主题（模糊时先澄清，最多两次）
    let r = await send("主题", topic.text, (p) => rejectAt(p, lastIndex(p, "add_edge"), "我不认为这条关系成立"));
    for (let i = 0; r.ok && r.output.kind === "clarify" && i < 2; i++) {
      r = await send("回答澄清", topic.clarifyAnswer ?? GENERIC_CLARIFY, (p) => rejectAt(p, lastIndex(p, "add_edge"), "我不认为这条关系成立"));
    }
    // 第 2 轮：请 AI 补充；拒绝它新增的第一个变量（依赖它的关系自动拒绝），没有新变量就拒绝最后一条关系
    await send("请求补充", SCRIPT.round2, (p) => {
      const n = firstIndex(p, "add_node");
      return n >= 0 ? rejectAt(p, n, "我觉得这个因素不重要") : rejectAt(p, lastIndex(p, "add_edge"), "我不认为这条关系成立");
    });
    // 第 3 轮：追问"为什么"（选 AI 提出、已被接受的最后一条关系）
    const g = await readGraph(map.dir);
    const e = [...g.edges].reverse().find((x) => x.status === "accepted" && x.origin === "ai");
    const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
    if (e) await send("追问为什么", SCRIPT.round3(label(e.from), label(e.to)), acceptAll);
    // 第 4 轮：再请补充，看是否重新提出被拒绝的内容
    await send("再请补充", SCRIPT.round4, acceptAll);
  } catch (err) {
    s.error = (err as Error).message;
  }
  s.totalMs = Date.now() - t0;
  return s;
}

// ---------- 统计 ----------

const CODE_NAMES: Record<ViolationCode, string> = {
  loop_language: "回路判断",
  too_many_new: "新增超过3个",
  seed_size: "种子图规模",
  seed_loops: "种子图闭环>1",
  multiple_questions: "不止一个问题",
  missing_question: "缺少问题",
  directional_label: "变量名带方向",
  contested_unjustified: "乱标争议",
  reproposed_rejected: "重提被拒内容",
  invalid_ops: "补丁无法应用",
  kind_mismatch: "类型不匹配",
};
const REPORT_CODES: ViolationCode[] = [
  "loop_language",
  "too_many_new",
  "seed_size",
  "seed_loops",
  "multiple_questions",
  "directional_label",
  "contested_unjustified",
  "reproposed_rejected",
  "invalid_ops",
];

function stats(s: Session) {
  const attempts = s.rounds.flatMap((r) => r.result.attempts);
  const counts = Object.fromEntries(REPORT_CODES.map((c) => [c, 0])) as Record<ViolationCode, number>;
  for (const a of attempts) for (const v of a.violations) if (v.code in counts) counts[v.code]++;
  const contested = s.rounds.flatMap((r) => (r.result.ok ? r.result.output.ops : [])).filter((o) => (o.op === "add_edge" || o.op === "update_edge") && o.contested).length;
  const callMs = attempts.map((a) => a.durationMs);
  const tokens = attempts.reduce((n, a) => n + a.usage.inputTokens + a.usage.cacheReadTokens + a.usage.cacheCreationTokens, 0);
  const outTokens = attempts.reduce((n, a) => n + a.usage.outputTokens, 0);
  return {
    clarified: s.rounds[0]?.result.ok && s.rounds[0].result.output.kind === "clarify",
    calls: attempts.length,
    retries: s.rounds.filter((r) => r.result.attempts.length > 1).length,
    failures: s.rounds.filter((r) => !r.result.ok).length,
    totalMs: s.totalMs,
    avgCallMs: callMs.length ? callMs.reduce((a, b) => a + b, 0) / callMs.length : 0,
    maxCallMs: Math.max(0, ...callMs),
    tokens,
    outTokens,
    contested,
    counts,
  };
}

// ---------- 报告 ----------

const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function renderRound(r: Round, n: number): string {
  const out: string[] = [`#### 第 ${n} 步 · ${r.label}`, "", `**用户：** ${r.userText}`, ""];
  const res = r.result;
  const tries = res.attempts.map((a) => `${sec(a.durationMs)}${a.violations.length ? `（${a.violations.map((v) => CODE_NAMES[v.code]).join("、")}）` : ""}`);
  out.push(`调用 ${res.attempts.length} 次：${tries.join(" → ")}`, "");
  if (!res.ok) {
    out.push(`**失败：** ${res.error.message}`);
    for (const v of res.violations ?? []) out.push(`- ${v.severity === "error" ? "✘" : "⚠"} ${v.message}`);
    if (res.output) out.push("", "最后一次输出：", "```", JSON.stringify(res.output, null, 2), "```");
    return out.join("\n");
  }
  const o = res.output;
  const kindName = { clarify: "澄清", patch: "补丁", answer: "回答" }[o.kind];
  out.push(`**AI（${kindName}）：** ${o.message}`, "");
  if (o.question) out.push(`**问题：** ${o.question}`, "");
  if (o.ops.length) {
    out.push("建议（✔ 接受 / ✘ 拒绝）：", "```", renderOps(o.ops, r.graphBefore, r.resolved?.resolution?.decisions), "```");
  }
  if (o.possible_duplicates.length) out.push(`可能重复：${o.possible_duplicates.map((d) => `${d.a} / ${d.b}（${d.reason}）`).join("；")}`, "");
  for (const v of res.warnings) out.push(`- ⚠ ${CODE_NAMES[v.code]}：${v.message}`);
  if (r.graphAfter) out.push("", "处理后的图：", "```", renderGraph(r.graphAfter), "```");
  return out.join("\n");
}

function report(sessions: Session[]): string {
  const lines: string[] = [];
  lines.push(`# Think 提示词回归报告`, "");
  lines.push(`- 时间：${new Date().toLocaleString("zh-CN")}`);
  lines.push(`- 模型：${model}；每个主题 ${runs} 次；系统提示词版本：${system.sha}（prompts/system.md）`);
  lines.push(`- 每次会话的步骤：主题（必要时回答澄清；种子图拒绝最后一条关系）→ 请求补充（拒绝新增的第一个变量）→ 追问为什么 → 再请补充`);
  lines.push(`- 违规统计包括所有调用（含被重试修正的那一次）；"重试"是需要第二次调用的轮数；"失败"是重试后仍不合格或调用出错的轮数`, "");

  lines.push(`## 汇总`, "");
  lines.push(`| 主题 | 次 | 先澄清 | 调用 | 重试 | 失败 | 总耗时 | 平均/最长单次 | 争议边 | ${REPORT_CODES.map((c) => CODE_NAMES[c]).join(" | ")} |`);
  lines.push(`|${"---|".repeat(9 + REPORT_CODES.length)}`);
  for (const s of sessions) {
    const st = stats(s);
    lines.push(
      `| ${s.topic.kind}：${s.topic.text} | ${s.run} | ${st.clarified ? "是" : "否"} | ${st.calls} | ${st.retries} | ${st.failures}${s.error ? "⚠" : ""} | ${sec(st.totalMs)} | ${sec(st.avgCallMs)} / ${sec(st.maxCallMs)} | ${st.contested} | ${REPORT_CODES.map((c) => st.counts[c] || "·").join(" | ")} |`,
    );
  }
  const all = sessions.map(stats);
  const total = (f: (x: ReturnType<typeof stats>) => number) => all.reduce((n, x) => n + f(x), 0);
  lines.push(
    "",
    `合计：${total((x) => x.calls)} 次调用，${total((x) => x.retries)} 轮重试，${total((x) => x.failures)} 轮失败；输入约 ${Math.round(total((x) => x.tokens) / 1000)}k tokens，输出约 ${Math.round(total((x) => x.outTokens) / 1000)}k tokens。`,
  );
  lines.push(`违规合计：${REPORT_CODES.map((c) => `${CODE_NAMES[c]} ${total((x) => x.counts[c])}`).join("，")}。`, "");

  lines.push(`## 每个主题的耗时波动`, "", `| 主题 | 会话总耗时 最短 / 平均 / 最长 | 单次调用平均 |`, `|---|---|---|`);
  for (const t of topics) {
    const xs = sessions.filter((s) => s.topic.id === t.id).map(stats);
    if (!xs.length) continue;
    const tot = xs.map((x) => x.totalMs);
    lines.push(`| ${t.text} | ${sec(Math.min(...tot))} / ${sec(tot.reduce((a, b) => a + b, 0) / tot.length)} / ${sec(Math.max(...tot))} | ${sec(xs.reduce((a, x) => a + x.avgCallMs, 0) / xs.length)} |`);
  }
  lines.push("");

  lines.push(`## 每次会话的完整过程`, "");
  for (const s of sessions) {
    lines.push(`### ${s.topic.kind}：「${s.topic.text}」第 ${s.run} 次`, "", `文件夹：workspace/${s.folder}`, "");
    if (s.error) lines.push(`**会话中断：** ${s.error}`, "");
    s.rounds.forEach((r, i) => lines.push(renderRound(r, i + 1), ""));
  }
  return lines.join("\n");
}

// ---------- 运行 ----------

const jobs = topics.flatMap((t) => Array.from({ length: runs }, (_, i) => ({ topic: t, run: i + 1 })));
console.log(`${(await provider.healthCheck()).message}`);
console.log(`共 ${jobs.length} 次会话，并发 ${concurrency}，模型 ${model}，输出到 ${outDir}`);

const sessions: Session[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const s = await runSession(job.topic, job.run);
      sessions.push(s);
      const st = stats(s);
      console.log(`[${sessions.length}/${jobs.length}] ${job.topic.id}#${job.run}：${sec(st.totalMs)}，${st.calls} 次调用，失败 ${st.failures}${s.error ? `，中断：${s.error}` : ""}`);
    }
  }),
);

const order = (s: Session) => topics.indexOf(s.topic) * 100 + s.run;
sessions.sort((a, b) => order(a) - order(b));
writeFileSync(join(outDir, "report.md"), report(sessions));
writeFileSync(join(outDir, "stats.json"), JSON.stringify(sessions.map((s) => ({ topic: s.topic.id, run: s.run, error: s.error, ...stats(s) })), null, 2));
console.log(`报告：${join(outDir, "report.md")}`);
