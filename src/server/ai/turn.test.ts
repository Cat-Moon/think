import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AiOutput } from "../../core/schema";
import { parseStream } from "../claude-cli";
import { classify } from "./claude-provider";
import { FakeProvider } from "./fake-provider";
import { loadSystemPrompt } from "./system-prompt";
import { TurnError, takeTurn } from "./turn";
import { commitPatch, paths, readConversation, readPatch, listPatchIds } from "../storage/map-store";
import { tmpRoot } from "../storage/testutil";
import { createMap } from "../storage/workspace";

const seed: AiOutput = {
  kind: "patch",
  message: "先从三个变量开始，可能不对。",
  question: "你觉得哪个最先发生变化？",
  ops: [
    { op: "set_frame", phenomenon: "总是拖延" },
    { op: "add_node", ref: "$a", label: "焦虑程度" },
    { op: "add_node", ref: "$b", label: "回避行为" },
    { op: "add_node", ref: "$c", label: "任务难度" },
    { op: "add_edge", from: "$a", to: "$b", polarity: "+", rationale: "焦虑时想逃避" },
    { op: "add_edge", from: "$c", to: "$a", polarity: "+", rationale: "难的任务让人焦虑" },
  ],
  possible_duplicates: [],
};
const clarify: AiOutput = { kind: "clarify", message: "这个主题比较宽。", question: "你想弄明白的是哪种变化？", ops: [], possible_duplicates: [] };

const newMap = async () => (await createMap(tmpRoot(), "拖延", "2026-11-08T06:00:00.000Z")).dir;
const opts = { systemPrompt: { text: "测试提示词", sha: "test" } };

