// 一轮对话：保存用户消息 → 组装上下文 → 调用 AI → 检查（必要时重试一次）→ 记日志 → 保存补丁和 AI 回复。
//
// 输入不会丢：用户消息在调用 AI 之前就写入 conversation.jsonl。
// 如果 AI 调用失败或被取消，这条消息留在对话末尾、没有 AI 回复；
// 之后调用 takeTurn 且不传 userText，就会对这条消息重试。
import { buildTurnPrompt, turnLength } from "../../core/ai-context";
import { checkAiOutput, errorsOf, sanitizeAiOutput, warningsOf, type Violation } from "../../core/ai-check";
import { nextSeqId } from "../../core/ids";
import { makePatch } from "../../core/patch";
import { AiOutput, aiOutputJsonSchema, type Patch, type Turn } from "../../core/schema";
import { appendJsonl } from "../storage/fsutil";
import { appendTurn, listPatchIds, nextPatchId, paths, readConversation, readGraph, readPatch, savePatch } from "../storage/map-store";
import { ERROR_TEXT, ZERO_USAGE, addUsage, type AgentProvider, type LLMErrorKind, type Usage } from "./provider";
import { loadSystemPrompt, type SystemPrompt } from "./system-prompt";

export const MAX_ATTEMPTS = 2;
/** 每次调用的时间上限（设计文档第 8.1.1 节） */
export const CALL_TIMEOUT_MS = 180_000;

export interface TurnOptions {
  /** 新的用户消息；不传则对对话末尾那条没有回复的用户消息重试 */
  userText?: string;
  model?: string;
  /** 思考程度（low / medium / high …）；优先于 effortPolicy；都不传则用 CLI 默认 */
  effort?: string;
  /** 按回合长短选择思考程度（来自 workspace.json 的 effort_short / effort_long） */
  effortPolicy?: { short: string | null; long: string | null };
  signal?: AbortSignal;
  timeoutMs?: number;
  systemPrompt?: SystemPrompt;
  now?: () => string;
}

export interface AttemptRecord {
  attempt: number;
  durationMs: number;
  usage: Usage;
  violations: Violation[];
  error?: { kind: LLMErrorKind | "invalid_output"; message: string };
}

interface TurnBase {
  userTurn: Turn;
  attempts: AttemptRecord[];
  usage: Usage;
  durationMs: number;
}

export type TurnResult =
  | (TurnBase & {
      ok: true;
      output: AiOutput;
      aiTurn: Turn;
      patch: Patch | null;
      /** 最终输出的提示（不阻止） */
      warnings: Violation[];
    })
  | (TurnBase & {
      ok: false;
      error: { kind: LLMErrorKind | "invalid_output"; message: string };
      /** invalid_output 时：最后一次的输出和没通过的检查，展示给用户，不静默截断 */
      output?: AiOutput;
      violations?: Violation[];
    });

export class TurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnError";
  }
}

async function readAllPatches(dir: string): Promise<Patch[]> {
  return Promise.all((await listPatchIds(dir)).map((id) => readPatch(dir, id)));
}

