// 提示词回归 + 检查点：对每个主题跑若干次模拟多轮对话，统计耗时、token 和违规，生成可读的报告。
// 用法：npx tsx scripts/eval-prompts.ts [--runs 3] [--concurrency 3] [--model sonnet] [--effort low]
//        [--topics vague,clear] [--answer-model haiku|none] [--compare runs/<上次>/stats.json]
//        [--include runs/<另一次>/stats.json:vague,clear]（并入另一次运行中已完成主题的统计）
// 输出：runs/<时间>/report.md、stats.json、workspace/（每次会话一个工作区，含完整日志）
// 注意：会真实调用 Claude，消耗订阅额度。runs/ 不进 git。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkAiOutput, sanitizeAiOutput, type Violation, type ViolationCode } from "../src/core/ai-check";
import { renderGraph, renderOps } from "../src/core/describe";
import type { Choices } from "../src/core/patch";
import { AiOutput, aiOutputJsonSchema, type Graph, type Patch } from "../src/core/schema";
import { ClaudeCodeProvider } from "../src/server/ai/claude-provider";
import { loadSystemPrompt } from "../src/server/ai/system-prompt";
import { takeTurn, type TurnResult } from "../src/server/ai/turn";
import { commitPatch, listPatchIds, paths, readGraph, readPatch } from "../src/server/storage/map-store";
import { createMap } from "../src/server/storage/workspace";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    concurrency: { type: "string", default: "3" },
    model: { type: "string", default: "sonnet" },
    effort: { type: "string" },
    topics: { type: "string" },
    "answer-model": { type: "string", default: "haiku" },
    compare: { type: "string" },
    /** 并入另一次运行中已完成主题的统计（格式：路径/stats.json:主题1,主题2），用于额度中断后补跑 */
    include: { type: "string" },
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
  { id: "region", kind: "指定地区", text: "为什么日本的出生率持续下降" },
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
const effort = args.effort;
const answerModel = args["answer-model"] === "none" ? null : args["answer-model"]!;
const topics = args.topics ? TOPICS.filter((t) => args.topics!.split(",").includes(t.id)) : TOPICS;
const system = loadSystemPrompt();
const provider = new ClaudeCodeProvider();

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join("runs", stamp);
const ws = join(outDir, "workspace");
mkdirSync(ws, { recursive: true });

// ---------- 一次会话 ----------

interface Shadow {
  model: string;
  durationMs: number;
  outTokens: number;
  output?: AiOutput;
  violations: Violation[];
  error?: string;
}

interface Round {
  label: string;
  userText: string;
  result: TurnResult;
  graphBefore: Graph;
  resolved?: Patch;
  graphAfter?: Graph;
  /** 同一上下文用更快的模型再答一次（只用于比较，不保存） */
  shadow?: Shadow;
}

interface Session {
  topic: Topic;
  run: number;
  folder: string;
  rounds: Round[];
  error?: string;
  totalMs: number;
}

/** 读出某个 Map 最近一次调用用的上下文，在同一上下文上用另一个模型再答一次 */
async function shadowAnswer(dir: string, graph: Graph, shadowModel: string): Promise<Shadow> {
  const log = readFileSync(paths(dir).providerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { prompt: string });
  const prompt = log.at(-1)!.prompt;
  const patches = await Promise.all((await listPatchIds(dir)).map((id) => readPatch(dir, id)));
  const res = await provider.complete({ systemPrompt: system.text, prompt, jsonSchema: aiOutputJsonSchema(), model: shadowModel, timeoutMs: 300_000 });
  if (!res.ok) return { model: shadowModel, durationMs: res.durationMs, outTokens: 0, violations: [], error: res.error.message };
  const z = AiOutput.safeParse(res.output);
  if (!z.success) return { model: shadowModel, durationMs: res.durationMs, outTokens: res.usage.outputTokens, violations: [], error: "输出格式不对" };
  return {
    model: shadowModel,
    durationMs: res.durationMs,
    outTokens: res.usage.outputTokens,
    output: sanitizeAiOutput(z.data, graph),
    violations: checkAiOutput(z.data, graph, patches),
  };
}

