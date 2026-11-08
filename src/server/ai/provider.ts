// AI 连接层接口（设计文档第 8 节）。以后新增 API key provider 只需实现这个接口。

export interface LLMRequest {
  systemPrompt: string;
  /** 用户消息部分：由 core/ai-context 组装的完整上下文 */
  prompt: string;
  jsonSchema: object;
  model: string;
  /** 思考程度（low / medium / high …）；不传则用默认 */
  effort?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 流式进度（可选）：AI 正在思考 / 正在写输出，以及已收到的字数 */
  onProgress?: (p: Progress) => void;
}

export interface Progress {
  phase: "waiting" | "thinking" | "writing";
  /** 这一阶段已收到的字符数 */
  chars: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type LLMErrorKind =
  | "cancelled" // 用户取消
  | "timeout"
  | "auth" // 未登录或登录失效
  | "rate_limit" // 订阅额度用尽或请求过快
  | "no_output" // 正常结束但没有结构化输出（例如 AI 拒绝回答）
  | "schema_failure" // AI 多次提交不符合 JSON Schema 的输出（CLI 报 error_max_structured_output_retries）；会重试一次
  | "not_installed" // 找不到 claude
  | "cli_error"; // 其他错误

export type LLMResponse =
  | { ok: true; output: unknown; usage: Usage; durationMs: number; raw: unknown }
  | { ok: false; error: { kind: LLMErrorKind; message: string; /** 额度用完时：CLI 给出的重置时间（ISO） */ resetsAt?: string }; durationMs: number; raw?: unknown };

export interface ProviderStatus {
  ok: boolean;
  /** 给用户看的一句话 */
  message: string;
  version?: string;
  /** claude.ai（订阅）/ api_key / … */
  authMethod?: string;
  /** 环境中设置了 ANTHROPIC_API_KEY（调用时会从子进程环境中移除） */
  apiKeyEnvSet: boolean;
}

export interface AgentProvider {
  name: string;
  healthCheck(): Promise<ProviderStatus>;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

export const ERROR_TEXT: Record<LLMErrorKind, string> = {
  cancelled: "已取消",
  timeout: "AI 超过时间上限仍未回复，已停止。你的输入已保存，可以重试",
  auth: "Claude Code 未登录或登录已失效，请在终端运行 claude 并登录",
  rate_limit: "订阅额度已用完或请求过于频繁，请稍后再试",
  no_output: "AI 没有给出结构化的回复",
  schema_failure: "AI 的输出多次不符合格式",
  not_installed: "找不到 Claude Code CLI",
  cli_error: "调用 Claude Code 时出错",
};
