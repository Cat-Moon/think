// FakeProvider：按顺序返回预设的结果，用于测试和界面开发（不调用真实 AI）。
import { ZERO_USAGE, type AgentProvider, type LLMRequest, type LLMResponse, type ProviderStatus } from "./provider";

export type FakeStep = { output: unknown } | { error: Extract<LLMResponse, { ok: false }>["error"] } | { hang: true };

export class FakeProvider implements AgentProvider {
  name = "fake";
  readonly requests: LLMRequest[] = [];
  private queue: FakeStep[];

  constructor(steps: FakeStep[]) {
    this.queue = [...steps];
  }

  async healthCheck(): Promise<ProviderStatus> {
    return { ok: true, message: "FakeProvider（测试用）", apiKeyEnvSet: false };
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const step = this.queue.shift();
    if (!step) throw new Error("FakeProvider：没有更多预设结果");
    if ("hang" in step) {
      // 一直等到被取消，用来测试"思考中可取消"
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) return resolve();
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: false, error: { kind: "cancelled", message: "已取消" }, durationMs: 0 };
    }
    if ("error" in step) return { ok: false, error: step.error, durationMs: 1 };
    return { ok: true, output: step.output, usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 50 }, durationMs: 1, raw: step.output };
  }
}
