import { describe, expect, it } from "vitest";
import { printArgs } from "../claude-cli";
import { progressTracker } from "./claude-provider";
import type { Progress } from "./provider";

const delta = (d: Record<string, unknown>) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: d } });

describe("流式进度", () => {
  it("thinking_delta → 思考中；input_json_delta / text_delta → 正在写；同一阶段按时间节流", () => {
    const seen: Progress[] = [];
    let t = 0;
    const onLine = progressTracker((p) => seen.push(p), () => t);
    t = 1000;
    onLine(delta({ type: "thinking_delta", thinking: "让我想想" }));
    t = 1100;
    onLine(delta({ type: "thinking_delta", thinking: "再想想" })); // 250ms 内不重复报告
    t = 1400;
    onLine(delta({ type: "thinking_delta", thinking: "好" }));
    onLine(delta({ type: "input_json_delta", partial_json: '{"kind":' })); // 换阶段立即报告，字数重新计算
    onLine(JSON.stringify({ type: "assistant", message: { content: [] } })); // 其他事件忽略
    onLine("不是 JSON");
    expect(seen).toEqual([
      { phase: "thinking", chars: 4 },
      { phase: "thinking", chars: 8 },
      { phase: "writing", chars: 8 },
    ]);
  });

  it("需要进度时才加 --include-partial-messages", () => {
    const base = { systemPrompt: "s", jsonSchema: {}, model: "sonnet" };
    expect(printArgs(base)).not.toContain("--include-partial-messages");
    expect(printArgs({ ...base, partial: true })).toContain("--include-partial-messages");
  });
});
