// Think 服务端入口：只监听本机。
// 环境变量：THINK_WORKSPACE 工作区目录（默认 ~/Documents/Think）；THINK_PORT 端口（默认 5174）；
// THINK_FAKE=<json 文件> 用预设结果代替真实 CLI（界面开发、截图用，不消耗额度）。
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { ClaudeCodeProvider } from "./ai/claude-provider";
import { FakeProvider, type FakeStep } from "./ai/fake-provider";
import type { AgentProvider } from "./ai/provider";
import { createApp } from "./app";
import { defaultWorkspaceDir } from "./storage/workspace";

const PORT = Number(process.env.THINK_PORT) || 5174;
const root = defaultWorkspaceDir();
const fake = process.env.THINK_FAKE;
const provider: AgentProvider = fake ? new FakeProvider(JSON.parse(readFileSync(fake, "utf8")) as FakeStep[]) : new ClaudeCodeProvider();

createServer(createApp({ root, provider })).listen(PORT, "127.0.0.1", () => {
  console.log(`Think server: http://127.0.0.1:${PORT}（工作区：${root}${fake ? "；FakeProvider" : ""}）`);
});
