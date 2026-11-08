import { describe, expect, it } from "vitest";
import { failureText } from "./Chat";

describe("AI 回合失败时按类型说明原因", () => {
  it("每种类型都有自己的标题；其他错误至少有一行原因", () => {
    expect(failureText({ kind: "cancelled", message: "已取消" })).toEqual({ title: "已取消" });
    expect(failureText({ kind: "timeout", message: "x" }).title).toBe("超时");
    expect(failureText({ kind: "auth", message: "x" }).title).toBe("Claude Code 未登录");
    expect(failureText({ kind: "rate_limit", message: "x" })).toMatchObject({ title: "额度用完", detail: expect.stringContaining("稍后再试") });
    const reset = new Date();
    reset.setHours(17, 5, 0, 0);
    expect(failureText({ kind: "rate_limit", message: "x", resetsAt: reset.toISOString() }).detail).toContain("17:05 重置");
    expect(failureText({ kind: "invalid_output", message: "没通过", violations: ["问题字段里有 2 个问号"] }).detail).toBe("问题字段里有 2 个问号");
    const other = failureText({ kind: "cli_error", message: `调用 Claude Code 时出错：spawn EPERM\n第二行细节` });
    expect(other).toEqual({ title: "出错了", detail: "调用 Claude Code 时出错：spawn EPERM" });
    expect(failureText({ kind: "rejected", message: "请先处理上一轮的建议（p003）" }).detail).toBe("请先处理上一轮的建议（p003）");
  });
});
