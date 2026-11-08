// 冒烟测试：确认 claude -p 能接受 AI 输出的 JSON Schema 并返回合格的结构化输出。
// 用法：npx tsx scripts/smoke-cli.ts [model]
// 注意：会真实调用一次 Claude（消耗少量订阅额度）。
import { AiOutput, aiOutputJsonSchema } from "../src/core/schema";
import { ClaudeCodeProvider } from "../src/server/ai/claude-provider";

const model = process.argv[2] ?? "sonnet";
const provider = new ClaudeCodeProvider();
console.log((await provider.healthCheck()).message);

const res = await provider.complete({
  model,
  jsonSchema: aiOutputJsonSchema(),
  systemPrompt: "You only output data in the required JSON structure. Variable labels are neutral nouns. New nodes use refs like $a.",
  prompt: "主题：房价。当前图为空。请生成种子补丁：kind=patch，3 个 add_node 和 2 到 3 条 add_edge，question 只问一个问题。",
});
if (!res.ok) {
  console.log("失败：", res.error);
  process.exit(1);
}
console.log(`用时 ${(res.durationMs / 1000).toFixed(1)}s，tokens 入 ${res.usage.inputTokens} / 出 ${res.usage.outputTokens}`);
const parsed = AiOutput.safeParse(res.output);
console.log(parsed.success ? `zod 校验通过：${parsed.data.ops.length} 项操作` : parsed.error.issues);
