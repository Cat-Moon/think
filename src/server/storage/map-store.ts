// 一个 Map 文件夹的读写（设计文档第 9.4 节）。
//
// 规则：
// - 以 versions/ 为准；graph.json 是最新版本的副本，缺失或不一致时从 versions/ 重建
// - 历史只增不改：版本文件一旦写入就不能覆盖；恢复旧版本也是生成一个新版本
// - 补丁文件只允许从"未处理"更新为"已处理"一次
// - conversation.jsonl 只追加
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { firstSeqId, idNumber, nextSeqId } from "../../core/ids";
import { resolvePatch, type Choices } from "../../core/patch";
import {
  Graph as GraphSchema,
  Layout as LayoutSchema,
  MapMeta as MapMetaSchema,
  Patch as PatchSchema,
  SCHEMA_VERSION,
  Turn as TurnSchema,
  Version as VersionSchema,
  type Graph,
  type Layout,
  type MapMeta,
  type Patch,
  type Turn,
  type Version,
} from "../../core/schema";
import { initialVersion, nextVersion, restoreVersion } from "../../core/version";
import { StorageError, appendJsonl, atomicWrite, readFileRetry, readJson, readJsonl, writeJson, writeJsonNew, type JsonlResult } from "./fsutil";
import { migrateMapFolder } from "./migrate";

export const paths = (dir: string) => ({
  meta: join(dir, "map.json"),
  graph: join(dir, "graph.json"),
  layout: join(dir, "layout.json"),
  notes: join(dir, "notes.md"),
  conversation: join(dir, "conversation.jsonl"),
  versions: join(dir, "versions"),
  version: (id: string) => join(dir, "versions", `${id}.json`),
  patches: join(dir, "patches"),
  patch: (id: string) => join(dir, "patches", `${id}.json`),
  exports: join(dir, "exports"),
  logs: join(dir, "logs"),
  providerLog: join(dir, "logs", "provider.jsonl"),
});

// ---------- 创建 ----------

async function makeSkeleton(dir: string): Promise<void> {
  if (existsSync(dir)) throw new StorageError("文件夹已存在", dir);
  const p = paths(dir);
  for (const d of [p.versions, p.patches, p.exports, p.logs]) await mkdir(d, { recursive: true });
  await writeJson(p.layout, LayoutSchema.parse({}));
}

export async function createMapFolder(dir: string, topic: string, now: string): Promise<MapMeta> {
  await makeSkeleton(dir);
  const meta = MapMetaSchema.parse({ schema_version: SCHEMA_VERSION, title: topic, created_at: now, updated_at: now });
  const v0 = initialVersion(topic, now);
  await writeJsonNew(paths(dir).version(v0.version), v0);
  await writeJson(paths(dir).graph, v0.graph);
  await atomicWrite(paths(dir).notes, "");
  await writeJson(paths(dir).meta, meta); // 最后写 map.json：有它才算一个完整的 Map
  return meta;
}

/** 分叉：v000 为空图（主题沿用），v001 为源 Map 最新版本的内容；复制 layout 和 notes */
export async function forkMapFolder(srcDir: string, srcName: string, dir: string, title: string, now: string): Promise<MapMeta> {
  await openMap(srcDir); // 先确保源 Map 的格式是当前版本
  const latest = await readGraph(srcDir);
  await makeSkeleton(dir);
  const v0 = initialVersion(latest.frame.topic, now);
  const v1 = nextVersion(v0.graph, latest, null, now);
  await writeJsonNew(paths(dir).version(v0.version), v0);
  await writeJsonNew(paths(dir).version(v1.version), v1);
  await writeJson(paths(dir).graph, v1.graph);
  await copyFile(paths(srcDir).layout, paths(dir).layout).catch(() => undefined);
  await copyFile(paths(srcDir).notes, paths(dir).notes).catch(() => atomicWrite(paths(dir).notes, ""));
  const meta = MapMetaSchema.parse({
    schema_version: SCHEMA_VERSION,
    title,
    created_at: now,
    updated_at: now,
    parent: { map: srcName, version: latest.version },
  });
  await writeJson(paths(dir).meta, meta);
  return meta;
}

