// schema_version 迁移入口（设计文档第 9.4 节）。
// 目前只有版本 1，迁移步骤为空；以后升级格式时在 MIGRATIONS 里加一步即可。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSION } from "../../core/schema";
import { StorageError } from "./fsutil";

/** 把整个 Map 文件夹从 from 升级到 from + 1。键是 from。 */
type FolderMigration = (mapDir: string) => Promise<void>;
export const MIGRATIONS: Record<number, FolderMigration> = {
  // 示例：1: async (dir) => { …把 v1 的文件改写成 v2… },
};

/**
 * 打开 Map 前调用。版本旧了就逐步升级；比当前程序新则报错（避免旧程序改坏新格式的数据）。
 * 返回执行过的迁移步骤（用于日志）。
 */
export async function migrateMapFolder(mapDir: string, current = SCHEMA_VERSION): Promise<number[]> {
  const metaPath = join(mapDir, "map.json");
  let version: unknown;
  try {
    version = (JSON.parse(await readFile(metaPath, "utf8")) as { schema_version?: unknown }).schema_version;
  } catch {
    throw new StorageError("无法读取 map.json", metaPath);
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new StorageError("map.json 中的 schema_version 不合法", metaPath);
  }
  if (version > current) {
    throw new StorageError(`这个 Map 的数据格式是 v${version}，比当前程序（v${current}）新，请先更新 Think`, metaPath);
  }
  const ran: number[] = [];
  for (let v = version; v < current; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new StorageError(`缺少从 v${v} 升级到 v${v + 1} 的迁移步骤`, metaPath);
    await step(mapDir);
    ran.push(v);
  }
  return ran;
}
