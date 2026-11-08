// ClaudeCodeProvider：通过本机已登录的 Claude Code CLI 调用（设计文档第 8.1 节）。
import { printArgs, runClaude, type RunResult } from "../claude-cli";
import { ERROR_TEXT, ZERO_USAGE, type AgentProvider, type LLMErrorKind, type LLMRequest, type LLMResponse, type ProviderStatus, type Usage } from "./provider";

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

  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    // 下面处理
  }
  const text = `${json ? String(json.result ?? "") : run.stdout}\n${run.stderr}`;
  const status = json?.api_error_status;
  if (status === 429 || /usage limit|rate limit|limit reached|额度/i.test(text)) return { kind: "rate_limit", message: ERROR_TEXT.rate_limit };
  if (status === 401 || status === 403 || /not logged in|please run \/login|invalid api key|authentication|oauth/i.test(text)) {
    return { kind: "auth", message: ERROR_TEXT.auth };
  }
  if (!json) return { kind: "cli_error", message: `${ERROR_TEXT.cli_error}：${(run.stderr || run.stdout).trim().slice(0, 500) || `退出码 ${run.exitCode}`}` };
  if (json.is_error) return { kind: "cli_error", message: `${ERROR_TEXT.cli_error}：${String(json.result ?? json.subtype ?? "").slice(0, 500)}` };
  if (json.structured_output === undefined) {
    return { kind: "no_output", message: `${ERROR_TEXT.no_output}${json.result ? `：${String(json.result).slice(0, 300)}` : ""}` };
  }
  return null;
}

export class ClaudeCodeProvider implements AgentProvider {
  name = "claude-code";

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
      run = await runClaude(printArgs(req), { stdin: req.prompt, signal: req.signal, timeoutMs: req.timeoutMs });
    } catch (e) {
      return { ok: false, error: { kind: "not_installed", message: `${ERROR_TEXT.not_installed}：${(e as Error).message}` }, durationMs: Date.now() - t0 };
    }
    const durationMs = Date.now() - t0;
    const error = classify(run);
    let raw: unknown = run.stdout;
    try {
      raw = JSON.parse(run.stdout);
    } catch {
      // 保留原文
    }
    if (error) return { ok: false, error, durationMs, raw };
    const json = raw as Record<string, unknown>;
    return { ok: true, output: json.structured_output, usage: json.usage ? parseUsage(json.usage) : ZERO_USAGE, durationMs, raw };
  }
}
