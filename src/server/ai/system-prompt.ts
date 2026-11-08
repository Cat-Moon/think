// 系统提示词放在仓库的 prompts/system.md，方便直接阅读和修改。
// 每次调用都重新读取，修改后不需要重启服务。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SYSTEM_PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "prompts", "system.md");

export interface SystemPrompt {
  text: string;
  /** 内容的短哈希，记入日志，便于对照是哪一版提示词 */
  sha: string;
}

export function loadSystemPrompt(path = SYSTEM_PROMPT_PATH): SystemPrompt {
  const text = readFileSync(path, "utf8").trim();
  return { text, sha: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}
