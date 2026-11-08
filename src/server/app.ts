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
import type { EditRequest, HealthResponse, MapListResponse, MapState, StatusResponse, TurnStreamEvent } from "./api";
import { StorageError } from "./storage/fsutil";
import {
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
  writeLayout,
  writeNotes,
} from "./storage/map-store";
import { migrateMapFolder } from "./storage/migrate";
import { createMap, listMaps, mapsDir, openWorkspace, saveWorkspaceConfig } from "./storage/workspace";

export interface AppOptions {
  /** 工作区根目录 */
  root: string;
  provider: AgentProvider;
  now?: () => string;
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

export function createApp(opts: AppOptions) {
  const { root, provider } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

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
      const body: StatusResponse = { workspaceDir: root, config: await openWorkspace(root), provider: health };
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
        const body: MapListResponse = { maps: list.maps.map((m) => ({ name: m.name, meta: m.meta })), broken: list.broken };
        return json(res, 200, body);
      }
      if (method === "POST") {
        const { topic } = parse(Bodies.createMap, await readBody(req));
        const m = await createMap(root, topic, now());
        return json(res, 200, { name: m.name, meta: m.meta });
      }
    }

    const m = path.match(/^\/api\/maps\/([^/]+)(\/.*)?$/);
    if (!m) throw new HttpError(404, "not found");
    const { name, dir } = mapDir(m[1]!);
    const sub = m[2] ?? "";

    if (method === "GET" && sub === "") return json(res, 200, await withLock(name, () => loadMapState(dir, name)));

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
      const { choices } = parse(Bodies.resolve, await readBody(req));
      const r = await withLock(name, () => commitPatch(dir, pm[1]!, choices, now()));
      return json(res, 200, { ok: true, version: r.version?.version ?? null });
    }

    // 用户自己的直接编辑：origin: user 的补丁，自动接受
    if (method === "POST" && sub === "/edit") {
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

    // 恢复旧版本：生成一个新版本（历史只增不改）
    if (method === "POST" && sub === "/restore") {
      const { version } = parse(Bodies.restore, await readBody(req));
      const v = await withLock(name, async () => {
        if (await pendingPatch(dir)) throw new HttpError(409, "请先处理 AI 的建议，再恢复版本");
        return restoreTo(dir, version, now());
      });
      return json(res, 200, { ok: true, version: v.version });
    }

    // AI 回合：NDJSON 流式返回进度，最后一行是结果；客户端断开连接即取消（终止 CLI 子进程）
    if (method === "POST" && sub === "/turn") {
      const { text } = parse(Bodies.turn, await readBody(req));
      const ac = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) ac.abort();
      });
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      const send = (e: TurnStreamEvent) => {
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
      };
      try {
        const config = await openWorkspace(root);
        const r = await withLock(name, () =>
          takeTurn(dir, provider, {
            userText: text,
            model: config.default_model,
            effortPolicy: { short: config.effort_short, long: config.effort_long },
            signal: ac.signal,
            onEvent: send,
            now,
          }),
        );
        if (r.ok) send({ type: "done", ok: true, warnings: r.warnings.map((w) => w.message) });
        else send({ type: "done", ok: false, error: r.error, saved: true, violations: r.violations?.map((v) => v.message) });
      } catch (e) {
        const msg = e instanceof TurnError || e instanceof StorageError ? e.message : `出错了：${(e as Error).message}`;
        send({ type: "done", ok: false, error: { kind: "rejected", message: msg }, saved: false });
      }
      res.end();
      return;
    }

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
