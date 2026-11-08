// 额度信息（不调用模型）：
// 1. Claude Code 自己的本地缓存 ~/.claude.json 中的 cachedUsageUtilization（Claude Code 交互界面查询额度时写入）。
//    这不是公开的格式，可能随版本变化；读不到或格式不对就返回 null。只取利用率和重置时间，不读取账户等其他字段。
// 2. 每次调用 CLI 时事件流中的 rate_limit_event（状态和 5 小时额度的重置时间），由 ClaudeCodeProvider 记下最近一次。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UsageWindow {
  /** 已用百分比 */
  utilization: number;
  resetsAt: string | null;
}

export interface CachedUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Claude Code 取得这份数据的时间 */
  fetchedAt: string;
}

export const claudeStatePath = () => process.env.THINK_CLAUDE_STATE || join(homedir(), ".claude.json");

function windowOf(x: unknown): UsageWindow | null {
  const w = x as { utilization?: unknown; resets_at?: unknown } | null;
  if (!w || typeof w.utilization !== "number") return null;
  return { utilization: w.utilization, resetsAt: typeof w.resets_at === "string" ? new Date(w.resets_at).toISOString() : null };
}

export function readCachedUsage(path = claudeStatePath()): CachedUsage | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { cachedUsageUtilization?: { fetchedAtMs?: unknown; utilization?: Record<string, unknown> } };
    const c = j.cachedUsageUtilization;
    if (!c || typeof c.fetchedAtMs !== "number" || !c.utilization) return null;
    const fiveHour = windowOf(c.utilization.five_hour);
    const sevenDay = windowOf(c.utilization.seven_day);
    if (!fiveHour && !sevenDay) return null;
    return { fiveHour, sevenDay, fetchedAt: new Date(c.fetchedAtMs).toISOString() };
  } catch {
    return null;
  }
}

/** 最近一次 CLI 调用中的 rate_limit_event */
export interface LastRateLimit {
  status: string;
  /** five_hour / seven_day … */
  type: string | null;
  resetsAt: string | null;
  seenAt: string;
}

export function parseRateLimitEvent(e: unknown, seenAt: string): LastRateLimit | null {
  const info = (e as { rate_limit_info?: { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown } } | null)?.rate_limit_info;
  if (!info || typeof info.status !== "string") return null;
  return {
    status: info.status,
    type: typeof info.rateLimitType === "string" ? info.rateLimitType : null,
    resetsAt: typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : null,
    seenAt,
  };
}
