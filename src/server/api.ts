// 前后端共享的 API 类型（只有类型，不含运行时代码）
import type { Layout, MapMeta, Patch, PatchOp, Turn, Version, WorkspaceConfig } from "../core/schema";
import type { Choices } from "../core/patch";
import type { ProviderStatus } from "./ai/provider";
import type { CachedUsage, LastRateLimit } from "./claude-usage";
import type { TrashEntry } from "./storage/workspace";

export type { CachedUsage, LastRateLimit, TrashEntry };

export interface HealthResponse {
  ok: true;
  node: string;
  schemaVersion: number;
}

export interface StatusResponse {
  /** 数据保存的目录 */
  workspaceDir: string;
  config: WorkspaceConfig;
  /** Claude Code CLI 的状态；检测中为 null */
  provider: ProviderStatus | null;
  /** 额度：Claude Code 本地缓存（不调用模型；可能过时或没有） */
  usage: CachedUsage | null;
  /** 最近一次调用时 CLI 报告的额度状态 */
  lastRateLimit: LastRateLimit | null;
  /** 全局同时进行的 AI 回合上限 */
  maxParallel: number;
}

/** 可以在界面上修改的设置 */
export type SettingsUpdate = Partial<Pick<WorkspaceConfig, "effort_short" | "effort_long" | "show_new_loops" | "privacy_notice_seen">>;

export interface MapSummary {
  /** 文件夹名，同时作为 Map 的 ID */
  name: string;
  meta: MapMeta;
  /** 已接受的变量数 */
  nodes: number;
  /** 程序检测到的回路数 */
  loops: number;
  /** 有待处理的 AI 建议 */
  pending: boolean;
  /** 对话末尾有一条没有得到回复的消息（上次失败或被取消） */
  awaitingReply: boolean;
}

/** 一个 Map 当前的 AI 回合（成功结束后就不再有） */
export interface JobView {
  name: string;
  state: "queued" | "running" | "failed";
  /** 排队中：第几个 */
  position?: number;
  queuedAt: string;
  startedAt?: string;
  attempt: number;
  phase: "waiting" | "thinking" | "writing";
  chars: number;
  error?: { kind: string; message: string; resetsAt?: string };
  violations?: string[];
}

/** GET /api/events（SSE）推送的事件 */
export type ServerEvent = { type: "jobs"; jobs: Record<string, JobView> } | { type: "map"; name: string } | { type: "maps" };

export interface MapListResponse {
  maps: MapSummary[];
  broken: { name: string; error: string }[];
}

/** 打开一个 Map 时需要的全部内容 */
export interface MapState {
  name: string;
  meta: MapMeta;
  /** 全部版本，按编号排序；最后一个是当前的图 */
  versions: Version[];
  patches: Patch[];
  turns: Turn[];
  /** conversation.jsonl 中无法读取的行数 */
  skippedTurns: number;
  layout: Layout;
  notes: string;
  /** 打开时自动修复的问题 */
  repairs: string[];
}

export interface CreateMapRequest {
  topic: string;
}
export interface ResolveRequest {
  choices: Choices;
}
/** 用户自己的直接编辑：一个 origin: user 的补丁，自动接受 */
export interface EditRequest {
  ops: PatchOp[];
  /** 新增变量的位置（按临时引用 $ref），写入 layout.json */
  positions?: Record<string, { x: number; y: number }>;
}
export interface RestoreRequest {
  version: string;
}
export interface TurnRequest {
  /** 不传则对对话末尾没有回复的那条用户消息重试 */
  text?: string;
}

/** AI 回合的进度事件 */
export type TurnProgressEvent =
  | { type: "attempt"; attempt: number; /** 重试的原因 */ reason?: string }
  | { type: "progress"; attempt: number; phase: "waiting" | "thinking" | "writing"; chars: number };

export interface ApiError {
  ok: false;
  error: string;
}
