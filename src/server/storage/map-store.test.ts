import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLoops } from "../../core/loops";
import { makePatch, resolvePatch } from "../../core/patch";
import type { PatchOp } from "../../core/schema";
import { nextVersion } from "../../core/version";
import {
  appendTurn,
  checkIntegrity,
  commitPatch,
  listVersionIds,
  nextPatchId,
  openMap,
  paths,
  readConversation,
  readGraph,
  readLayout,
  readNotes,
  readPatch,
  readVersion,
  repairMap,
  restoreTo,
  savePatch,
  updateMeta,
  writeLayout,
  writeNotes,
  writeVersion,
} from "./map-store";
import { tmpRoot } from "./testutil";
import { createMap, defaultWorkspaceDir, forkMap, listMaps, openWorkspace } from "./workspace";

const T = (min: number) => new Date(Date.UTC(2026, 10, 8, 6, min)).toISOString();

const seedOps: PatchOp[] = [
  { op: "set_frame", phenomenon: "总是拖到最后一刻" },
  { op: "add_node", ref: "$a", label: "焦虑程度" },
  { op: "add_node", ref: "$b", label: "回避行为" },
  { op: "add_node", ref: "$c", label: "剩余时间压力" },
  { op: "add_edge", from: "$a", to: "$b", polarity: "+", rationale: "焦虑时更想逃避" },
  { op: "add_edge", from: "$b", to: "$c", polarity: "+", rationale: "拖得越久时间越紧" },
  { op: "add_edge", from: "$c", to: "$a", polarity: "+", rationale: "时间紧加重焦虑" },
];

/** 新建一个 Map 并保存一个 AI 补丁 */
async function mapWithPatch(ops: PatchOp[] = seedOps) {
  const root = tmpRoot();
  const m = await createMap(root, "为什么总是拖延", T(0));
  const g = await readGraph(m.dir);
  const patch = makePatch({ patch_id: await nextPatchId(m.dir), base_version: g.version, origin: "ai", ops }, T(1));
  await savePatch(m.dir, patch);
  return { root, ...m, patch };
}

const snapshot = (dir: string) =>
  Object.fromEntries(readdirSync(paths(dir).versions).map((f) => [f, readFileSync(join(paths(dir).versions, f), "utf8")]));

describe("测试隔离", () => {
  it("默认工作区在测试期间指向临时目录", () => {
    expect(defaultWorkspaceDir().startsWith(tmpdir())).toBe(true);
  });
});

describe("工作区", () => {
  it("openWorkspace 创建 workspace.json 和 maps/", async () => {
    const root = tmpRoot();
    expect(await openWorkspace(root)).toEqual({ schema_version: 1, default_model: "sonnet", effort_short: "low", effort_long: null, privacy_notice_seen: false, show_new_loops: false });
    expect(existsSync(join(root, "maps"))).toBe(true);
  });

  it("createMap 建立完整的文件夹结构", async () => {
    const root = tmpRoot();
    const m = await createMap(root, "为什么总是拖延?", T(0));
    expect(m.name).toMatch(/^\d{4}-\d{2}-\d{2}_为什么总是拖延$/);
    expect(readdirSync(m.dir).sort()).toEqual(["exports", "graph.json", "layout.json", "logs", "map.json", "notes.md", "patches", "versions"]);
    expect(await listVersionIds(m.dir)).toEqual(["v000"]);
    expect((await readGraph(m.dir)).frame.topic).toBe("为什么总是拖延?");
    expect(await checkIntegrity(m.dir)).toEqual([]);
  });

  it("同名主题生成不同的文件夹", async () => {
    const root = tmpRoot();
    const a = await createMap(root, "拖延", T(0));
    const b = await createMap(root, "拖延", T(1));
    expect(b.name).toBe(`${a.name}-2`);
  });

  it("listMaps 按更新时间排序，坏文件夹单独列出", async () => {
    const root = tmpRoot();
    const a = await createMap(root, "甲", T(0));
    await createMap(root, "乙", T(1));
    await updateMeta(a.dir, { archived: true }, T(5));
    writeFileSync(join(root, "maps", "stray.txt"), "");
    rmSync(join(root, "maps", (await createMap(root, "坏的", T(2))).name, "map.json"));

    const list = await listMaps(root);
    expect(list.maps.map((m) => [m.meta.title, m.meta.archived])).toEqual([
      ["甲", true],
      ["乙", false],
    ]);
    expect(list.broken).toHaveLength(1);
  });
});

