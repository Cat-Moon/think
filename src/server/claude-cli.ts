// 调用本机 Claude Code CLI 的最小封装（设计文档第 8.1 节）。
// M3 会在此基础上加上校验、重试、日志等。
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

export interface ClaudeCallOptions {
  systemPrompt: string;
  prompt: string;
  jsonSchema: object;
  model?: string;
  timeoutMs?: number;
}

export interface ClaudeRawResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** stdout 解析出的 JSON（失败时为 null） */
  json: Record<string, unknown> | null;
  removedApiKey: boolean;
}

/** 单次、无状态、禁用工具的调用；提示词通过 stdin 传入 */
export function callClaude(opts: ClaudeCallOptions): Promise<ClaudeRawResult> {
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(opts.jsonSchema),
    "--system-prompt", opts.systemPrompt,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
    "--model", opts.model ?? "sonnet",
  ];
  const { env, removedApiKey } = childEnv();
  const cwd = mkdtempSync(join(tmpdir(), "think-cli-"));

  return new Promise((resolve, reject) => {
    const child = spawn(resolveClaudeBin(), args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 180_000);
    const cleanup = () => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
    };
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (exitCode) => {
      cleanup();
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        // 保持 null，由调用方处理
      }
      resolve({ exitCode, stdout, stderr, json, removedApiKey });
    });
    child.stdin.end(opts.prompt, "utf8");
  });
}