describe("takeTurn", () => {
  it("种子补丁：保存用户消息、补丁、AI 回复和调用日志", async () => {
    const dir = await newMap();
    const provider = new FakeProvider([{ output: seed }]);
    const r = await takeTurn(dir, provider, { ...opts, userText: "为什么我总是拖延" });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch).toMatchObject({ patch_id: "p001", base_version: "v000", origin: "ai", turn_id: "t002", resolution: null });
    expect(r.attempts).toHaveLength(1);
    expect(r.usage.inputTokens).toBe(100);
    const { items } = await readConversation(dir);
    expect(items.map((t) => [t.turn_id, t.role, t.kind ?? "", t.patch_id ?? ""])).toEqual([
      ["t001", "user", "", ""],
      ["t002", "ai", "patch", "p001"],
    ]);
    const log = readFileSync(paths(dir).providerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ attempt: 1, ok: true, system_prompt_sha: "test", user_turn: "t001" });
    expect(log[0].prompt).toContain("用户的新消息：为什么我总是拖延");
    expect(provider.requests[0]?.systemPrompt).toBe("测试提示词");
    expect(provider.requests[0]?.timeoutMs).toBe(180_000); // 每次调用的时间上限
  });

  it("澄清问题不产生补丁", async () => {
    const dir = await newMap();
    const r = await takeTurn(dir, new FakeProvider([{ output: clarify }]), { ...opts, userText: "拖延" });
    expect(r.ok && r.patch).toBeNull();
    expect(await listPatchIds(dir)).toEqual([]);
  });

  it("输出没通过检查时，带着问题重试一次", async () => {
    const dir = await newMap();
    const bad = { ...seed, question: "A 吗？B 呢？" };
    const provider = new FakeProvider([{ output: bad }, { output: seed }]);
    const r = await takeTurn(dir, provider, { ...opts, userText: "拖延" });
    expect(r.ok).toBe(true);
    expect(r.attempts.map((a) => a.violations.map((v) => v.code))).toEqual([["multiple_questions"], []]);
    expect(provider.requests[1]?.prompt).toContain("你上一次的输出没有通过检查");
    expect(provider.requests[1]?.prompt).toContain("2 个问号");
  });

  it("重试后仍不合格：不保存补丁，返回输出和问题，用户消息保留", async () => {
    const dir = await newMap();
    const bad: AiOutput = { ...seed, ops: [...seed.ops, { op: "add_edge", from: "n9", to: "$a", polarity: "+", rationale: "" }] }; // 引用不存在的变量
    const r = await takeTurn(dir, new FakeProvider([{ output: bad }, { output: bad }]), { ...opts, userText: "拖延" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid_output");
    expect(r.output).toEqual(bad);
    expect(r.violations?.map((v) => v.code)).toEqual(["invalid_ops"]);
    expect(await listPatchIds(dir)).toEqual([]);
    expect((await readConversation(dir)).items.map((t) => t.role)).toEqual(["user"]);
  });

  it("软性违规不重试，只作为警告返回；保存的文字中内部 ID 已替换", async () => {
    const dir = await newMap();
    const soft: AiOutput = { ...seed, message: "先从三个变量开始，$a 是核心，你觉得呢？" };
    const provider = new FakeProvider([{ output: soft }]);
    const r = await takeTurn(dir, provider, { ...opts, userText: "拖延" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempts).toHaveLength(1);
    expect(r.warnings.map((w) => w.code)).toEqual(["question_in_message", "internal_id"]);
    expect(r.output.message).toBe("先从三个变量开始，「焦虑程度」是核心，你觉得呢？");
    expect((await readPatch(dir, "p001")).message).toBe(r.output.message);
    expect((await readConversation(dir)).items[1]?.text).toBe(r.output.message);
  });

  it("JSON 格式不合法（schema_failure）属于硬性违规：带着校验错误重试一次", async () => {
    const dir = await newMap();
    const provider = new FakeProvider([{ error: { kind: "schema_failure", message: "缺少 kind" } }, { output: seed }]);
    const r = await takeTurn(dir, provider, { ...opts, userText: "拖延" });
    expect(r.ok).toBe(true);
    expect(r.attempts.map((a) => a.error?.kind ?? "ok")).toEqual(["schema_failure", "ok"]);
    expect(provider.requests[1]?.prompt).toContain("不要包在其他字段里");
  });

  it("额度用尽：不重试，用户消息保留；之后不传 userText 即可重试", async () => {
    const dir = await newMap();
    const provider = new FakeProvider([{ error: { kind: "rate_limit", message: "额度用完" } }, { output: seed }]);
    const r1 = await takeTurn(dir, provider, { ...opts, userText: "为什么我总是拖延" });
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.error.kind).toBe("rate_limit");
    expect(r1.attempts).toHaveLength(1);

    const r2 = await takeTurn(dir, provider, opts);
    expect(r2.ok).toBe(true);
    expect(provider.requests[1]?.prompt).toContain("用户的新消息：为什么我总是拖延");
    expect((await readConversation(dir)).items.map((t) => t.role)).toEqual(["user", "ai"]);
  });

  it("超时：不重试，提示可以重试，用户消息保留", async () => {
    const dir = await newMap();
    const r = await takeTurn(dir, new FakeProvider([{ error: { kind: "timeout", message: "超时" } }]), { ...opts, userText: "拖延" });
    expect(!r.ok && r.error.kind).toBe("timeout");
    expect(r.attempts).toHaveLength(1);
    expect((await readConversation(dir)).items.map((t) => t.text)).toEqual(["拖延"]);
  });

  it("思考中可以取消，取消后用户消息保留", async () => {
    const dir = await newMap();
    const ac = new AbortController();
    const pending = takeTurn(dir, new FakeProvider([{ hang: true }]), { ...opts, userText: "拖延", signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const r = await pending;
    expect(!r.ok && r.error.kind).toBe("cancelled");
    expect((await readConversation(dir)).items.map((t) => t.text)).toEqual(["拖延"]);
  });

  it("上一轮的补丁没处理时不能继续；处理后可以", async () => {
    const dir = await newMap();
    const provider = new FakeProvider([{ output: seed }, { output: { ...clarify, kind: "answer", question: "" } }]);
    await takeTurn(dir, provider, { ...opts, userText: "拖延" });
    await expect(takeTurn(dir, provider, { ...opts, userText: "继续" })).rejects.toThrow(TurnError);
    await commitPatch(dir, "p001", "all", "2026-11-08T06:01:00.000Z");
    const r = await takeTurn(dir, provider, { ...opts, userText: "为什么焦虑会导致回避" });
    expect(r.ok).toBe(true);
    expect((await readPatch(dir, "p001")).resolution?.result_version).toBe("v001");
    expect(provider.requests[1]?.prompt).toContain("n1 焦虑程度");
  });

  it("没有可重试的消息时报错", async () => {
    await expect(takeTurn(await newMap(), new FakeProvider([]), opts)).rejects.toThrow(/没有需要重试/);
  });
});

describe("思考程度按回合长短选择", () => {
  it("种子轮用 long；问为什么用 short；显式 effort 优先", async () => {
    const dir = await newMap();
    const provider = new FakeProvider([{ output: seed }, { output: { ...clarify, kind: "answer", question: "" } }, { output: { ...clarify, kind: "answer", question: "" } }]);
    const policy = { short: "low", long: null };
    await takeTurn(dir, provider, { ...opts, userText: "为什么我总是拖延", effortPolicy: policy });
    await commitPatch(dir, "p001", "all", "2026-11-08T06:01:00.000Z");
    await takeTurn(dir, provider, { ...opts, userText: "为什么你认为焦虑会导致回避？", effortPolicy: policy });
    await takeTurn(dir, provider, { ...opts, userText: "继续", effortPolicy: policy, effort: "high" });
    expect(provider.requests.map((r) => r.effort)).toEqual([undefined, "low", "high"]);
  });
});

describe("classify（CLI 结果分类）", () => {
  const run = (stdout: unknown, extra: Partial<Parameters<typeof classify>[0]> = {}) =>
    classify({ exitCode: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", killedBy: null, removedApiKey: false, ...extra });

  it("正常结果", () => {
    expect(run({ is_error: false, structured_output: {} })).toBeNull();
  });
  it("取消与超时", () => {
    expect(run("", { killedBy: "abort" })?.kind).toBe("cancelled");
    expect(run("", { killedBy: "timeout" })?.kind).toBe("timeout");
  });
  it("额度与登录", () => {
    expect(run({ is_error: true, api_error_status: 429, result: "x" })?.kind).toBe("rate_limit");
    expect(run({ is_error: true, result: "Claude usage limit reached" })?.kind).toBe("rate_limit");
    expect(run({ is_error: true, result: "Not logged in · Please run /login" })?.kind).toBe("auth");
  });
  it("stream-json：多次不符合格式时带出校验错误，并记下 AI 提交的参数", () => {
    const lines = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { output: { kind: "patch" } } }] } },
      { type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "root: must have required property 'kind'" }] } },
      { type: "result", subtype: "error_max_structured_output_retries", is_error: true },
    ];
    const stdout = lines.map((l) => JSON.stringify(l)).join("\n");
    const c = run(stdout);
    expect(c?.kind).toBe("schema_failure");
    expect(c?.message).toContain("must have required property 'kind'");
    const p = parseStream(stdout);
    expect(p.structuredAttempts).toEqual(['{"output":{"kind":"patch"}}']);
    expect(p.result?.subtype).toBe("error_max_structured_output_retries");
  });

  it("stream-json：成功时从 result 行取结构化输出", () => {
    const stdout = [{ type: "system" }, { type: "result", subtype: "success", is_error: false, structured_output: { a: 1 } }].map((l) => JSON.stringify(l)).join("\n");
    expect(run(stdout)).toBeNull();
  });

  it("没有结构化输出、不是 JSON", () => {
    expect(run({ is_error: false, result: "我不能回答" })?.kind).toBe("no_output");
    expect(run("Error: boom", { exitCode: 1 })?.kind).toBe("cli_error");
  });
});

describe("系统提示词", () => {
  it("从 prompts/system.md 读取", () => {
    const p = loadSystemPrompt();
    expect(p.text).toContain("Think");
    expect(p.sha).toMatch(/^[0-9a-f]{12}$/);
  });
});