describe("补丁与版本", () => {
  it("commitPatch：生成 v001，更新 graph.json，补丁标记为已处理", async () => {
    const { dir, patch } = await mapWithPatch();
    const { version } = await commitPatch(dir, patch.patch_id, "all", T(2));

    expect(version?.version).toBe("v001");
    expect(await listVersionIds(dir)).toEqual(["v000", "v001"]);
    const g = await readGraph(dir);
    expect(g.version).toBe("v001");
    expect(findLoops(g).loops.map((l) => l.id)).toEqual(["R1"]);
    expect((await readPatch(dir, "p001")).resolution?.result_version).toBe("v001");
    expect(await checkIntegrity(dir)).toEqual([]);
  });

  it("同一个补丁不能处理两次", async () => {
    const { dir, patch } = await mapWithPatch();
    await commitPatch(dir, patch.patch_id, "all", T(2));
    await expect(commitPatch(dir, patch.patch_id, "all", T(3))).rejects.toThrow(/已经处理过/);
    expect(await listVersionIds(dir)).toEqual(["v000", "v001"]);
  });

  it("全部拒绝：不生成版本，补丁仍记录处理结果", async () => {
    const { dir, patch } = await mapWithPatch();
    const { version } = await commitPatch(dir, patch.patch_id, {}, T(2));
    expect(version).toBeNull();
    expect(await listVersionIds(dir)).toEqual(["v000"]);
    expect((await readPatch(dir, "p001")).resolution?.decisions.every((d) => d.decision === "rejected")).toBe(true);
    expect(await checkIntegrity(dir)).toEqual([]);
  });

  it("补丁不能重复保存", async () => {
    const { dir, patch } = await mapWithPatch();
    await expect(savePatch(dir, patch)).rejects.toThrow(/不能覆盖/);
    expect(await nextPatchId(dir)).toBe("p002");
  });

  it("历史只增不改：版本文件不能覆盖，新版本必须紧接最新版本", async () => {
    const { dir, patch } = await mapWithPatch();
    const { version } = await commitPatch(dir, patch.patch_id, "all", T(2));
    await expect(writeVersion(dir, version!, T(3))).rejects.toThrow(/不是紧接在最新版本/);

    const v0 = await readVersion(dir, "v000");
    const fromOld = nextVersion(v0.graph, v0.graph, null, T(3)); // 基于 v000 的 "v001"
    await expect(writeVersion(dir, fromOld, T(3))).rejects.toThrow(/不是紧接在最新版本/);
  });

  it("恢复旧版本生成一个新版本，已有版本文件一字不改", async () => {
    const { dir, patch } = await mapWithPatch();
    await commitPatch(dir, patch.patch_id, "all", T(2));
    const before = snapshot(dir);

    const v = await restoreTo(dir, "v000", T(3));
    expect(v).toMatchObject({ version: "v002", parent_version: "v001", patch_id: null });
    expect(await listVersionIds(dir)).toEqual(["v000", "v001", "v002"]);
    for (const [f, text] of Object.entries(before)) expect(readFileSync(join(paths(dir).versions, f), "utf8")).toBe(text);

    const g = await readGraph(dir);
    expect(g.nodes.every((n) => n.status === "rejected")).toBe(true); // v001 的内容以 rejected 保留
    expect(findLoops(g).loops).toEqual([]);
    expect(await checkIntegrity(dir)).toEqual([]);
  });

  it("基于过期版本的补丁被拒绝", async () => {
    const { dir, patch } = await mapWithPatch();
    const stale = makePatch({ patch_id: "p002", base_version: "v000", origin: "ai", ops: [{ op: "add_node", ref: "$x", label: "睡眠" }] }, T(1));
    await savePatch(dir, stale);
    await commitPatch(dir, patch.patch_id, "all", T(2));
    await expect(commitPatch(dir, "p002", "all", T(3))).rejects.toThrow(/当前版本是 v001/);
  });
});

describe("崩溃恢复", () => {
  it("写完版本、标记补丁之前崩溃：完整性检查发现，打开 Map 时自动补记为已应用", async () => {
    const { dir, patch } = await mapWithPatch();
    const choices = { 0: { decision: "accepted" }, 1: { decision: "accepted" }, 2: { decision: "accepted" }, 3: { decision: "accepted" }, 4: { decision: "accepted" }, 5: { decision: "accepted" } } as const;
    // 模拟 commitPatch 只完成了前一半：版本写了，补丁没标记（第 7 项被拒绝）
    const { version, patch: expected } = resolvePatch(await readGraph(dir), patch, choices, T(2));
    await writeVersion(dir, version!, T(2));
    expect((await readPatch(dir, patch.patch_id)).resolution).toBeNull();
    expect(await checkIntegrity(dir)).toEqual(["补丁 p001 已产生版本 v001，但仍标记为未处理（可自动修复）"]);

    await openMap(dir);
    const repaired = await readPatch(dir, patch.patch_id);
    expect(repaired.resolution).toEqual({ ...expected.resolution, resolved_at: version!.created_at, recovered: true });
    expect(repaired.resolution?.decisions[6]).toMatchObject({ decision: "rejected" });
    expect(await checkIntegrity(dir)).toEqual([]);
    expect(await repairMap(dir)).toEqual([]); // 再次修复没有可做的
    await expect(commitPatch(dir, patch.patch_id, "all", T(3))).rejects.toThrow(/已经处理过/);
  });
});

