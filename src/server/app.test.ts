// HTTP API：用 FakeProvider 和临时工作区走一遍完整流程（不调用真实 CLI，不碰真实工作区）。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AiOutput } from "../core/schema";
import { FakeProvider, type FakeStep } from "./ai/fake-provider";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobView, MapListResponse, MapState, StatusResponse, TrashEntry } from "./api";
import { createApp } from "./app";
import { tmpRoot } from "./storage/testutil";

const seed: AiOutput = {
  kind: "patch",
  message: "先从三个变量开始。",
  question: "你觉得哪个最先变化？",
  ops: [
    { op: "add_node", ref: "$a", label: "焦虑程度" },
    { op: "add_node", ref: "$b", label: "回避行为" },
    { op: "add_node", ref: "$c", label: "任务难度" },
    { op: "add_edge", from: "$a", to: "$b", polarity: "+", rationale: "焦虑时想逃避" },
    { op: "add_edge", from: "$c", to: "$a", polarity: "+", rationale: "难的任务让人焦虑" },
  ],
  possible_duplicates: [],
};

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(steps: FakeStep[], opts: { maxParallel?: number; now?: () => string } = {}) {
  const root = tmpRoot();
  const provider = new FakeProvider(steps);
  const server = createServer(createApp({ root, provider, ...opts }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const jobs = async () => (await call<Record<string, JobView>>("GET", "/api/jobs")).body;
  /** 开始一轮（立即返回）；不能开始时返回状态码和原因 */
  const startTurn = (name: string, text?: string) => call<{ ok?: boolean; error?: string }>("POST", `/api/maps/${encodeURIComponent(name)}/turn`, text === undefined ? {} : { text });
  /** 等到这个图没有进行中的回合；返回失败的记录（成功则为 undefined） */
  const waitIdle = async (name: string) => {
    for (;;) {
      const j = (await jobs())[name];
      if (!j || j.state === "failed") return j;
      await sleep(15);
    }
  };
  /** 开始一轮并等它结束 */
  const turn = async (name: string, text?: string) => {
    const r = await startTurn(name, text);
    if (r.status !== 200) return { started: false as const, status: r.status, error: r.body.error };
    const failed = await waitIdle(name);
    return { started: true as const, ok: !failed, job: failed };
  };
  return { root, provider, base, call, turn, startTurn, waitIdle, jobs };
}

describe("HTTP API", () => {
  it("新建、对话、逐项处理（拒绝带理由）、直接编辑、恢复、布局、笔记", async () => {
    const { call, turn, provider } = await start([{ output: seed }, { output: { ...seed, ops: [], kind: "answer", message: "因为……" } }]);
    const created = await call<{ name: string }>("POST", "/api/maps", { topic: "为什么我总是拖延" });
    expect(created.status).toBe(200);
    const name = created.body.name;
    expect((await call<MapListResponse>("GET", "/api/maps")).body.maps.map((m) => m.name)).toEqual([name]);

    // AI 回合：在服务端排队执行
    expect(await turn(name, "为什么我总是拖延")).toMatchObject({ started: true, ok: true });
    let s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.turns.map((t) => t.role)).toEqual(["user", "ai"]);
    const pending = s.patches.find((p) => p.resolution === null)!;
    expect(pending.patch_id).toBe("p001");

    // 有待处理的建议时，不能直接编辑
    expect((await call("POST", `/api/maps/${encodeURIComponent(name)}/edit`, { ops: [{ op: "add_node", ref: "$x", label: "睡眠" }] })).status).toBe(409);

    // 逐项处理：拒绝第 3 项，带理由
    const resolved = await call<{ version: string }>("POST", `/api/maps/${encodeURIComponent(name)}/patches/p001`, {
      choices: { 0: { decision: "accepted" }, 1: { decision: "accepted" }, 2: { decision: "rejected", reason: "不是主要原因" }, 3: { decision: "accepted" }, 4: { decision: "accepted" } },
    });
    expect(resolved.body.version).toBe("v001");
    s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.patches[0]!.resolution!.decisions[2]).toMatchObject({ decision: "rejected", reason: "不是主要原因" });
    expect(s.patches[0]!.resolution!.decisions[4]).toMatchObject({ decision: "rejected", auto: true }); // 依赖被拒绝的变量

    // 拒绝理由发给 AI
    await turn(name, "为什么焦虑会导致回避？");
    expect(provider.requests[1]!.prompt).toContain("不是主要原因");

    // 直接编辑：走补丁（origin: user，自动接受），新变量的位置写入 layout.json
    const edit = await call<{ version: string }>("POST", `/api/maps/${encodeURIComponent(name)}/edit`, {
      ops: [{ op: "add_node", ref: "$x", label: "睡眠质量" }],
      positions: { $x: { x: 120.4, y: -40 } },
    });
    expect(edit.body.version).toBe("v002");
    s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    const p2 = s.patches.at(-1)!;
    expect(p2).toMatchObject({ origin: "user", resolution: { result_version: "v002" } });
    const sleep = s.versions.at(-1)!.graph.nodes.find((n) => n.label === "睡眠质量")!;
    expect(sleep.origin).toBe("user");
    expect(s.layout.positions[sleep.id]).toEqual({ x: 120, y: -40 });

    // 不合法的编辑：不保存补丁
    const bad = await call<{ error: string }>("POST", `/api/maps/${encodeURIComponent(name)}/edit`, { ops: [{ op: "add_node", ref: "$y", label: "睡眠质量" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("同名");
    expect((await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body.patches).toHaveLength(s.patches.length);

    // 恢复：产生新版本，历史只增不改
    const restored = await call<{ version: string }>("POST", `/api/maps/${encodeURIComponent(name)}/restore`, { version: "v001" });
    expect(restored.body.version).toBe("v003");
    s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.versions.map((v) => v.version)).toEqual(["v000", "v001", "v002", "v003"]);
    expect(s.versions[3]).toMatchObject({ restored_from: "v001" });
    expect(s.versions[3]!.graph.nodes.find((n) => n.id === sleep.id)?.status).toBe("rejected");

    // 布局和笔记
    await call("PUT", `/api/maps/${encodeURIComponent(name)}/layout`, { positions: { n1: { x: 1, y: 2 } } });
    await call("PUT", `/api/maps/${encodeURIComponent(name)}/notes`, { text: "先观察一周" });
    s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.layout.positions).toEqual({ n1: { x: 1, y: 2 } });
    expect(s.notes).toBe("先观察一周");
  });

  it("设置写入 workspace.json", async () => {
    const { call } = await start([]);
    const st = (await call<StatusResponse>("GET", "/api/status")).body;
    expect(st.config).toMatchObject({ effort_short: "low", effort_long: null, show_new_loops: false, privacy_notice_seen: false });
    await call("PUT", "/api/settings", { show_new_loops: true, privacy_notice_seen: true, effort_long: "medium" });
    expect((await call<StatusResponse>("GET", "/api/status")).body.config).toMatchObject({ show_new_loops: true, privacy_notice_seen: true, effort_long: "medium", effort_short: "low" });
    expect((await call("PUT", "/api/settings", { show_new_loops: "yes" })).status).toBe(400);
  });

  it("取消：终止调用，用户消息已保存，之后可以重试；进行中不能修改图", async () => {
    const { call, turn, startTurn, waitIdle, jobs } = await start([{ hang: true }, { output: seed }]);
    const { name } = (await call<{ name: string }>("POST", "/api/maps", { topic: "拖延" })).body;
    expect((await startTurn(name, "为什么我总是拖延")).status).toBe(200);
    await sleep(50);
    expect((await jobs())[name]).toMatchObject({ state: "running" });
    // 进行中也能马上打开这个图，看到已保存的消息（读取不等 AI 回复）
    const t0 = Date.now();
    const during = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(during.turns.map((t) => t.role)).toEqual(["user"]);
    // 进行中：不能再发、不能编辑、不能删除
    expect((await startTurn(name, "再来一条")).status).toBe(409);
    expect((await call("POST", `/api/maps/${encodeURIComponent(name)}/edit`, { ops: [{ op: "add_node", ref: "$x", label: "睡眠" }] })).status).toBe(409);
    expect((await call("DELETE", `/api/maps/${encodeURIComponent(name)}`)).status).toBe(409);
    await call("POST", `/api/maps/${encodeURIComponent(name)}/turn/cancel`);
    expect(await waitIdle(name)).toMatchObject({ state: "failed", error: { kind: "cancelled" } });
    let s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.turns.map((t) => t.role)).toEqual(["user"]); // 输入没有丢

    expect(await turn(name)).toMatchObject({ ok: true }); // 重试：不带新消息
    expect((await jobs())[name]).toBeUndefined();
    s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "为什么我总是拖延"],
      ["ai", seed.message],
    ]);
  });

  it("失败时返回原因和 saved；名称不合法或不存在时报错", async () => {
    const { call, turn } = await start([{ error: { kind: "rate_limit", message: "额度用完" } }]);
    const { name } = (await call<{ name: string }>("POST", "/api/maps", { topic: "拖延" })).body;
    expect(await turn(name, "你好")).toMatchObject({ started: true, ok: false, job: { state: "failed", error: { kind: "rate_limit" } } });
    expect((await call<MapListResponse>("GET", "/api/maps")).body.maps[0]).toMatchObject({ awaitingReply: true });
    expect(await turn(name, "   ")).toMatchObject({ started: false, status: 409, error: "消息不能为空" });
    expect((await call("GET", "/api/maps/..%2F..")).status).toBe(400);
    expect((await call("GET", "/api/maps/nope")).status).toBe(404);
  });
});