// ---------- 元信息 ----------

export async function readMeta(dir: string): Promise<MapMeta> {
  return readJson(paths(dir).meta, MapMetaSchema);
}

/** 打开 Map：先检查并执行 schema 迁移，再自动修复可修复的不一致，最后读元信息 */
export async function openMap(dir: string): Promise<MapMeta> {
  await migrateMapFolder(dir);
  await repairMap(dir);
  return readMeta(dir);
}

/**
 * 自动修复崩溃留下的不一致，返回做了哪些修复：
 * - 补丁已经产生了版本，但补丁文件仍是"未处理"（写完版本、标记补丁之前崩溃）：
 *   按版本文件中记下的决定，把补丁标记为已应用（recovered: true）
 * - graph.json 与最新版本不一致：从 versions/ 重建
 */
export async function repairMap(dir: string): Promise<string[]> {
  const repairs: string[] = [];
  const patchIds = new Set(await listPatchIds(dir));
  for (const id of await listVersionIds(dir)) {
    const v = await readVersion(dir, id);
    if (!v.patch_id || !patchIds.has(v.patch_id)) continue;
    const p = await readPatch(dir, v.patch_id);
    if (p.resolution !== null) continue;
    const resolved = PatchSchema.parse({
      ...p,
      resolution: { resolved_at: v.created_at, decisions: v.decisions ?? [], result_version: v.version, recovered: true },
    });
    await writeJson(paths(dir).patch(p.patch_id), resolved);
    repairs.push(`补丁 ${p.patch_id} 已产生版本 ${v.version}，已补记为已应用`);
  }
  const latest = await latestVersionId(dir);
  const g = await readJson(paths(dir).graph, GraphSchema).catch(() => null);
  if (g?.version !== latest) {
    await rebuildGraph(dir);
    repairs.push(`graph.json 已从 ${latest} 重建`);
  }
  return repairs;
}

export async function updateMeta(dir: string, changes: Partial<Pick<MapMeta, "title" | "archived">>, now: string): Promise<MapMeta> {
  const meta = { ...(await readMeta(dir)), ...changes, updated_at: now };
  await writeJson(paths(dir).meta, MapMetaSchema.parse(meta));
  return meta;
}

async function touch(dir: string, now: string): Promise<void> {
  await updateMeta(dir, {}, now);
}

// ---------- 版本 ----------

/** 所有版本 ID，按编号排序 */
export async function listVersionIds(dir: string): Promise<string[]> {
  const files = existsSync(paths(dir).versions) ? await readdir(paths(dir).versions) : [];
  return files
    .filter((f) => /^v\d{3,}\.json$/.test(f))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => idNumber(a) - idNumber(b));
}

export async function readVersion(dir: string, id: string): Promise<Version> {
  const v = await readJson(paths(dir).version(id), VersionSchema);
  if (v.version !== id) throw new StorageError(`文件名是 ${id}，内容却是 ${v.version}`, paths(dir).version(id));
  return v;
}

export async function latestVersionId(dir: string): Promise<string> {
  const ids = await listVersionIds(dir);
  const last = ids.at(-1);
  if (!last) throw new StorageError("没有任何版本", paths(dir).versions);
  return last;
}

/** 从 versions/ 重建 graph.json */
export async function rebuildGraph(dir: string): Promise<Graph> {
  const v = await readVersion(dir, await latestVersionId(dir));
  await writeJson(paths(dir).graph, v.graph);
  return v.graph;
}

/** 当前的图。graph.json 缺失、损坏或落后于 versions/ 时自动重建 */
export async function readGraph(dir: string): Promise<Graph> {
  const latest = await latestVersionId(dir);
  try {
    const g = await readJson(paths(dir).graph, GraphSchema);
    if (g.version === latest) return g;
  } catch {
    // 落到下面重建
  }
  return rebuildGraph(dir);
}

/**
 * 写入新版本。历史只增不改：
 * - 版本文件已存在时拒绝（不覆盖）
 * - 新版本必须紧接在当前最新版本之后（parent_version 是最新版本，编号 +1）
 */
