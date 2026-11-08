// 工作区：workspace.json + maps/ 下的各个 Map 文件夹（设计文档第 9.4 节）。
// 所有函数都显式接收工作区根目录；只有 defaultWorkspaceDir() 知道真实工作区在哪里。
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, WorkspaceConfig, type MapMeta } from "../../core/schema";
import { readJson, writeJson } from "./fsutil";
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
