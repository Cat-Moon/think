// 调用本机 Claude Code CLI 的最小封装（设计文档第 8.1 节）。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * 找到可以直接 spawn 的 claude 可执行文件。
 * Windows 上 npm 装的是 claude.cmd 包装脚本；spawn .cmd 必须经过 cmd.exe，
 * 参数（JSON Schema、提示词）很难正确转义，所以解析出它实际调用的 claude.exe。
 * 可用环境变量 THINK_CLAUDE_BIN 手动指定。
 */
export function resolveClaudeBin(): string {
  const override = process.env.THINK_CLAUDE_BIN;
  if (override) return override;
  if (process.platform !== "win32") return "claude";

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const exe = join(dir, "claude.exe");
    if (existsSync(exe)) return exe;
    const cmd = join(dir, "claude.cmd");
    if (existsSync(cmd)) {
      const m = readFileSync(cmd, "utf8").match(/"%dp0%\\([^"]+\.exe)"/i);
      if (m?.[1]) {
        const target = join(dirname(cmd), m[1]);
        if (existsSync(target)) return target;
      }
    }
  }
  throw new Error("找不到 claude 可执行文件。请确认已安装 Claude Code，或设置 THINK_CLAUDE_BIN。");
}

/** 子进程环境：移除 ANTHROPIC_API_KEY，避免 -p 模式改用 API key 计费（第 8.2 节） */
export function childEnv(): { env: NodeJS.ProcessEnv; removedApiKey: boolean } {
  const env = { ...process.env };
  const removedApiKey = "ANTHROPIC_API_KEY" in env;
  delete env.ANTHROPIC_API_KEY;
  return { env, removedApiKey };
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 被谁终止：用户取消 / 超时 / 正常结束 */
  killedBy: "abort" | "timeout" | null;
  removedApiKey: boolean;
}

/** 在一个空的临时目录里运行 claude；stdin 写入后关闭；结束后删除临时目录 */
export function runClaude(args: string[], opts: { stdin?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RunResult> {
  const { env, removedApiKey } = childEnv();
  const cwd = mkdtempSync(join(tmpdir(), "think-cli-"));

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      rmSync(cwd, { recursive: true, force: true });
      resolve({ exitCode: null, stdout: "", stderr: "", killedBy: "abort", removedApiKey });
      return;
    }
    const child = spawn(resolveClaudeBin(), args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let killedBy: RunResult["killedBy"] = null;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));

    const kill = (why: "abort" | "timeout") => {
      killedBy ??= why;
      child.kill();
    };
    const onAbort = () => kill("abort");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs ?? 180_000);

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      rmSync(cwd, { recursive: true, force: true });
    };
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (exitCode) => {
      cleanup();
      resolve({ exitCode, stdout, stderr, killedBy, removedApiKey });
    });
    child.stdin.on("error", () => undefined); // 进程提前退出时写 stdin 会报 EPIPE，忽略
    child.stdin.end(opts.stdin ?? "", "utf8");
  });
}

export interface PrintOptions {
  systemPrompt: string;
  jsonSchema: object;
  model: string;
  /** 思考程度：low / medium / high …；不传则用 CLI 默认 */
  effort?: string;
}

/**
 * 单次、无状态、禁用工具的结构化输出调用所用的参数。
 * 用 stream-json（需要 --verbose）：最后一行是 result（含 structured_output），
 * 中间的 StructuredOutput 工具结果会带出格式校验失败的原因，便于诊断。
 */
export function printArgs(opts: PrintOptions): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(opts.jsonSchema),
    "--system-prompt", opts.systemPrompt,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
    "--model", opts.model,
    ...(opts.effort ? ["--effort", opts.effort] : []),
  ];
}

export interface ParsedStream {
  /** 最后的 result 消息（没有则为最后一个能解析的 JSON 行） */
  result: Record<string, unknown> | null;
  /** StructuredOutput 被拒时的校验错误（tool_result 的 is_error） */
  structuredErrors: string[];
  /** AI 每次提交给 StructuredOutput 工具的参数（截断），用于诊断格式错误 */
  structuredAttempts: string[];
  /** CLI 报告的额度信息（rate_limit_event） */
  rateLimit: unknown;
}

/** 解析 stream-json 输出（也兼容单个 JSON 对象） */
export function parseStream(stdout: string): ParsedStream {
  const out: ParsedStream = { result: null, structuredErrors: [], structuredAttempts: [], rateLimit: null };
  let last: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    last = m;
    if (m.type === "result") out.result = m;
    if (m.type === "rate_limit_event") out.rateLimit = m;
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (m.type === "assistant" && Array.isArray(content)) {
      for (const c of content as Record<string, unknown>[]) {
        if (c.type === "tool_use") out.structuredAttempts.push(JSON.stringify(c.input).slice(0, 1500));
      }
    }
    if (m.type === "user" && Array.isArray(content)) {
      for (const c of content as Record<string, unknown>[]) {
        if (c.type !== "tool_result" || !c.is_error) continue;
        const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
        out.structuredErrors.push(text.slice(0, 1000));
      }
    }
  }
  out.result ??= last;
  return out;
}