describe("放弃没有回复的消息", () => {
  it("放弃后不能重试、可以发新消息；被放弃的消息不发给 AI；额度用完时带上重置时间", async () => {
    const resetsAt = "2026-11-09T05:30:00.000Z";
    const { call, turn, provider } = await start([{ error: { kind: "rate_limit", message: "额度用完", resetsAt } }, { output: seed }]);
    const { name } = (await call<{ name: string }>("POST", "/api/maps", { topic: "拖延" })).body;
    expect(await turn(name, "这条会失败")).toMatchObject({ ok: false, job: { error: { kind: "rate_limit", resetsAt } } });

    expect((await call("POST", `/api/maps/${encodeURIComponent(name)}/abandon`)).status).toBe(200);
    let s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.turns.map((t) => [t.role, t.abandoned_turn ?? null])).toEqual([
      ["user", null],
      ["system", "t001"],
    ]);
    expect(await turn(name)).toMatchObject({ started: false, status: 409 }); // 没有可以重试的消息
    expect((await call("POST", `/api/maps/${encodeURIComponent(name)}/abandon`)).status).toBe(400); // 也没有可以放弃的

    expect(await turn(name, "改写后的消息")).toMatchObject({ ok: true });
    const prompt = provider.requests.at(-1)!.prompt;
    expect(prompt).toContain("改写后的消息");
    expect(prompt).not.toContain("这条会失败");
    s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.turns.map((t) => t.role)).toEqual(["user", "system", "user", "ai"]);
  });
});