export async function takeTurn(dir: string, provider: AgentProvider, opts: TurnOptions = {}): Promise<TurnResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const model = opts.model ?? "sonnet";
  const system = opts.systemPrompt ?? loadSystemPrompt();

  const graph = await readGraph(dir);
  const patches = await readAllPatches(dir);
  const pending = patches.find((p) => p.resolution === null);
  if (pending) throw new TurnError(`请先处理上一轮的建议（${pending.patch_id}）`);

  // 1. 先保存用户消息
  let { items: turns } = await readConversation(dir);
  let userTurn: Turn;
  if (opts.userText !== undefined) {
    if (!opts.userText.trim()) throw new TurnError("消息不能为空");
    userTurn = await appendTurn(dir, { role: "user", text: opts.userText }, now());
    turns = [...turns, userTurn];
  } else {
    const last = turns.at(-1);
    if (last?.role !== "user") throw new TurnError("没有需要重试的消息");
    userTurn = last;
  }

  // 2. 调用 AI，检查，必要时带着问题重试一次
  const policy = opts.effortPolicy;
  const effort = opts.effort ?? (policy ? (turnLength(graph, userTurn.text) === "short" ? policy.short : policy.long) ?? undefined : undefined);
  const attempts: AttemptRecord[] = [];
  let usage = ZERO_USAGE;
  let retryErrors: string[] | undefined;
  let last: { output: AiOutput; violations: Violation[] } | undefined;
  const t0 = Date.now();
  const base = () => ({ userTurn, attempts, usage, durationMs: Date.now() - t0 });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt = buildTurnPrompt({ graph, patches, turns, retryErrors });
    const res = await provider.complete({
      systemPrompt: system.text,
      prompt,
      jsonSchema: aiOutputJsonSchema(),
      model,
      effort,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? CALL_TIMEOUT_MS,
    });
    const record: AttemptRecord = { attempt, durationMs: res.durationMs, usage: res.ok ? res.usage : ZERO_USAGE, violations: [] };
    attempts.push(record);
    usage = addUsage(usage, record.usage);

    let parsed: AiOutput | undefined;
    if (res.ok) {
      const z = AiOutput.safeParse(res.output);
      if (z.success) parsed = z.data;
      else record.error = { kind: "invalid_output", message: `输出格式不对：${z.error.issues[0]?.message}` };
    } else {
      record.error = res.error;
    }
    if (parsed) record.violations = checkAiOutput(parsed, graph, patches);

    await appendJsonl(paths(dir).providerLog, {
      ts: now(),
      provider: provider.name,
      model,
      effort: effort ?? null,
      user_turn: userTurn.turn_id,
      attempt,
      system_prompt_sha: system.sha,
      prompt,
      ok: res.ok,
      duration_ms: res.durationMs,
      usage: record.usage,
      error: record.error ?? null,
      output: parsed ?? null,
      violations: record.violations,
      raw: res.raw ?? null,
    });

    if (!res.ok) {
      // JSON 格式不合法属于硬性违规：带着校验错误重试一次
      if (res.error.kind === "schema_failure" && attempt < MAX_ATTEMPTS) {
        retryErrors = [
          `上一次提交的输出不符合格式（${res.error.message}）。提交的参数必须直接是包含 kind、message、question、ops、possible_duplicates 五个字段的 JSON 对象，不要包在其他字段里`,
        ];
        continue;
      }
      // 取消、额度、登录等问题不重试；用户消息已保存，可稍后重试
      return { ok: false, error: res.error, ...base() };
    }
    if (!parsed) {
      retryErrors = [record.error!.message];
      continue;
    }
    last = { output: parsed, violations: record.violations };
    const errors = errorsOf(record.violations);
    if (!errors.length) break;
    retryErrors = errors.map((e) => e.message);
  }

  if (!last || errorsOf(last.violations).length) {
    return {
      ok: false,
      error: { kind: "invalid_output", message: `AI 的回复没有通过检查（已重试 ${MAX_ATTEMPTS - 1} 次）` },
      output: last?.output,
      violations: last?.violations,
      ...base(),
    };
  }

  // 3. 保存补丁和 AI 回复
  // 安全网：显示文字中的内部 ID（n5、e3、$ref）替换成变量名；检查结果仍基于原始输出
  const output = sanitizeAiOutput(last.output, graph);
  let patch: Patch | null = null;
  const aiTurnId = nextSeqId(userTurn.turn_id); // 用户消息总是对话的最后一条
  if (output.kind === "patch") {
    patch = makePatch(
      {
        patch_id: await nextPatchId(dir),
        base_version: graph.version,
        origin: "ai",
        ops: output.ops,
        turn_id: aiTurnId,
        message: output.message,
        question: output.question,
        possible_duplicates: output.possible_duplicates,
      },
      now(),
    );
    await savePatch(dir, patch);
  }
  const aiTurn = await appendTurn(
    dir,
    { role: "ai", kind: output.kind, text: output.message, question: output.question || undefined, ...(patch ? { patch_id: patch.patch_id } : {}) },
    now(),
  );
  if (aiTurn.turn_id !== aiTurnId) throw new TurnError(`对话编号不一致：预期 ${aiTurnId}，实际 ${aiTurn.turn_id}`);

  return { ok: true, output, aiTurn, patch, warnings: warningsOf(last.violations), ...base() };
}

export { ERROR_TEXT };
