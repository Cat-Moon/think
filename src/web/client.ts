// 调用本机服务端的 API（类型见 src/server/api.ts）
import type { Choices } from "../core/patch";
import type { PatchOp, WorkspaceConfig } from "../core/schema";
import type { MapListResponse, MapState, MapSummary, SettingsUpdate, StatusResponse, TurnProgressEvent, TurnStreamEvent } from "../server/api";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("连接不到 Think 服务端（npm run dev 是否在运行？）", 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `请求失败（${res.status}）`, res.status);
  return data;
}

const m = (name: string) => `/api/maps/${encodeURIComponent(name)}`;

export const api = {
  status: (refresh = false) => call<StatusResponse>("GET", `/api/status${refresh ? "?refresh=1" : ""}`),
  saveSettings: (s: SettingsUpdate) => call<WorkspaceConfig>("PUT", "/api/settings", s),
  listMaps: () => call<MapListResponse>("GET", "/api/maps"),
  createMap: (topic: string) => call<MapSummary>("POST", "/api/maps", { topic }),
  getMap: (name: string) => call<MapState>("GET", m(name)),
  saveLayout: (name: string, positions: Record<string, { x: number; y: number }>) => call("PUT", `${m(name)}/layout`, { positions }),
  saveNotes: (name: string, text: string) => call("PUT", `${m(name)}/notes`, { text }),
  resolve: (name: string, patchId: string, choices: Choices) => call<{ version: string | null }>("POST", `${m(name)}/patches/${patchId}`, { choices }),
  edit: (name: string, ops: PatchOp[], positions?: Record<string, { x: number; y: number }>) => call<{ version: string | null }>("POST", `${m(name)}/edit`, { ops, positions }),
  abandon: (name: string) => call<{ turn: string }>("POST", `${m(name)}/abandon`),
  restore: (name: string, version: string) => call<{ version: string }>("POST", `${m(name)}/restore`, { version }),
};

/**
 * AI 回合：逐行读取 NDJSON 进度，返回最后的 done 事件。
 * signal 取消时断开连接，服务端随即终止 CLI 子进程。
 */
export async function streamTurn(name: string, text: string | undefined, onEvent: (e: TurnProgressEvent) => void, signal: AbortSignal): Promise<Extract<TurnStreamEvent, { type: "done" }>> {
  let res: Response;
  try {
    res = await fetch(`${m(name)}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(text === undefined ? {} : { text }), signal });
  } catch (e) {
    if (signal.aborted) return { type: "done", ok: false, error: { kind: "cancelled", message: "已取消" }, saved: text === undefined };
    throw new ApiError("连接不到 Think 服务端", 0);
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { type: "done", ok: false, error: { kind: "rejected", message: data.error ?? `请求失败（${res.status}）` }, saved: false };
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let done: Extract<TurnStreamEvent, { type: "done" }> | null = null;
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const e = JSON.parse(line) as TurnStreamEvent;
        if (e.type === "done") done = e;
        else onEvent(e);
      }
    }
  } catch {
    // 取消或连接中断
  }
  if (done) return done;
  // 没有收到结果：取消或连接中断。用户消息在调用 AI 之前就已保存，可以重试
  return signal.aborted
    ? { type: "done", ok: false, error: { kind: "cancelled", message: "已取消" }, saved: true }
    : { type: "done", ok: false, error: { kind: "cli_error", message: "连接中断" }, saved: true };
}