describe("工作台：多个图并行、排队", () => {
  it("全局最多 2 个回合同时进行，其余排队；取消排队中的不会调用 AI；结束后排队的接着执行", async () => {
    const clarify: AiOutput = { kind: "clarify", message: "先确认一下。", question: "你指的是哪种变化？", ops: [], possible_duplicates: [] };
    const { call, startTurn, waitIdle, jobs, provider } = await start([{ hang: true }, { hang: true }, { output: clarify }]);
    const names: string[] = [];
    for (const t of ["房价", "拖延", "交通", "选举"]) names.push((await call<{ name: string }>("POST", "/api/maps", { topic: t })).body.name);
    const [a, b, c, d] = names as [string, string, string, string];
    for (const n of names) expect((await startTurn(n, "你好")).status).toBe(200);
    await sleep(50);
    let j = await jobs();
    expect([j[a]!.state, j[b]!.state, j[c]!.state, j[d]!.state]).toEqual(["running", "running", "queued", "queued"]);
    expect([j[c]!.position, j[d]!.position]).toEqual([1, 2]);
    expect(provider.requests).toHaveLength(2);

    // 取消排队中的 d：不调用 AI，消息已保存，可以重试或放弃
    await call("POST", `/api/maps/${encodeURIComponent(d)}/turn/cancel`);
    j = await jobs();
    expect(j[d]).toMatchObject({ state: "failed", error: { kind: "cancelled" } });
    expect((await call<MapState>("GET", `/api/maps/${encodeURIComponent(d)}`)).body.turns.map((t) => t.role)).toEqual(["user"]);

    // 取消 a：c 接着执行（拿到 clarify），b 仍在执行
    await call("POST", `/api/maps/${encodeURIComponent(a)}/turn/cancel`);
    expect(await waitIdle(c)).toBeUndefined();
    expect((await jobs())[b]).toMatchObject({ state: "running" });
    expect(provider.requests).toHaveLength(3);
    await call("POST", `/api/maps/${encodeURIComponent(b)}/turn/cancel`);
    expect(await waitIdle(b)).toMatchObject({ error: { kind: "cancelled" } });
    expect((await call<MapState>("GET", `/api/maps/${encodeURIComponent(c)}`)).body.turns.map((t) => t.role)).toEqual(["user", "ai"]);
  });

  it("列表概况：变量数、回路数、待处理的建议", async () => {
    const { call, turn } = await start([{ output: seed }]);
    const { name } = (await call<{ name: string }>("POST", "/api/maps", { topic: "拖延" })).body;
    await turn(name, "为什么我总是拖延");
    let m = (await call<MapListResponse>("GET", "/api/maps")).body.maps[0]!;
    expect(m).toMatchObject({ nodes: 0, loops: 0, pending: true, awaitingReply: false });
    await call("POST", `/api/maps/${encodeURIComponent(name)}/patches/p001`, { choices: "all" });
    await call("POST", `/api/maps/${encodeURIComponent(name)}/edit`, { ops: [{ op: "add_edge", from: "n2", to: "n1", polarity: "+", rationale: "" }] });
    m = (await call<MapListResponse>("GET", "/api/maps")).body.maps[0]!;
    expect(m).toMatchObject({ nodes: 3, loops: 1, pending: false });
  });
});

