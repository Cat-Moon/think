// 工作台的小工具：每个图的状态、最近使用、浏览器本地记住的界面状态。
import type { JobView, MapSummary } from "../server/api";

export type MapStatus = "running" | "queued" | "pending" | "failed" | "idle";

/** 状态点：思考中 > 排队中 > 有建议待处理 > 上次失败 > 空闲 */
export function mapStatus(summary: MapSummary | undefined, job: JobView | undefined): MapStatus {
  if (job?.state === "running") return "running";
  if (job?.state === "queued") return "queued";
  if (summary?.pending) return "pending";
  if (job?.state === "failed" || summary?.awaitingReply) return "failed";
  return "idle";
}

export const STATUS_TEXT: Record<MapStatus, string> = {
  running: "思考中",
  queued: "排队中",
  pending: "有建议待处理",
  failed: "上次失败（消息已保存，可以重试或放弃）",
  idle: "空闲",
};

/** 浏览器本地的界面状态（读写失败时照常工作） */
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s === null ? fallback : (JSON.parse(s) as T);
  } catch {
    return fallback;
  }
}
export function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略
  }
}

/** 最近使用：最后一次在这台浏览器里打开，和最后修改时间，取较晚的 */
export function sortByRecent(maps: MapSummary[], opened: Record<string, number>): MapSummary[] {
  const key = (m: MapSummary) => Math.max(opened[m.name] ?? 0, Date.parse(m.meta.updated_at));
  return [...maps].sort((a, b) => key(b) - key(a));
}

export const shortTime = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
