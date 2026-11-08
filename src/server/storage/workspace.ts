// 工作区：workspace.json + maps/ 下的各个 Map 文件夹（设计文档第 9.4 节）。
// 所有函数都显式接收工作区根目录；只有 defaultWorkspaceDir() 知道真实工作区在哪里。
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, WorkspaceConfig, type MapMeta } from "../../core/schema";
import { StorageError, readJson, writeJson } from "./fsutil";
import { createMapFolder, forkMapFolder, readMeta } from "./map-store";
import { mapFolderName } from "./names";

/** 真实工作区：环境变量 THINK_WORKSPACE，默认 ~/Documents/Think */
export function defaultWorkspaceDir(): string {
  return process.env.THINK_WORKSPACE || join(homedir(), "Documents", "Think");
}

export const mapsDir = (root: string) => join(root, "maps");

/** 打开工作区；不存在时创建 workspace.json 和 maps/ */
export async function openWorkspace(root: string): Promise<WorkspaceConfig> {
  await mkdir(mapsDir(root), { recursive: true });
  const path = join(root, "workspace.json");
  if (!existsSync(path)) {
    const config = WorkspaceConfig.parse({ schema_version: SCHEMA_VERSION });
    await writeJson(path, config);
    return config;
  }
  return readJson(path, WorkspaceConfig);
}

export async function saveWorkspaceConfig(root: string, config: WorkspaceConfig): Promise<void> {
  await writeJson(join(root, "workspace.json"), WorkspaceConfig.parse(config));
}

export interface MapEntry {
  /** 文件夹名，同时作为 Map 的 ID */
  name: string;
  dir: string;
  meta: MapMeta;
}

export interface MapList {
  maps: MapEntry[];
  /** 读不了的文件夹（不影响其他 Map） */
  broken: { name: string; error: string }[];
}

/** 列出所有 Map，最近更新的在前 */
export async function listMaps(root: string): Promise<MapList> {
  const dir = mapsDir(root);
  if (!existsSync(dir)) return { maps: [], broken: [] };
  const result: MapList = { maps: [], broken: [] };
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      result.maps.push({ name: d.name, dir: join(dir, d.name), meta: await readMeta(join(dir, d.name)) });
    } catch (e) {
      result.broken.push({ name: d.name, error: (e as Error).message });
    }
  }
  result.maps.sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at));
  return result;
}

async function existingNames(root: string): Promise<string[]> {
  const dir = mapsDir(root);
  return existsSync(dir) ? readdir(dir) : [];
}

/** 新建 Map：文件夹名由主题生成，重名时自动加后缀 */
export async function createMap(root: string, topic: string, now: string): Promise<MapEntry> {
  await openWorkspace(root);
  const name = mapFolderName(topic, now, await existingNames(root));
  const dir = join(mapsDir(root), name);
  const meta = await createMapFolder(dir, topic, now);
  return { name, dir, meta };
}

/** 分叉：用源 Map 的最新版本开一个新 Map，用于尝试"另一种想法" */
export async function forkMap(root: string, sourceName: string, now: string, title?: string): Promise<MapEntry> {
  const srcDir = join(mapsDir(root), sourceName);
  const src = await readMeta(srcDir);
  const newTitle = title ?? `${src.title}（分叉）`;
  const name = mapFolderName(newTitle, now, await existingNames(root));
  const dir = join(mapsDir(root), name);
  const meta = await forkMapFolder(srcDir, sourceName, dir, newTitle, now);
  return { name, dir, meta };
}

// ---------- 回收站（.trash/） ----------
// 删除 Map 不直接删文件：整个文件夹移到工作区的 .trash/ 下，可以撤销；超过 30 天的才清理。
// 回收站里的文件夹名是 <删除时间>__<原文件夹名>，删除时间形如 2026-11-09T01-02-03-456Z。

export const trashDir = (root: string) => join(root, ".trash");
export const TRASH_DAYS = 30;

export interface TrashEntry {
  /** 回收站里的文件夹名 */
  entry: string;
  /** 原来的文件夹名 */
  name: string;
  title: string;
  deletedAt: string;
}

const stampOf = (iso: string) => iso.replace(/[:.]/g, "-");
const isoOf = (stamp: string) => stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
/** 只接受回收站中直接的子文件夹名，防止路径穿越 */
function checkEntry(entry: string): { stamp: string; name: string } {
  const m = entry.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)__(.+)$/);
  if (!m || /[\/]/.test(entry) || m[2] === "." || m[2] === "..") throw new StorageError(`回收站里没有「${entry}」`);
  return { stamp: m[1]!, name: m[2]! };
}

/** 把 Map 移到回收站，返回回收站里的文件夹名 */
export async function trashMap(root: string, name: string, now: string): Promise<string> {
  const src = join(mapsDir(root), name);
  if (!existsSync(join(src, "map.json"))) throw new StorageError(`找不到 Map「${name}」`);
  await mkdir(trashDir(root), { recursive: true });
  const entry = `${stampOf(now)}__${name}`;
  await rename(src, join(trashDir(root), entry));
  return entry;
}

export async function listTrash(root: string): Promise<TrashEntry[]> {
  const dir = trashDir(root);
  if (!existsSync(dir)) return [];
  const out: TrashEntry[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const { stamp, name } = checkEntry(d.name);
      const title = await readMeta(join(dir, d.name)).then(
        (m) => m.title,
        () => name,
      );
      out.push({ entry: d.name, name, title, deletedAt: isoOf(stamp) });
    } catch {
      // 不是我们放进去的，跳过
    }
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** 撤销删除：移回 maps/（原名被占用时报错，不覆盖） */
export async function restoreFromTrash(root: string, entry: string): Promise<string> {
  const { name } = checkEntry(entry);
  const src = join(trashDir(root), entry);
  if (!existsSync(src)) throw new StorageError(`回收站里没有「${entry}」`);
  const dst = join(mapsDir(root), name);
  if (existsSync(dst)) throw new StorageError(`已经有一个名为「${name}」的 Map，不能恢复`);
  await mkdir(mapsDir(root), { recursive: true });
  await rename(src, dst);
  return name;
}

/** 清理删除超过 30 天的；返回清理掉的文件夹名 */
export async function purgeTrash(root: string, now: string, days = TRASH_DAYS): Promise<string[]> {
  const cutoff = Date.parse(now) - days * 24 * 3600 * 1000;
  const gone: string[] = [];
  for (const t of await listTrash(root)) {
    if (Date.parse(t.deletedAt) < cutoff) {
      await rm(join(trashDir(root), t.entry), { recursive: true, force: true });
      gone.push(t.entry);
    }
  }
  return gone;
}