describe("graph.json 重建", () => {
  it("缺失、损坏或落后时从 versions/ 重建", async () => {
    const { dir, patch } = await mapWithPatch();
    await commitPatch(dir, patch.patch_id, "all", T(2));

    rmSync(paths(dir).graph);
    expect((await readGraph(dir)).version).toBe("v001");

    writeFileSync(paths(dir).graph, "{ broken");
    expect((await readGraph(dir)).version).toBe("v001");

    // 模拟"写完版本文件、还没写 graph.json 就崩溃"
    writeFileSync(paths(dir).graph, JSON.stringify((await readVersion(dir, "v000")).graph));
    expect(await checkIntegrity(dir)).toEqual(["graph.json 与最新版本 v001 不一致（可重建）"]);
    expect((await readGraph(dir)).version).toBe("v001");
    expect(await checkIntegrity(dir)).toEqual([]);
  });
});

describe("对话记录", () => {
  it("追加并自动编号，关联补丁和版本", async () => {
    const { dir, patch } = await mapWithPatch();
    await appendTurn(dir, { role: "user", text: "为什么总是拖延" }, T(1));
    const ai = await appendTurn(dir, { role: "ai", kind: "patch", text: "先从三个变量开始", question: "你拖延时最常做什么？", patch_id: patch.patch_id }, T(1));
    expect(ai.turn_id).toBe("t002");
    await commitPatch(dir, patch.patch_id, "all", T(2));
    await appendTurn(dir, { role: "system", text: "已接受补丁", version: "v001" }, T(2));

    const { items, skipped } = await readConversation(dir);
    expect(items.map((t) => t.turn_id)).toEqual(["t001", "t002", "t003"]);
    expect(skipped).toEqual([]);
    expect(await checkIntegrity(dir)).toEqual([]);
  });

  it("最后一行写坏时仍能读取并继续追加", async () => {
    const { dir } = await mapWithPatch();
    await appendTurn(dir, { role: "user", text: "第一句" }, T(1));
    writeFileSync(paths(dir).conversation, readFileSync(paths(dir).conversation, "utf8") + '{"turn_id":"t002","role":"ai","te');
    await appendTurn(dir, { role: "user", text: "第三句" }, T(2));

    const { items, skipped } = await readConversation(dir);
    expect(items.map((t) => [t.turn_id, t.text])).toEqual([
      ["t001", "第一句"],
      ["t002", "第三句"],
    ]);
    expect(skipped).toHaveLength(1);
    expect((await checkIntegrity(dir)).some((p) => p.includes("第 2 行无法读取"))).toBe(true);
  });

  it("完整性检查发现引用不存在的补丁或版本", async () => {
    const { dir } = await mapWithPatch();
    await appendTurn(dir, { role: "ai", text: "…", patch_id: "p009", version: "v007" }, T(1));
    expect(await checkIntegrity(dir)).toEqual(["对话 t001 引用的补丁 p009 不存在", "对话 t001 引用的版本 v007 不存在"]);
  });
});

describe("笔记、布局、元信息", () => {
  it("笔记和布局可以读写；布局不更新 updated_at", async () => {
    const { dir } = await mapWithPatch();
    expect(await readNotes(dir)).toBe("");
    await writeNotes(dir, "# 观察\n拖延和焦虑互相加强", T(5));
    expect(await readNotes(dir)).toContain("互相加强");

    const metaBefore = readFileSync(paths(dir).meta, "utf8");
    await writeLayout(dir, { positions: { n1: { x: 10, y: 20 } } });
    expect(await readLayout(dir)).toEqual({ positions: { n1: { x: 10, y: 20 } } });
    expect(readFileSync(paths(dir).meta, "utf8")).toBe(metaBefore);
  });

  it("openMap 先做迁移检查", async () => {
    const { dir } = await mapWithPatch();
    expect((await openMap(dir)).title).toBe("为什么总是拖延");
    const meta = JSON.parse(readFileSync(paths(dir).meta, "utf8"));
    writeFileSync(paths(dir).meta, JSON.stringify({ ...meta, schema_version: 99 }));
    await expect(openMap(dir)).rejects.toThrow(/请先更新 Think/);
  });
});

describe("分叉", () => {
  it("新 Map 的 v001 是源 Map 的最新图，复制笔记和布局，记录来源", async () => {
    const { root, name, dir, patch } = await mapWithPatch();
    await commitPatch(dir, patch.patch_id, "all", T(2));
    await writeNotes(dir, "原来的笔记", T(3));
    await writeLayout(dir, { positions: { n1: { x: 1, y: 2 } } });

    const fork = await forkMap(root, name, T(4));
    expect(fork.meta).toMatchObject({ title: "为什么总是拖延（分叉）", parent: { map: name, version: "v001" } });
    expect(await listVersionIds(fork.dir)).toEqual(["v000", "v001"]);
    const g = await readGraph(fork.dir);
    expect(g.nodes.map((n) => n.label)).toEqual(["焦虑程度", "回避行为", "剩余时间压力"]);
    expect(await readNotes(fork.dir)).toBe("原来的笔记");
    expect((await readLayout(fork.dir)).positions.n1).toEqual({ x: 1, y: 2 });
    expect(await checkIntegrity(fork.dir)).toEqual([]);

    // 两个 Map 之后互不影响
    expect(statSync(paths(dir).graph).isFile()).toBe(true);
    await restoreTo(fork.dir, "v000", T(5));
    expect((await readGraph(dir)).version).toBe("v001");
  });
});
