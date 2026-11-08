// HTTP API：用 FakeProvider 和临时工作区走一遍完整流程（不调用真实 CLI，不碰真实工作区）。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AiOutput } from "../core/schema";
import { FakeProvider, type FakeStep } from "./ai/fake-provider";
import type { MapListResponse, MapState, StatusResponse, TurnStreamEvent } from "./api";
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

async function start(steps: FakeStep[]) {
  const root = tmpRoot();
  const provider = new FakeProvider(steps);
  const server = createServer(createApp({ root, provider }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const turn = async (name: string, text?: string, signal?: AbortSignal): Promise<TurnStreamEvent[]> => {
    const res = await fetch(`${base}/api/maps/${encodeURIComponent(name)}/turn`, { method: "POST", body: JSON.stringify(text === undefined ? {} : { text }), signal });
    return (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as TurnStreamEvent);
  };
  return { root, provider, base, call, turn };
}

describe("HTTP API", () => {
  it("新建、对话、逐项处理（拒绝带理由）、直接编辑、恢复、布局、笔记", async () => {
    const { call, turn, provider } = await start([{ output: seed }, { output: { ...seed, ops: [], kind: "answer", message: "因为……" } }]);
    const created = await call<{ name: string }>("POST", "/api/maps", { topic: "为什么我总是拖延" });
    expect(created.status).toBe(200);
    const name = created.body.name;
    expect((await call<MapListResponse>("GET", "/api/maps")).body.maps.map((m) => m.name)).toEqual([name]);

    // AI 回合：流式进度 + 最后一行结果
    const events = await turn(name, "为什么我总是拖延");
    expect(events[0]).toMatchObject({ type: "attempt", attempt: 1 });
    expect(events.some((e) => e.type === "progress")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
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

  it("取消：断开连接即终止调用，用户消息已保存，之后可以重试", async () => {
    const { call, turn } = await start([{ hang: true }, { output: seed }]);
    const { name } = (await call<{ name: string }>("POST", "/api/maps", { topic: "拖延" })).body;
    const ac = new AbortController();
    const pending = turn(name, "为什么我总是拖延", ac.signal).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    expect(await pending).toBeInstanceOf(Error);
    await new Promise((r) => setTimeout(r, 100));
    let s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.turns.map((t) => t.role)).toEqual(["user"]); // 输入没有丢

    const events = await turn(name); // 重试：不带新消息
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
    s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "为什么我总是拖延"],
      ["ai", seed.message],
    ]);
  });

  it("失败时返回原因和 saved；名称不合法或不存在时报错", async () => {
    const { call, turn } = await start([{ error: { kind: "rate_limit", message: "额度用完" } }]);
    const { name } = (await call<{ name: string }>("POST", "/api/maps", { topic: "拖延" })).body;
    expect((await turn(name, "你好")).at(-1)).toMatchObject({ type: "done", ok: false, saved: true, error: { kind: "rate_limit" } });
    expect((await turn(name, "   ")).at(-1)).toMatchObject({ type: "done", ok: false, saved: false });
    expect((await call("GET", "/api/maps/..%2F..")).status).toBe(400);
    expect((await call("GET", "/api/maps/nope")).status).toBe(404);
  });
});

describe("放弃没有回复的消息", () => {
  it("放弃后不能重试、可以发新消息；被放弃的消息不发给 AI；额度用完时带上重置时间", async () => {
    const resetsAt = "2026-11-09T05:30:00.000Z";
    const { call, turn, provider } = await start([{ error: { kind: "rate_limit", message: "额度用完", resetsAt } }, { output: seed }]);
    const { name } = (await call<{ name: string }>("POST", "/api/maps", { topic: "拖延" })).body;
    expect((await turn(name, "这条会失败")).at(-1)).toMatchObject({ type: "done", ok: false, error: { kind: "rate_limit", resetsAt } });

    expect((await call("POST", `/api/maps/${encodeURIComponent(name)}/abandon`)).status).toBe(200);
    let s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.turns.map((t) => [t.role, t.abandoned_turn ?? null])).toEqual([
      ["user", null],
      ["system", "t001"],
    ]);
    expect((await turn(name)).at(-1)).toMatchObject({ ok: false, saved: false }); // 没有可以重试的消息
    expect((await call("POST", `/api/maps/${encodeURIComponent(name)}/abandon`)).status).toBe(400); // 也没有可以放弃的

    expect((await turn(name, "改写后的消息")).at(-1)).toMatchObject({ ok: true });
    const prompt = provider.requests.at(-1)!.prompt;
    expect(prompt).toContain("改写后的消息");
    expect(prompt).not.toContain("这条会失败");
    s = (await call<MapState>("GET", `/api/maps/${encodeURIComponent(name)}`)).body;
    expect(s.turns.map((t) => t.role)).toEqual(["user", "system", "user", "ai"]);
  });
});
