// HTTP API（设计文档第 9.4 节）。只监听 127.0.0.1，只给本机的界面用。
//
// 所有修改图的操作都走补丁：AI 的建议由用户逐项处理；用户自己的编辑是 origin: user 的补丁，自动接受。
// 同一个 Map 的写操作按顺序执行（每个 Map 一把锁）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { PatchError, makePatch, resolvePatch } from "../core/patch";
import { Layout as LayoutSchema, PatchOp, SCHEMA_VERSION, type Patch } from "../core/schema";
import type { AgentProvider, ProviderStatus } from "./ai/provider";
import { TurnError, takeTurn } from "./ai/turn";
import type { EditRequest, HealthResponse, MapListResponse, MapState, MapSummary, ServerEvent, StatusResponse } from "./api";
import { StorageError } from "./storage/fsutil";
import {
  abandonLastMessage,
  commitPatch,
  listPatchIds,
  listVersionIds,
  nextPatchId,
  readConversation,
  readGraph,
  readLayout,
  readMeta,
  readNotes,
  readPatch,
  readVersion,
  repairMap,
  restoreTo,
  savePatch,
  updateMeta,
  writeLayout,
  writeNotes,
} from "./storage/map-store";
import { migrateMapFolder } from "./storage/migrate";
import { createMap, listMaps, listTrash, mapsDir, openWorkspace, purgeTrash, restoreFromTrash, saveWorkspaceConfig, trashMap } from "./storage/workspace";
import { findLoops } from "../core/loops";
import { readCachedUsage } from "./claude-usage";
import { TurnJobs } from "./jobs";