export async function writeVersion(dir: string, v: Version, now: string): Promise<void> {
  const checked = VersionSchema.parse(v);
  const latest = await latestVersionId(dir);
  if (checked.parent_version !== latest || checked.version !== nextSeqId(latest)) {
    throw new StorageError(`新版本 ${checked.version}（基于 ${checked.parent_version}）不是紧接在最新版本 ${latest} 之后`);
  }
  await writeJsonNew(paths(dir).version(checked.version), checked);
  await writeJson(paths(dir).graph, checked.graph);
  await touch(dir, now);
}

// ---------- 补丁 ----------

export async function listPatchIds(dir: string): Promise<string[]> {
  const files = existsSync(paths(dir).patches) ? await readdir(paths(dir).patches) : [];
  return files
    .filter((f) => /^p\d{3,}\.json$/.test(f))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => idNumber(a) - idNumber(b));
}

export async function nextPatchId(dir: string): Promise<string> {
  const last = (await listPatchIds(dir)).at(-1);
  return last ? nextSeqId(last) : firstSeqId("p", 1);
}

export async function readPatch(dir: string, id: string): Promise<Patch> {
  return readJson(paths(dir).patch(id), PatchSchema);
}

/** 保存新补丁（未处理） */
export async function savePatch(dir: string, patch: Patch): Promise<void> {
  const p = PatchSchema.parse(patch);
  if (p.resolution !== null) throw new StorageError("新保存的补丁应该是未处理的");
  await writeJsonNew(paths(dir).patch(p.patch_id), p);
}

/** 把补丁标记为已处理。只允许从未处理变为已处理一次，ops 等内容不能改 */
async function saveResolvedPatch(dir: string, resolved: Patch): Promise<void> {
  const old = await readPatch(dir, resolved.patch_id);
  if (old.resolution !== null) throw new StorageError(`补丁 ${resolved.patch_id} 已经处理过`);
  if (JSON.stringify({ ...old, resolution: null }) !== JSON.stringify({ ...resolved, resolution: null })) {
    throw new StorageError(`补丁 ${resolved.patch_id} 的内容与已保存的不一致`);
  }
  await writeJson(paths(dir).patch(resolved.patch_id), PatchSchema.parse(resolved));
}

/**
 * 处理一个已保存的补丁：应用被接受的操作，写入新版本，再把补丁标记为已处理。
 * 先写版本再写补丁：如果中途崩溃，补丁仍显示未处理，但再次处理会因为版本已变而被拒绝，不会重复应用。
 */
export async function commitPatch(dir: string, patchId: string, choices: Choices, now: string): Promise<{ patch: Patch; version: Version | null }> {
  const graph = await readGraph(dir);
  const patch = await readPatch(dir, patchId);
  const result = resolvePatch(graph, patch, choices, now);
  if (result.version) await writeVersion(dir, result.version, now);
  await saveResolvedPatch(dir, result.patch);
  if (!result.version) await touch(dir, now);
  return result;
}

/** 恢复到旧版本：生成一个新版本（历史只增不改，已有版本不会被修改或删除） */
export async function restoreTo(dir: string, versionId: string, now: string): Promise<Version> {
  const current = await readGraph(dir);
  const target = await readVersion(dir, versionId);
  const v = restoreVersion(current, target.graph, now);
  await writeVersion(dir, v, now);
  return v;
}

// ---------- 对话 ----------

export async function readConversation(dir: string): Promise<JsonlResult<Turn>> {
  return readJsonl(paths(dir).conversation, TurnSchema);
}

/** 追加一条对话；turn_id 和 created_at 自动填写 */
export async function appendTurn(dir: string, turn: Omit<Turn, "turn_id" | "created_at">, now: string): Promise<Turn> {
  const { items } = await readConversation(dir);
  const last = items.at(-1)?.turn_id;
  const full = TurnSchema.parse({ ...turn, turn_id: last ? nextSeqId(last) : firstSeqId("t", 1), created_at: now });
  await appendJsonl(paths(dir).conversation, full);
  await touch(dir, now);
  return full;
}

/**
 * 放弃对话末尾那条没有得到回复的用户消息：追加一条 system 回合标记它（对话只追加，不删除）。
 * 之后不能再对它重试，它也不会发给 AI。
 */
