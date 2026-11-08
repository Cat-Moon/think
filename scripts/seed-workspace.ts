// 生成一个用于界面检查和截图的工作区：示例图（含一个待处理的 AI 建议）和 M3 回归中真实生成的 16 张图。
// 用法：npx tsx scripts/seed-workspace.ts <目录>（目录必须不存在或为空；不要指向真实工作区）
// 生成 <目录>/seed-index.json：{ "demo": 文件夹名, "0": 文件夹名, … }
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Graph as GraphSchema } from "../src/core/schema";
import { nextVersion } from "../src/core/version";
import { writeJson } from "../src/server/storage/fsutil";
import { paths, readGraph, savePatch, writeVersion } from "../src/server/storage/map-store";
import { createMap, openWorkspace, saveWorkspaceConfig } from "../src/server/storage/workspace";
import { demoState } from "../src/web/demo";
import fixtures from "../src/web/fixtures/real-graphs.json";

const root = process.argv[2];
if (!root) throw new Error("用法：npx tsx scripts/seed-workspace.ts <目录>");
if (existsSync(root) && readdirSync(root).length) throw new Error(`${root} 不是空目录`);

const now = () => new Date().toISOString();
const config = await openWorkspace(root);
await saveWorkspaceConfig(root, { ...config, privacy_notice_seen: true });
const index: Record<string, string> = {};

// 示例图：按 demo.ts 中的补丁一步步生成的版本和补丁
const demo = demoState();
const d = await createMap(root, demo.versions[0]!.graph.frame.topic, now());
for (const v of demo.versions.slice(1)) await writeVersion(d.dir, v, now());
for (const p of demo.patches) await writeJson(paths(d.dir).patch(p.patch_id), p);
if (demo.pending) await savePatch(d.dir, demo.pending);
index.demo = d.name;

// 真实生成的图：v001 为图的内容
for (const [i, f] of (fixtures as { name: string; graph: unknown }[]).entries()) {
  const graph = GraphSchema.parse(f.graph);
  const m = await createMap(root, `#${i} ${f.name}`, now());
  await writeVersion(m.dir, nextVersion(await readGraph(m.dir), graph, null, now()), now());
  index[String(i)] = m.name;
}
writeFileSync(join(root, "seed-index.json"), JSON.stringify(index, null, 2));
console.log(`已生成 ${Object.keys(index).length} 个 Map：${root}`);
