// ClaudeCodeProvider：通过本机已登录的 Claude Code CLI 调用（设计文档第 8.1 节）。
import { parseRateLimitEvent, type LastRateLimit } from "../claude-usage";
import { parseStream, printArgs, runClaude, type RunResult } from "../claude-cli";
import { ERROR_TEXT, ZERO_USAGE, type AgentProvider, type LLMErrorKind, type LLMRequest, type LLMResponse, type Progress, type ProviderStatus, type Usage } from "./provider";

/**
 * 把 --include-partial-messages 的 stream_event 变成进度：thinking_delta → 思考中，
 * text_delta / input_json_delta → 正在写。流式片段未经校验，只用来显示进度；结果仍以 result 行为准。
 * 同一阶段内最多每 250ms 报告一次。
 */
export function progressTracker(report: (p: Progress) => void, now: () => number = Date.now) {
  let phase: Progress["phase"] = "waiting";
  let chars = 0;
  let lastAt = 0;
  return (line: string) => {
    if (!line.includes('"stream_event"')) return;
    let m: { type?: string; event?: { type?: string; delta?: Record<string, unknown> } };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      return;
    }
    const delta = m.type === "stream_event" && m.event?.type === "content_block_delta" ? m.event.delta : undefined;
    if (!delta) return;
    const piece = delta.type === "thinking_delta" ? delta.thinking : delta.type === "text_delta" ? delta.text : delta.type === "input_json_delta" ? delta.partial_json : undefined;
    if (typeof piece !== "string") return;
    const next: Progress["phase"] = delta.type === "thinking_delta" ? "thinking" : "writing";
    if (next !== phase) {
      phase = next;
      chars = 0;
      lastAt = 0;
    }
    chars += piece.length;
    const t = now();
    if (t - lastAt >= 250) {
      lastAt = t;
      report({ phase, chars });
    }
  };
}

function parseUsage(u: unknown): Usage {
  const x = (u ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof x[k] === "number" ? (x[k] as number) : 0);
  return {
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    cacheReadTokens: n("cache_read_input_tokens"),
    cacheCreationTokens: n("cache_creation_input_tokens"),
  };
}

/** 把 CLI 的结果分类成 Think 的错误类型 */
export function classify(run: RunResult): { kind: LLMErrorKind; message: string } | null {
  if (run.killedBy === "abort") return { kind: "cancelled", message: ERROR_TEXT.cancelled };
  if (run.killedBy === "timeout") return { kind: "timeout", message: ERROR_TEXT.timeout };

  const parsed = parseStream(run.stdout);
  const json = parsed.result;
  const text = `${json ? String(json.result ?? "") : run.stdout}\n${run.stderr}`;
  const status = json?.api_error_status;
  if (status === 429 || /usage limit|rate limit|limit reached|额度/i.test(text)) return { kind: "rate_limit", message: ERROR_TEXT.rate_limit };
  if (status === 401 || status === 403 || /not logged in|please run \/login|invalid api key|authentication|oauth/i.test(text)) {
    return { kind: "auth", message: ERROR_TEXT.auth };
  }
  if (!json) return { kind: "cli_error", message: `${ERROR_TEXT.cli_error}：${(run.stderr || run.stdout).trim().slice(0, 500) || `退出码 ${run.exitCode}`}` };
  if (json.subtype === "error_max_structured_output_retries") {
    const why = parsed.structuredErrors.at(-1);
    return { kind: "schema_failure", message: `${ERROR_TEXT.schema_failure}${why ? `：${why.slice(0, 300)}` : ""}` };
  }
  if (json.is_error) return { kind: "cli_error", message: `${ERROR_TEXT.cli_error}：${String(json.result ?? json.subtype ?? "").slice(0, 500)}` };
  if (json.structured_output === undefined) {
    return { kind: "no_output", message: `${ERROR_TEXT.no_output}${json.result ? `：${String(json.result).slice(0, 300)}` : ""}` };
  }
  return null;
}

export class ClaudeCodeProvider implements AgentProvider {
  name = "claude-code";
  lastRateLimit: LastRateLimit | null = null;

  async healthCheck(): Promise<ProviderStatus> {
    const apiKeyEnvSet = "ANTHROPIC_API_KEY" in process.env;
    let version: string | undefined;
    try {
      const v = await runClaude(["--version"], { timeoutMs: 30_000 });
      version = v.stdout.trim().split(/\s+/)[0];
      const a = await runClaude(["auth", "status"], { timeoutMs: 30_000 });
      let authMethod: string | undefined;
      try {
        authMethod = String((JSON.parse(a.stdout) as Record<string, unknown>).authMethod ?? "");
      } catch {
        // 旧版 CLI 可能不输出 JSON
      }
      const ok = a.exitCode === 0 && authMethod !== "none";
      const viaSubscription = authMethod === "claude.ai";
      return {
        ok,
        version,
        authMethod,
        apiKeyEnvSet,
        message: !ok
          ? ERROR_TEXT.auth
          : `Claude Code ${version ?? ""} 已连接（${viaSubscription ? "订阅登录" : authMethod || "未知方式"}）${apiKeyEnvSet ? "；检测到 ANTHROPIC_API_KEY，调用时会移除它以使用订阅" : ""}`,
      };
    } catch (e) {
      return { ok: false, version, apiKeyEnvSet, message: `${ERROR_TEXT.not_installed}：${(e as Error).message}` };
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const t0 = Date.now();
    let run: RunResult;
    try {
      req.onProgress?.({ phase: "waiting", chars: 0 });
      const onLine = req.onProgress ? progressTracker(req.onProgress) : undefined;
      run = await runClaude(printArgs({ ...req, partial: Boolean(req.onProgress) }), { stdin: req.prompt, signal: req.signal, timeoutMs: req.timeoutMs, onLine });
    } catch (e) {
      return { ok: false, error: { kind: "not_installed", message: `${ERROR_TEXT.not_installed}：${(e as Error).message}` }, durationMs: Date.now() - t0 };
    }
    const durationMs = Date.now() - t0;
    const error = classify(run);
    const parsed = parseStream(run.stdout);
    // 记下最近一次的额度状态（不需要额外调用）
    this.lastRateLimit = parseRateLimitEvent(parsed.rateLimit, new Date().toISOString()) ?? this.lastRateLimit;
    // 日志只记 result 行、格式校验错误和额度信息，不记整个事件流
    const raw = parsed.result
      ? { ...parsed.result, structured_output_errors: parsed.structuredErrors, structured_output_attempts: parsed.structuredAttempts, rate_limit_event: parsed.rateLimit }
      : { stdout: run.stdout.slice(0, 2000), stderr: run.stderr.slice(0, 2000) };
    if (error) {
      // 额度用完时，CLI 的 rate_limit_event 带有重置时间（秒）
      const resets = (parsed.rateLimit as { rate_limit_info?: { resetsAt?: unknown } } | null)?.rate_limit_info?.resetsAt;
      if (error.kind === "rate_limit" && typeof resets === "number") return { ok: false, error: { ...error, resetsAt: new Date(resets * 1000).toISOString() }, durationMs, raw };
      return { ok: false, error, durationMs, raw };
    }
    const json = parsed.result!;
    return { ok: true, output: json.structured_output, usage: json.usage ? parseUsage(json.usage) : ZERO_USAGE, durationMs, raw };
  }
}
