// AI 回合在服务端排队执行（设计文档第 9.2.4 节）。
// - 每个 Map 同一时刻最多一个进行中的回合；不同 Map 可以并行，全局最多 maxParallel 个，其余排队
// - 回合的进度和结果保存在服务端：界面切到别的图、甚至刷新页面，回来时进度还在
// - 用户消息在排队前就写入 conversation.jsonl（输入不丢）；执行时按"重试末尾那条消息"调用 takeTurn
// - 取消：排队中的直接移出队列；执行中的终止 CLI 子进程
import type { WorkspaceConfig } from "../core/schema";
import { TurnError, takeTurn } from "./ai/turn";
import type { AgentProvider } from "./ai/provider";
import type { JobView } from "./api";
import { StorageError } from "./storage/fsutil";
import { appendTurn, listPatchIds, readConversation, readPatch } from "./storage/map-store";

export const MAX_PARALLEL = 2;

interface Job extends JobView {
  dir: string;
  controller: AbortController | null;
}

export interface JobsOptions {
  provider: AgentProvider;
  now: () => string;
  config: () => Promise<WorkspaceConfig>;
  /** 同一个 Map 的写操作串行执行 */
  withLock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** 任何回合状态变化时调用（推送给界面） */
  onChange: () => void;
  /** 回合结束（成功或失败），Map 的内容可能变了 */
  onMapChanged: (name: string) => void;
  maxParallel?: number;
}

async function hasPendingPatch(dir: string): Promise<string | null> {
  for (const id of (await listPatchIds(dir)).reverse()) if ((await readPatch(dir, id)).resolution === null) return id;
  return null;
}

export class TurnJobs {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running = 0;
  readonly maxParallel: number;

  constructor(private opts: JobsOptions) {
    this.maxParallel = opts.maxParallel ?? MAX_PARALLEL;
  }

  /** 排队中或执行中 */
  isActive(name: string): boolean {
    const s = this.jobs.get(name)?.state;
    return s === "queued" || s === "running";
  }

  views(): Record<string, JobView> {
    const out: Record<string, JobView> = {};
    for (const [name, j] of this.jobs) {
      const { dir: _dir, controller: _c, ...view } = j;
      out[name] = { ...view, position: j.state === "queued" ? this.queue.indexOf(name) + 1 : undefined };
    }
    return out;
  }

  /**
   * 开始一轮：text 为新消息（先写入对话）；不传则重试对话末尾那条没有回复的消息。
   * 不能开始时抛出 TurnError（消息没有保存）。
   */
  async start(name: string, dir: string, text?: string): Promise<void> {
    if (this.isActive(name)) throw new TurnError("这个图里 AI 正在思考或排队，请等它结束或先取消");
    if (text !== undefined && !text.trim()) throw new TurnError("消息不能为空");
    await this.opts.withLock(name, async () => {
      const pending = await hasPendingPatch(dir);
      if (pending) throw new TurnError(`请先处理上一轮的建议（${pending}）`);
      const last = (await readConversation(dir)).items.at(-1);
      if (text !== undefined) {
        if (last?.role === "user") throw new TurnError("上一条消息还没有回复：请重试，或放弃它后再发");
        await appendTurn(dir, { role: "user", text }, this.opts.now());
      } else if (last?.role !== "user") {
        throw new TurnError("没有需要重试的消息");
      }
    });
    this.jobs.set(name, { name, dir, state: "queued", queuedAt: this.opts.now(), attempt: 1, phase: "waiting", chars: 0, controller: null });
    this.queue.push(name);
    this.opts.onChange();
    this.pump();
  }

  cancel(name: string): boolean {
    const j = this.jobs.get(name);
    if (!j) return false;
    if (j.state === "queued") {
      this.queue = this.queue.filter((n) => n !== name);
      Object.assign(j, { state: "failed", error: { kind: "cancelled", message: "已取消" } });
      this.opts.onChange();
      this.opts.onMapChanged(name);
      return true;
    }
    if (j.state === "running") {
      j.controller?.abort();
      return true;
    }
    return false;
  }

  /** 清除上次失败的记录（重试、放弃、发新消息时） */
  dismiss(name: string) {
    if (this.jobs.get(name)?.state === "failed") {
      this.jobs.delete(name);
      this.opts.onChange();
    }
  }

  /** Map 被删除或改名时：只允许在没有进行中的回合时调用 */
  forget(name: string) {
    if (this.isActive(name)) throw new StorageError("AI 正在这个图里思考，请先取消");
    this.jobs.delete(name);
  }

  private pump() {
    while (this.running < this.maxParallel && this.queue.length) {
      const name = this.queue.shift()!;
      const j = this.jobs.get(name);
      if (j?.state === "queued") void this.run(j);
    }
    this.opts.onChange();
  }

  private async run(j: Job) {
    this.running++;
    j.state = "running";
    j.startedAt = this.opts.now();
    j.controller = new AbortController();
    this.opts.onChange();
    try {
      const config = await this.opts.config();
      // 不持锁执行：回合进行中，这个图的写操作都会被拒绝（409），读取（打开图）不必等 AI 回复
      const r = await takeTurn(j.dir, this.opts.provider, {
          model: config.default_model,
          effortPolicy: { short: config.effort_short, long: config.effort_long },
          signal: j.controller!.signal,
          now: this.opts.now,
          onEvent: (e) => {
            if (e.type === "attempt") Object.assign(j, { attempt: e.attempt, phase: "waiting", chars: 0 });
            else Object.assign(j, { attempt: e.attempt, phase: e.phase, chars: e.chars });
            this.opts.onChange();
          },
        });
      if (r.ok) this.jobs.delete(j.name);
      else Object.assign(j, { state: "failed", error: r.error, violations: r.violations?.map((v) => v.message) });
    } catch (e) {
      Object.assign(j, { state: "failed", error: { kind: e instanceof TurnError ? "rejected" : "cli_error", message: (e as Error).message } });
    } finally {
      j.controller = null;
      this.running--;
      this.opts.onMapChanged(j.name);
      this.pump();
    }
  }
}
