// 冒烟测试：确认 claude -p 能接受 AI 输出的 JSON Schema 并返回合格的结构化输出。
// 用法：npx tsx scripts/smoke-cli.ts [model]
// 注意：会真实调用一次 Claude（消耗少量订阅额度）。
import { AiOutput, aiOutputJsonSchema } from "../src/core/schema";
import { callClaude } from "../src/server/claude-cli";

const model = process.argv[2] ?? "sonnet";

const systemPrompt = [
  "You are the assistant inside Think, a systems-thinking tool.",
  "You only output data in the required JSON structure. Never compute loop polarity.",
  "Variable labels are neutral nouns that can go up or down (e.g. 房价, not 房价上涨).",
  "New nodes use temporary refs like $a, $b; edges may reference those refs.",
  "Reply in the user's language.",
].join("\n");

const prompt = [
  "主题：房价",
  "当前图为空（v000）。",
  "请生成一个种子补丁：kind=patch，恰好 3 个 add_node 和 2 到 3 条 add_edge，最多一条回路。",
  "message 简短说明这只是起点，question 只问一个问题。",
].join("\n");

const t0 = Date.now();
const raw = await callClaude({ systemPrompt, prompt, jsonSchema: aiOutputJsonSchema(), model });
console.log(`exit=${raw.exitCode} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s 移除了API_KEY=${raw.removedApiKey}`);
if (raw.stderr.trim()) console.log("stderr:", raw.stderr.trim().slice(0, 1000));
if (!raw.json) {
  console.log("stdout 不是 JSON：", raw.stdout.slice(0, 2000));
  process.exit(1);
}

const { subtype, is_error, api_error_status, num_turns, usage, structured_output, result } = raw.json as Record<string, any>;
console.log({ subtype, is_error, api_error_status, num_turns, input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens });

if (structured_output === undefined) {
  console.log("没有 structured_output。result =", String(result).slice(0, 2000));
  process.exit(1);
}

console.log("structured_output:\n" + JSON.stringify(structured_output, null, 2));
const parsed = AiOutput.safeParse(structured_output);
if (!parsed.success) {
  console.log("zod 校验失败：", JSON.stringify(parsed.error.issues, null, 2));
  process.exit(1);
}
const ops = parsed.data.ops;
console.log(
  `zod 校验通过：kind=${parsed.data.kind}，add_node=${ops.filter((o) => o.op === "add_node").length}，add_edge=${ops.filter((o) => o.op === "add_edge").length}`,
);