async function runSession(topic: Topic, run: number): Promise<Session> {
  const t0 = Date.now();
  // 每次会话一个独立的工作区：主题名保持原样，并发时也不会争用文件夹名
  const sessionWs = join(ws, `${topic.id}-${run}`);
  const map = await createMap(sessionWs, topic.text, new Date().toISOString());
  const s: Session = { topic, run, folder: `${topic.id}-${run}/maps/${map.name}`, rounds: [], totalMs: 0 };

  const send = async (label: string, userText: string, decide: (p: Patch) => Choices) => {
    const graphBefore = await readGraph(map.dir);
    const result = await takeTurn(map.dir, provider, { userText, model, effort, systemPrompt: system, timeoutMs: 300_000 });
    const round: Round = { label, userText, result, graphBefore };
    s.rounds.push(round);
    if (result.ok && result.patch) {
      await commitPatch(map.dir, result.patch.patch_id, decide(result.patch), new Date().toISOString());
      round.resolved = await readPatch(map.dir, result.patch.patch_id);
      round.graphAfter = await readGraph(map.dir);
    }
    return round;
  };
  const acceptAll = (): Choices => "all";
  const rejectAt = (p: Patch, index: number, reason: string): Choices =>
    Object.fromEntries(p.ops.map((_, i) => [i, i === index ? { decision: "rejected" as const, reason } : { decision: "accepted" as const }]));
  const lastIndex = (p: Patch, op: string) => p.ops.map((o) => o.op).lastIndexOf(op as never);
  const firstIndex = (p: Patch, op: string) => p.ops.findIndex((o) => o.op === op);
  const rejectLastEdge = (p: Patch) => rejectAt(p, lastIndex(p, "add_edge"), "我不认为这条关系成立");

  try {
    // 第 1 轮：主题（模糊时先澄清，最多两次）；种子图拒绝最后一条关系
    let r = (await send("主题", topic.text, rejectLastEdge)).result;
    for (let i = 0; r.ok && r.output.kind === "clarify" && i < 2; i++) {
      r = (await send("回答澄清", topic.clarifyAnswer ?? GENERIC_CLARIFY, rejectLastEdge)).result;
    }
    // 第 2 轮：请 AI 补充；拒绝它新增的第一个变量（依赖它的关系自动拒绝），没有新变量就拒绝最后一条关系
    await send("请求补充", SCRIPT.round2, (p) => {
      const n = firstIndex(p, "add_node");
      return n >= 0 ? rejectAt(p, n, "我觉得这个因素不重要") : rejectLastEdge(p);
    });
    // 第 3 轮：追问"为什么"（选 AI 提出、已被接受的最后一条关系）；同一上下文用更快的模型再答一次
    const g = await readGraph(map.dir);
    const e = [...g.edges].reverse().find((x) => x.status === "accepted" && x.origin === "ai");
    const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
    if (e) {
      const round = await send("追问为什么", SCRIPT.round3(label(e.from), label(e.to)), acceptAll);
      if (answerModel && round.result.ok) round.shadow = await shadowAnswer(map.dir, round.graphBefore, answerModel);
    }
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
  invalid_ops: "补丁无法应用",
  kind_mismatch: "类型不匹配",
  too_many_new: "新增超限",
  multiple_questions: "问题字段多问",
  question_in_message: "说明里夹带问题",
  missing_question: "缺少问题",
  seed_size: "种子图偏小",
  seed_loops: "种子图闭环>1",
  loop_language: "回路说法",
  directional_label: "变量名带方向",
  contested_unjustified: "乱标争议",
  long_rationale: "理由过长",
  unverified_citation: "未标注的引用",
  region_assumed: "默认地区",
  internal_id: "内部ID",
  ui_detail: "界面细节",
  reproposed_rejected: "重提被拒",
  rejected_used_in_answer: "回答用被拒关系",
  rejected_bypass: "绕道重提",
};
const ALL_CODES = Object.keys(CODE_NAMES) as ViolationCode[];

function stats(s: Session) {
  const attempts = s.rounds.flatMap((r) => r.result.attempts);
  const counts = Object.fromEntries(ALL_CODES.map((c) => [c, 0])) as Record<ViolationCode, number>;
  for (const a of attempts) for (const v of a.violations) counts[v.code]++;
  const contested = s.rounds.flatMap((r) => (r.result.ok ? r.result.output.ops : [])).filter((o) => (o.op === "add_edge" || o.op === "update_edge") && o.contested).length;
  const callMs = attempts.map((a) => a.durationMs);
  const tokens = attempts.reduce((n, a) => n + a.usage.inputTokens + a.usage.cacheReadTokens + a.usage.cacheCreationTokens, 0);
  const outTokens = attempts.reduce((n, a) => n + a.usage.outputTokens, 0);
  return {
    clarified: Boolean(s.rounds[0]?.result.ok && s.rounds[0].result.output.kind === "clarify"),
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
type Stats = ReturnType<typeof stats> & { topic?: string };

// ---------- 报告 ----------

const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const kindName = (k: string) => ({ clarify: "澄清", patch: "补丁", answer: "回答" })[k] ?? k;

function renderRound(r: Round, n: number): string {
  const out: string[] = [`#### 第 ${n} 步 · ${r.label}`, "", `**用户：** ${r.userText}`, ""];
  const res = r.result;
  const tries = res.attempts.map((a) => `${sec(a.durationMs)}，输出 ${a.usage.outputTokens} tokens${a.violations.length ? `（${a.violations.map((v) => CODE_NAMES[v.code]).join("、")}）` : ""}`);
  out.push(`调用 ${res.attempts.length} 次：${tries.join(" → ")}`, "");
  if (!res.ok) {
    out.push(`**失败：** ${res.error.message}`);
    for (const v of res.violations ?? []) out.push(`- ${v.severity === "error" ? "✘" : "⚠"} ${v.message}`);
    if (res.output) out.push("", "最后一次输出：", "```", JSON.stringify(res.output, null, 2), "```");
    return out.join("\n");
  }
  const o = res.output;
  out.push(`**AI（${kindName(o.kind)}）：** ${o.message}`, "");
  if (o.question) out.push(`**问题：** ${o.question}`, "");
  if (o.ops.length) out.push("建议（✔ 接受 / ✘ 拒绝）：", "```", renderOps(o.ops, r.graphBefore, r.resolved?.resolution?.decisions), "```");
  if (o.possible_duplicates.length) out.push(`可能重复：${o.possible_duplicates.map((d) => `${d.a} / ${d.b}（${d.reason}）`).join("；")}`, "");
  for (const v of res.warnings) out.push(`- ⚠ ${CODE_NAMES[v.code]}：${v.message}`);
  if (r.shadow) {
    const sh = r.shadow;
    out.push("", `> **对照：${sh.model} 在同一上下文的回答**（${sec(sh.durationMs)}，输出 ${sh.outTokens} tokens${sh.violations.length ? `；${sh.violations.map((v) => CODE_NAMES[v.code]).join("、")}` : ""}）`);
    if (sh.error) out.push(`> 失败：${sh.error}`);
    if (sh.output) {
      out.push(`> （${kindName(sh.output.kind)}）${sh.output.message}`);
      if (sh.output.question) out.push(`> 问题：${sh.output.question}`);
      if (sh.output.ops.length) out.push(`> （附带了 ${sh.output.ops.length} 项修改）`);
    }
  }
  if (r.graphAfter) out.push("", "处理后的图：", "```", renderGraph(r.graphAfter), "```");
  return out.join("\n");
}

function comparison(now: Stats[], before: Stats[]): string[] {
  const sum = (xs: Stats[], f: (x: Stats) => number) => xs.reduce((n, x) => n + f(x), 0);
  const per = (xs: Stats[], f: (x: Stats) => number) => (xs.length ? sum(xs, f) / xs.length : 0);
  const calls = (xs: Stats[]) => sum(xs, (x) => x.calls) || 1;
  const row = (name: string, a: string, b: string) => `| ${name} | ${a} | ${b} |`;
  const lines = [
    `## 与上一次对比`,
    "",
    `上一次：${before.length} 次会话；这一次：${now.length} 次会话。次数会受会话数影响，所以同时给出"每次会话平均"。`,
    `注意：上一次的"回路说法"用的是旧词表（单独的"增强""反馈"也算），"不止一个问题"包含了说明里的问号；下表把这一次的"问题字段多问 + 说明里夹带问题"合在一起对比。`,
    "",
    `| 指标 | 上一次 | 这一次 |`,
    `|---|---|---|`,
    row("会话数 / 调用次数", `${before.length} / ${sum(before, (x) => x.calls)}`, `${now.length} / ${sum(now, (x) => x.calls)}`),
    row("重试轮数（每次会话平均）", `${sum(before, (x) => x.retries)}（${per(before, (x) => x.retries).toFixed(2)}）`, `${sum(now, (x) => x.retries)}（${per(now, (x) => x.retries).toFixed(2)}）`),
    row("失败轮数（每次会话平均）", `${sum(before, (x) => x.failures)}（${per(before, (x) => x.failures).toFixed(2)}）`, `${sum(now, (x) => x.failures)}（${per(now, (x) => x.failures).toFixed(2)}）`),
    row("会话平均耗时", sec(per(before, (x) => x.totalMs)), sec(per(now, (x) => x.totalMs))),
    row("单次调用平均耗时", sec(sum(before, (x) => x.avgCallMs * x.calls) / calls(before)), sec(sum(now, (x) => x.avgCallMs * x.calls) / calls(now))),
    row("输出 tokens 合计（每次调用平均）", `${sum(before, (x) => x.outTokens)}（${Math.round(sum(before, (x) => x.outTokens) / calls(before))}）`, `${sum(now, (x) => x.outTokens)}（${Math.round(sum(now, (x) => x.outTokens) / calls(now))}）`),
    row("争议边（每次会话平均）", per(before, (x) => x.contested).toFixed(2), per(now, (x) => x.contested).toFixed(2)),
  ];
  const c = (xs: Stats[], code: string) => sum(xs, (x) => (x.counts as Record<string, number>)[code] ?? 0);
  lines.push(row("问题数违规（问题字段 + 说明里）", String(c(before, "multiple_questions")), String(c(now, "multiple_questions") + c(now, "question_in_message"))));
  for (const code of ALL_CODES) {
    if (code === "multiple_questions" || code === "question_in_message") continue;
    const had = before.some((x) => code in x.counts);
    lines.push(row(CODE_NAMES[code], had ? String(c(before, code)) : "—（未统计）", String(c(now, code))));
  }
  lines.push("", `| 主题 | 会话平均耗时 上一次 → 这一次 | 每次调用输出 tokens 上一次 → 这一次 |`, `|---|---|---|`);
  for (const t of TOPICS) {
    const a = before.filter((x) => x.topic === t.id);
    const b = now.filter((x) => x.topic === t.id);
    if (!b.length) continue;
    lines.push(
      `| ${t.text} | ${a.length ? sec(per(a, (x) => x.totalMs)) : "—"} → ${sec(per(b, (x) => x.totalMs))} | ${a.length ? Math.round(sum(a, (x) => x.outTokens) / calls(a)) : "—"} → ${Math.round(sum(b, (x) => x.outTokens) / calls(b))} |`,
    );
  }
  return lines;
}

function report(sessions: Session[], before: Stats[] | null, included: Stats[] = []): string {
  const own: Stats[] = sessions.map((s) => ({ topic: s.topic.id, ...stats(s) }));
  const all: Stats[] = [...included, ...own];
  const total = (f: (x: Stats) => number) => all.reduce((n, x) => n + f(x), 0);
  const shadows = sessions.flatMap((s) => s.rounds.flatMap((r) => (r.shadow ? [{ r, sh: r.shadow }] : [])));
  const lines: string[] = [];
  lines.push(`# Think 提示词回归报告`, "");
  lines.push(`- 时间：${new Date().toLocaleString("zh-CN")}`);
  lines.push(`- 模型：${model}${effort ? `（effort=${effort}）` : ""}；每个主题 ${runs} 次；系统提示词版本：${system.sha}（prompts/system.md）`);
  lines.push(`- 每次会话的步骤：主题（必要时回答澄清；种子图拒绝最后一条关系）→ 请求补充（拒绝新增的第一个变量）→ 追问为什么${answerModel ? `（同一上下文另用 ${answerModel} 回答作对照）` : ""} → 再请补充`);
  lines.push(`- 违规统计包括所有调用（含被重试修正的那一次）；"重试"是需要第二次调用的轮数；"失败"是重试后仍不合格或调用出错的轮数`);
  if (included.length) lines.push(`- 并入了另一次运行中已完成主题的统计：${[...new Set(included.map((x) => x.topic))].join("、")}（${args.include}）`);
  lines.push(`- 只有硬性违规（补丁无法应用、类型不匹配、新增超限、问题字段多问）会触发重试；其余只记录`, "");

  const shown = ALL_CODES.filter((c) => total((x) => x.counts[c]) > 0);
  lines.push(`## 汇总`, "");
  lines.push(`| 主题 | 次 | 先澄清 | 调用 | 重试 | 失败 | 总耗时 | 平均/最长单次 | 输出 tokens | 争议边 |${shown.map((c) => ` ${CODE_NAMES[c]} |`).join("")}`);
  lines.push(`|${"---|".repeat(10 + shown.length)}`);
  for (const st of included) {
    const t = TOPICS.find((x) => x.id === st.topic)!;
    lines.push(
      `| ${t.kind}：${t.text}（并入）| ${(st as { run?: number }).run ?? ""} | ${st.clarified ? "是" : "否"} | ${st.calls} | ${st.retries} | ${st.failures} | ${sec(st.totalMs)} | ${sec(st.avgCallMs)} / ${sec(st.maxCallMs)} | ${st.outTokens} | ${st.contested} |${shown.map((c) => ` ${st.counts[c] || "·"} |`).join("")}`,
    );
  }
  sessions.forEach((s, i) => {
    const st = own[i]!;
    lines.push(
      `| ${s.topic.kind}：${s.topic.text} | ${s.run} | ${st.clarified ? "是" : "否"} | ${st.calls} | ${st.retries} | ${st.failures}${s.error ? "⚠" : ""} | ${sec(st.totalMs)} | ${sec(st.avgCallMs)} / ${sec(st.maxCallMs)} | ${st.outTokens} | ${st.contested} |${shown.map((c) => ` ${st.counts[c] || "·"} |`).join("")}`,
    );
  });
  lines.push(
    "",
    `合计：${total((x) => x.calls)} 次调用，${total((x) => x.retries)} 轮重试，${total((x) => x.failures)} 轮失败；输入约 ${Math.round(total((x) => x.tokens) / 1000)}k tokens，输出 ${total((x) => x.outTokens)} tokens（每次调用平均 ${Math.round(total((x) => x.outTokens) / (total((x) => x.calls) || 1))}）。`,
  );
  lines.push(`违规合计：${ALL_CODES.map((c) => `${CODE_NAMES[c]} ${total((x) => x.counts[c])}`).join("，")}。`, "");

  lines.push(`## 每个主题的耗时与输出量`, "", `| 主题 | 会话总耗时 最短 / 平均 / 最长 | 单次调用平均 | 每次调用输出 tokens |`, `|---|---|---|---|`);
  for (const t of TOPICS) {
    const xs = all.filter((x) => x.topic === t.id);
    if (!xs.length) continue;
    const tot = xs.map((x) => x.totalMs);
    const calls = xs.reduce((n, x) => n + x.calls, 0) || 1;
    lines.push(`| ${t.text} | ${sec(Math.min(...tot))} / ${sec(avg(tot))} / ${sec(Math.max(...tot))} | ${sec(avg(xs.map((x) => x.avgCallMs)))} | ${Math.round(xs.reduce((n, x) => n + x.outTokens, 0) / calls)} |`);
  }
  lines.push("");

  if (shadows.length) {
    const main = shadows.map(({ r }) => r.result.attempts.at(-1)!);
    lines.push(`## "为什么"轮次：${model} 与 ${answerModel} 对照`, "");
    lines.push(`| | ${model} | ${answerModel} |`, `|---|---|---|`);
    lines.push(`| 平均耗时 | ${sec(avg(main.map((a) => a.durationMs)))} | ${sec(avg(shadows.map((x) => x.sh.durationMs)))} |`);
    lines.push(`| 平均输出 tokens | ${Math.round(avg(main.map((a) => a.usage.outputTokens)))} | ${Math.round(avg(shadows.map((x) => x.sh.outTokens)))} |`);
    lines.push(`| 回复类型为"回答" | ${shadows.filter(({ r }) => r.result.ok && r.result.output.kind === "answer").length}/${shadows.length} | ${shadows.filter((x) => x.sh.output?.kind === "answer").length}/${shadows.length} |`);
    lines.push(`| 违规次数 | ${main.reduce((n, a) => n + a.violations.length, 0)} | ${shadows.reduce((n, x) => n + x.sh.violations.length, 0)} |`);
    lines.push(`| 失败 | 0 | ${shadows.filter((x) => x.sh.error).length} |`, "", `两者的回答原文并排放在下面每次会话的"追问为什么"一步里。`, "");
  }

  if (before) lines.push(...comparison(all, before), "");

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
console.log(`共 ${jobs.length} 次会话，并发 ${concurrency}，模型 ${model}${effort ? ` effort=${effort}` : ""}，对照 ${answerModel ?? "无"}，输出到 ${outDir}`);

const sessions: Session[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const s = await runSession(job.topic, job.run);
      sessions.push(s);
      const st = stats(s);
      console.log(`[${sessions.length}/${jobs.length}] ${job.topic.id}#${job.run}：${sec(st.totalMs)}，${st.calls} 次调用，输出 ${st.outTokens} tokens，失败 ${st.failures}${s.error ? `，中断：${s.error}` : ""}`);
    }
  }),
);

const order = (s: Session) => topics.indexOf(s.topic) * 100 + s.run;
sessions.sort((a, b) => order(a) - order(b));
const before = args.compare ? (JSON.parse(readFileSync(args.compare, "utf8")) as Stats[]) : null;
let included: Stats[] = [];
if (args.include) {
  const [file, ids] = args.include.split(/:(?=[^\/]*$)/);
  const keep = new Set(ids!.split(","));
  included = (JSON.parse(readFileSync(file!, "utf8")) as Stats[]).filter((x) => keep.has(x.topic!));
}
writeFileSync(join(outDir, "report.md"), report(sessions, before, included) + (included.length ? `

（并入的主题的完整过程见 ${args.include!.split(/:(?=[^\/]*$)/)[0]!.replace("stats.json", "report.md")}）
` : ""));
writeFileSync(join(outDir, "stats.json"), JSON.stringify(sessions.map((s) => ({ topic: s.topic.id, run: s.run, error: s.error, ...stats(s) })), null, 2));
console.log(`报告：${join(outDir, "report.md")}`);