export async function abandonLastMessage(dir: string, now: string): Promise<Turn> {
  const last = (await readConversation(dir)).items.at(-1);
  if (last?.role !== "user") throw new StorageError("对话末尾没有等待回复的消息");
  return appendTurn(dir, { role: "system", text: "放弃了上一条消息（没有发给 AI 处理）", abandoned_turn: last.turn_id }, now);
}

// ---------- 笔记与布局 ----------

export async function readNotes(dir: string): Promise<string> {
  return existsSync(paths(dir).notes) ? readFileRetry(paths(dir).notes) : "";
}

export async function writeNotes(dir: string, text: string, now: string): Promise<void> {
  await atomicWrite(paths(dir).notes, text);
  await touch(dir, now);
}

export async function readLayout(dir: string): Promise<Layout> {
  if (!existsSync(paths(dir).layout)) return LayoutSchema.parse({});
  return readJson(paths(dir).layout, LayoutSchema);
}

/** 布局不算版本，也不更新 updated_at */
export async function writeLayout(dir: string, layout: Layout): Promise<void> {
  await writeJson(paths(dir).layout, LayoutSchema.parse(layout));
}

// ---------- 完整性检查（设计文档第 11.1 节） ----------

/** 检查版本、补丁、对话之间的引用；返回问题列表，空表示一致 */
export async function checkIntegrity(dir: string): Promise<string[]> {
  const problems: string[] = [];
  const versionIds = await listVersionIds(dir);
  const patchIds = new Set(await listPatchIds(dir));
  const versions = new Map<string, Version>();

  versionIds.forEach((id, i) => {
    if (idNumber(id) !== i) problems.push(`版本编号不连续：第 ${i + 1} 个版本是 ${id}`);
  });
  for (const id of versionIds) {
    try {
      versions.set(id, await readVersion(dir, id));
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  for (const [id, v] of versions) {
    const expectedParent = id === "v000" ? null : versionIds[versionIds.indexOf(id) - 1];
    if (v.parent_version !== expectedParent) problems.push(`${id} 的 parent_version 是 ${v.parent_version}，应为 ${expectedParent}`);
    if (v.patch_id) {
      if (!patchIds.has(v.patch_id)) problems.push(`${id} 引用的补丁 ${v.patch_id} 不存在`);
      else {
        const p = await readPatch(dir, v.patch_id);
        if (p.resolution === null) problems.push(`补丁 ${v.patch_id} 已产生版本 ${id}，但仍标记为未处理（可自动修复）`);
        else if (p.resolution.result_version !== id) problems.push(`${id} 引用补丁 ${v.patch_id}，但补丁记录的结果版本是 ${p.resolution.result_version}`);
      }
    }
  }
  for (const pid of patchIds) {
    const p = await readPatch(dir, pid).catch((e: Error) => (problems.push(e.message), null));
    if (!p) continue;
    if (!versions.has(p.base_version)) problems.push(`补丁 ${pid} 的基础版本 ${p.base_version} 不存在`);
    const rv = p.resolution?.result_version;
    if (rv && versions.get(rv)?.patch_id !== pid) problems.push(`补丁 ${pid} 的结果版本 ${rv} 不存在或不是由它产生`);
  }
  const { items, skipped } = await readConversation(dir);
  for (const s of skipped) problems.push(`conversation.jsonl 第 ${s.line} 行无法读取：${s.reason}`);
  for (const t of items) {
    if (t.patch_id && !patchIds.has(t.patch_id)) problems.push(`对话 ${t.turn_id} 引用的补丁 ${t.patch_id} 不存在`);
    if (t.version && !versions.has(t.version)) problems.push(`对话 ${t.turn_id} 引用的版本 ${t.version} 不存在`);
  }
  const latest = versionIds.at(-1);
  if (latest) {
    const g = await readJson(paths(dir).graph, GraphSchema).catch(() => null);
    if (!g || JSON.stringify(g) !== JSON.stringify(versions.get(latest)?.graph)) problems.push(`graph.json 与最新版本 ${latest} 不一致（可重建）`);
  }
  return problems;
}