export interface AppOptions {
  /** 工作区根目录 */
  root: string;
  provider: AgentProvider;
  now?: () => string;
  /** 全局同时进行的 AI 回合上限（默认 2） */
  maxParallel?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const Choice = z.object({ decision: z.enum(["accepted", "rejected"]), reason: z.string().max(2000).optional() });
const Bodies = {
  createMap: z.object({ topic: z.string().trim().min(1).max(200) }),
  resolve: z.object({ choices: z.union([z.literal("all"), z.record(z.string().regex(/^\d+$/), Choice)]) }),
  edit: z.object({ ops: z.array(PatchOp).min(1).max(50), positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional() }),
  restore: z.object({ version: z.string().regex(/^v\d{3,}$/) }),
  notes: z.object({ text: z.string().max(200_000) }),
  layout: LayoutSchema,
  turn: z.object({ text: z.string().max(20_000).optional() }),
  rename: z.object({ title: z.string().trim().min(1).max(200) }),
  settings: z
    .object({
      effort_short: z.string().max(20).nullable(),
      effort_long: z.string().max(20).nullable(),
      show_new_loops: z.boolean(),
      privacy_notice_seen: z.boolean(),
    })
    .partial(),
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2_000_000) throw new HttpError(413, "请求太大");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求不是合法的 JSON");
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, `请求内容不对：${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  return r.data;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 等待中的 AI 补丁（同一时间最多一个） */
async function pendingPatch(dir: string): Promise<Patch | undefined> {
  for (const id of (await listPatchIds(dir)).reverse()) {
    const p = await readPatch(dir, id);
    if (p.resolution === null) return p;
  }
  return undefined;
}

export async function loadMapState(dir: string, name: string): Promise<MapState> {
  await migrateMapFolder(dir);
  const repairs = await repairMap(dir);
  const versions = await Promise.all((await listVersionIds(dir)).map((id) => readVersion(dir, id)));
  const patches = await Promise.all((await listPatchIds(dir)).map((id) => readPatch(dir, id)));
  const conv = await readConversation(dir);
  return {
    name,
    meta: await readMeta(dir),
    versions,
    patches,
    turns: conv.items,
    skippedTurns: conv.skipped.length,
    layout: await readLayout(dir),
    notes: await readNotes(dir),
    repairs,
  };
}

/** 列表中每个 Map 的概况：变量数、回路数、是否有待处理的建议、是否有没回复的消息 */
async function summarize(name: string, dir: string, meta: MapSummary["meta"]): Promise<MapSummary> {
  const graph = await readGraph(dir);
  const conv = await readConversation(dir);
  return {
    name,
    meta,
    nodes: graph.nodes.filter((n) => n.status === "accepted").length,
    loops: findLoops(graph).loops.length,
    pending: Boolean(await pendingPatch(dir)),
    awaitingReply: conv.items.at(-1)?.role === "user",
  };
}

export function createApp(opts: AppOptions) {
  const { root, provider } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

  // 界面通过 SSE（GET /api/events）接收回合状态和 Map 变化
  const clients = new Set<ServerResponse>();
  const broadcast = (e: ServerEvent) => {
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(data);
  };
  // 清理回收站里超过 30 天的
  void purgeTrash(root, now()).catch(() => undefined);

  // Claude Code CLI 状态：启动时检测一次（需要几秒），之后用缓存；?refresh=1 重新检测
  let health: ProviderStatus | null = null;
  let checking: Promise<void> | null = null;
  const checkHealth = () =>
    (checking ??= provider
      .healthCheck()
      .then((h) => void (health = h))
      .catch((e: Error) => void (health = { ok: false, message: e.message, apiKeyEnvSet: "ANTHROPIC_API_KEY" in process.env }))
      .finally(() => (checking = null)));
  void checkHealth();

  // 每个 Map 一把锁：写操作按顺序执行
  const locks = new Map<string, Promise<unknown>>();
  const withLock = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  };

  const jobs = new TurnJobs({
    provider,
    now,
    config: () => openWorkspace(root),
    withLock,
    maxParallel: opts.maxParallel,
    onChange: () => broadcast({ type: "jobs", jobs: jobs.views() }),
    onMapChanged: (name) => broadcast({ type: "map", name }),
  });
  /** 有进行中的回合时，不能修改这个图（AI 的建议会基于过期版本） */
  const assertIdle = (name: string) => {
    if (jobs.isActive(name)) throw new HttpError(409, "AI 正在这个图里思考，等它回复后再修改，或先取消");
  };

  const mapDir = (raw: string) => {
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, "Map 名称不合法");
    }
    if (!name || name !== basename(name) || name === "." || name === ".." || /[\\/]/.test(name)) throw new HttpError(400, "Map 名称不合法");
    const dir = join(mapsDir(root), name);
    if (!existsSync(join(dir, "map.json"))) throw new HttpError(404, `找不到 Map「${name}」`);
    return { name, dir };
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/api/health") {
      const body: HealthResponse = { ok: true, node: process.version, schemaVersion: SCHEMA_VERSION };
      return json(res, 200, body);
    }
    if (method === "GET" && path === "/api/status") {
      if (url.searchParams.has("refresh")) await checkHealth();
      const body: StatusResponse = {
        workspaceDir: root,
        config: await openWorkspace(root),
        provider: health,
        usage: readCachedUsage(),
        lastRateLimit: provider.lastRateLimit ?? null,
        maxParallel: jobs.maxParallel,
      };
      return json(res, 200, body);
    }
    if (method === "PUT" && path === "/api/settings") {
      const changes = parse(Bodies.settings, await readBody(req));
      const config = { ...(await openWorkspace(root)), ...changes };
      await saveWorkspaceConfig(root, config);
      return json(res, 200, config);
    }
    if (path === "/api/maps") {
      if (method === "GET") {
        await openWorkspace(root);
        const list = await listMaps(root);
        const maps: MapSummary[] = [];
        for (const m of list.maps) {
          try {
            maps.push(await summarize(m.name, m.dir, m.meta));
          } catch (e) {
            list.broken.push({ name: m.name, error: (e as Error).message });
          }
        }
        const body: MapListResponse = { maps, broken: list.broken };
        return json(res, 200, body);
      }
      if (method === "POST") {
        const { topic } = parse(Bodies.createMap, await readBody(req));
        const m = await createMap(root, topic, now());
        return json(res, 200, { name: m.name, meta: m.meta });
      }
    }

    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`data: ${JSON.stringify({ type: "jobs", jobs: jobs.views() } satisfies ServerEvent)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      res.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (method === "GET" && path === "/api/jobs") return json(res, 200, jobs.views());
    if (method === "GET" && path === "/api/trash") return json(res, 200, { entries: await listTrash(root) });
    const tm = path.match(/^\/api\/trash\/([^/]+)\/restore$/);
    if (method === "POST" && tm) {
      const name = await restoreFromTrash(root, decodeURIComponent(tm[1]!));
      broadcast({ type: "maps" });
      return json(res, 200, { ok: true, name });
    }

    const m = path.match(/^\/api\/maps\/([^/]+)(\/.*)?$/);
    if (!m) throw new HttpError(404, "not found");
    const { name, dir } = mapDir(m[1]!);
    const sub = m[2] ?? "";

    if (method === "GET" && sub === "") return json(res, 200, await withLock(name, () => loadMapState(dir, name)));

    // 重命名：只改 map.json 的标题，文件夹名（Map 的 ID）不变
    if (method === "POST" && sub === "/rename") {
      const { title } = parse(Bodies.rename, await readBody(req));
      const meta = await withLock(name, () => updateMeta(dir, { title }, now()));
      broadcast({ type: "maps" });
      return json(res, 200, { ok: true, meta });
    }
    // 删除：移到工作区的 .trash/（可以撤销；30 天后清理）
    if (method === "DELETE" && sub === "") {
      assertIdle(name);
      const entry = await withLock(name, async () => {
        jobs.forget(name);
        return trashMap(root, name, now());
      });
      await purgeTrash(root, now()).catch(() => undefined);
      broadcast({ type: "maps" });
      return json(res, 200, { ok: true, entry });
    }

    if (method === "PUT" && sub === "/layout") {
      const layout = parse(Bodies.layout, await readBody(req));
      await withLock(name, () => writeLayout(dir, layout));
      return json(res, 200, { ok: true });
    }
    if (method === "PUT" && sub === "/notes") {
      const { text } = parse(Bodies.notes, await readBody(req));
      await withLock(name, () => writeNotes(dir, text, now()));
      return json(res, 200, { ok: true });
    }

    // 处理 AI 的建议（逐项接受或拒绝，拒绝可带理由）
    const pm = sub.match(/^\/patches\/(p\d{3,})$/);
    if (method === "POST" && pm) {
      assertIdle(name);
      const { choices } = parse(Bodies.resolve, await readBody(req));
      const r = await withLock(name, () => commitPatch(dir, pm[1]!, choices, now()));
      return json(res, 200, { ok: true, version: r.version?.version ?? null });
    }

    // 用户自己的直接编辑：origin: user 的补丁，自动接受
    if (method === "POST" && sub === "/edit") {
      assertIdle(name);
      const body = parse(Bodies.edit, await readBody(req)) as EditRequest;
      const version = await withLock(name, async () => {
        const pending = await pendingPatch(dir);
        if (pending) throw new HttpError(409, "请先处理 AI 的建议，再修改图");
        const graph = await readGraph(dir);
        const patch = makePatch({ patch_id: await nextPatchId(dir), base_version: graph.version, origin: "user", ops: body.ops }, now());
        resolvePatch(graph, patch, "all", now()); // 先在内存中试一遍：不合法的编辑不保存补丁
        await savePatch(dir, patch);
        const r = await commitPatch(dir, patch.patch_id, "all", now());
        // 新变量的位置：add_node 按顺序分配编号，与新版本中新增的变量一一对应
        if (body.positions && r.version) {
          const old = new Set(graph.nodes.map((n) => n.id));
          const added = r.version.graph.nodes.filter((n) => !old.has(n.id)).map((n) => n.id);
          const refs = body.ops.flatMap((op) => (op.op === "add_node" ? [op.ref] : []));
          const layout = await readLayout(dir);
          refs.forEach((ref, i) => {
            const p = body.positions![ref];
            if (p && added[i]) layout.positions[added[i]!] = { x: Math.round(p.x), y: Math.round(p.y) };
          });
          await writeLayout(dir, layout);
        }
        return r.version?.version ?? null;
      });
      return json(res, 200, { ok: true, version });
    }

    // 放弃对话末尾那条没有回复的消息（可改写后重发）
    if (method === "POST" && sub === "/abandon") {
      assertIdle(name);
      jobs.dismiss(name);
      const t = await withLock(name, () => abandonLastMessage(dir, now()));
      return json(res, 200, { ok: true, turn: t.turn_id });
    }

    // 恢复旧版本：生成一个新版本（历史只增不改）
    if (method === "POST" && sub === "/restore") {
      assertIdle(name);
      const { version } = parse(Bodies.restore, await readBody(req));
      const v = await withLock(name, async () => {
        if (await pendingPatch(dir)) throw new HttpError(409, "请先处理 AI 的建议，再恢复版本");
        return restoreTo(dir, version, now());
      });
      return json(res, 200, { ok: true, version: v.version });
    }

    // AI 回合：在服务端排队执行，立即返回；进度和结果通过 /api/events 推送
    if (method === "POST" && sub === "/turn") {
      const { text } = parse(Bodies.turn, await readBody(req));
      jobs.dismiss(name);
      try {
        await jobs.start(name, dir, text);
      } catch (e) {
        if (e instanceof TurnError) throw new HttpError(409, e.message);
        throw e;
      }
      broadcast({ type: "map", name });
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && sub === "/turn/cancel") return json(res, 200, { ok: jobs.cancel(name) });

    throw new HttpError(404, "not found");
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      const status = e instanceof HttpError ? e.status : e instanceof PatchError || e instanceof StorageError ? 400 : 500;
      if (status === 500) console.error(e);
      json(res, status, { ok: false, error: (e as Error).message });
    });
  };
}