describe("工作台：重命名、删除到回收站、撤销", () => {
  it("重命名只改标题；删除移到 .trash/，可以撤销；超过 30 天的清理掉", async () => {
    let clock = "2026-11-09T01:00:00.000Z";
    const { call, root } = await start([], { now: () => clock });
    const { name } = (await call<{ name: string }>("POST", "/api/maps", { topic: "拖延" })).body;
    expect((await call("POST", `/api/maps/${encodeURIComponent(name)}/rename`, { title: "为什么我总是拖延" })).status).toBe(200);
    expect((await call<MapListResponse>("GET", "/api/maps")).body.maps.map((m) => [m.name, m.meta.title])).toEqual([[name, "为什么我总是拖延"]]);

    const del = await call<{ entry: string }>("DELETE", `/api/maps/${encodeURIComponent(name)}`);
    expect(del.status).toBe(200);
    expect((await call<MapListResponse>("GET", "/api/maps")).body.maps).toEqual([]);
    expect(existsSync(join(root, ".trash", del.body.entry, "map.json"))).toBe(true); // 文件还在
    const trash = (await call<{ entries: TrashEntry[] }>("GET", "/api/trash")).body.entries;
    expect(trash).toMatchObject([{ name, title: "为什么我总是拖延", deletedAt: clock }]);

    // 撤销
    expect((await call<{ name: string }>("POST", `/api/trash/${encodeURIComponent(del.body.entry)}/restore`)).body.name).toBe(name);
    expect((await call<MapListResponse>("GET", "/api/maps")).body.maps).toHaveLength(1);
    expect((await call("POST", "/api/trash/..%2Fmaps/restore")).status).toBe(400);

    // 删除后 31 天：下次删除时清理旧的
    const old = (await call<{ entry: string }>("DELETE", `/api/maps/${encodeURIComponent(name)}`)).body.entry;
    clock = "2026-12-10T01:00:00.000Z";
    const other = (await call<{ name: string }>("POST", "/api/maps", { topic: "交通" })).body.name;
    await call("DELETE", `/api/maps/${encodeURIComponent(other)}`);
    const left = readdirSync(join(root, ".trash"));
    expect(left).not.toContain(old);
    expect(left).toHaveLength(1);
  });
});

describe("额度信息（不调用模型）", () => {
  it("读取 Claude Code 本地缓存中的利用率和重置时间；没有或格式不对时为 null", async () => {
    const file = join(tmpRoot(), "claude.json");
    process.env.THINK_CLAUDE_STATE = file;
    try {
      const { call } = await start([]);
      expect((await call<StatusResponse>("GET", "/api/status")).body.usage).toBeNull();
      writeFileSync(
        file,
        JSON.stringify({
          oauthAccount: { emailAddress: "不应被读取" },
          cachedUsageUtilization: { fetchedAtMs: Date.parse("2026-11-08T07:46:48.520Z"), utilization: { five_hour: { utilization: 93, resets_at: "2026-11-08T10:30:00.583824+00:00" }, seven_day: { utilization: 46, resets_at: null } } },
        }),
      );
      const st = (await call<StatusResponse>("GET", "/api/status")).body;
      expect(st.usage).toEqual({ fiveHour: { utilization: 93, resetsAt: "2026-11-08T10:30:00.583Z" }, sevenDay: { utilization: 46, resetsAt: null }, fetchedAt: "2026-11-08T07:46:48.520Z" });
      expect(JSON.stringify(st)).not.toContain("不应被读取");
      expect(st.maxParallel).toBe(2);
    } finally {
      delete process.env.THINK_CLAUDE_STATE;
    }
  });
});
