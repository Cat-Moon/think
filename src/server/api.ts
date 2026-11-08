// 前后端共享的 API 类型（只有类型，不含运行时代码）
import type { Layout, MapMeta, Patch, PatchOp, Turn, Version, WorkspaceConfig } from "../core/schema";
import type { Choices } from "../core/patch";
import type { ProviderStatus } from "./ai/provider";

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
}

/** 可以在界面上修改的设置 */
export type SettingsUpdate = Partial<Pick<WorkspaceConfig, "effort_short" | "effort_long" | "show_new_loops" | "privacy_notice_seen">>;

export interface MapSummary {
  /** 文件夹名，同时作为 Map 的 ID */
  name: string;
  meta: MapMeta;
}

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

/** POST /api/maps/:name/turn 的响应是 NDJSON：若干进度事件，最后一行是 done */
export type TurnStreamEvent =
  | TurnProgressEvent
  | { type: "done"; ok: true; warnings: string[] }
  | {
      type: "done";
      ok: false;
      error: { kind: string; message: string };
      /** 用户消息是否已保存（已保存则可以直接重试，不用重新输入） */
      saved: boolean;
      /** 没有通过检查时：未通过的检查 */
      violations?: string[];
    };

export interface ApiError {
  ok: false;
  error: string;
}
