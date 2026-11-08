// 调用本机服务端的 API（类型见 src/server/api.ts）
import type { Choices } from "../core/patch";
import type { PatchOp, WorkspaceConfig } from "../core/schema";
import type { MapMeta } from "../core/schema";
import type { MapListResponse, MapState, ServerEvent, SettingsUpdate, StatusResponse, TrashEntry } from "../server/api";

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
  createMap: (topic: string) => call<{ name: string; meta: MapMeta }>("POST", "/api/maps", { topic }),
  renameMap: (name: string, title: string) => call<{ meta: MapMeta }>("POST", `${m(name)}/rename`, { title }),
  deleteMap: (name: string) => call<{ entry: string }>("DELETE", m(name)),
  listTrash: () => call<{ entries: TrashEntry[] }>("GET", "/api/trash"),
  restoreTrash: (entry: string) => call<{ name: string }>("POST", `/api/trash/${encodeURIComponent(entry)}/restore`),
  /** 开始一轮（排队执行，立即返回）；text 不传则重试末尾那条消息 */
  startTurn: (name: string, text?: string) => call<{ ok: true }>("POST", `${m(name)}/turn`, text === undefined ? {} : { text }),
  cancelTurn: (name: string) => call<{ ok: boolean }>("POST", `${m(name)}/turn/cancel`),
  getMap: (name: string) => call<MapState>("GET", m(name)),
  saveLayout: (name: string, positions: Record<string, { x: number; y: number }>) => call("PUT", `${m(name)}/layout`, { positions }),
  saveNotes: (name: string, text: string) => call("PUT", `${m(name)}/notes`, { text }),
  resolve: (name: string, patchId: string, choices: Choices) => call<{ version: string | null }>("POST", `${m(name)}/patches/${patchId}`, { choices }),
  edit: (name: string, ops: PatchOp[], positions?: Record<string, { x: number; y: number }>) => call<{ version: string | null }>("POST", `${m(name)}/edit`, { ops, positions }),
  abandon: (name: string) => call<{ turn: string }>("POST", `${m(name)}/abandon`),
  restore: (name: string, version: string) => call<{ version: string }>("POST", `${m(name)}/restore`, { version }),
};

/** 订阅服务端事件（回合状态、Map 变化）；返回取消订阅的函数。断线后浏览器会自动重连 */
export function subscribe(onEvent: (e: ServerEvent) => void, onOpen?: () => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => onEvent(JSON.parse(m.data as string) as ServerEvent);
  es.onopen = () => onOpen?.();
  return () => es.close();
}
