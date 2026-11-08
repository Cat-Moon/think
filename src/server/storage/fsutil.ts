// 文件读写的基础工具：原子写入、JSON 读写、只追加的 JSONL。
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export class StorageError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${message}（${path}）` : message);
    this.name = "StorageError";
  }
}

/**
 * 原子写入：先写同目录下的临时文件，再改名覆盖目标。
 * 中途崩溃时，目标文件要么是旧内容，要么是新内容，不会是写了一半的文件。
 * Windows 上杀毒软件或索引服务可能短暂占用文件，改名失败时重试几次。
 */
export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, data, "utf8");
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, path);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
}

/**
 * 读文件。Windows 上另一个请求正在原子替换这个文件时，读取可能短暂失败（EPERM / EBUSY / EACCES）：重试几次。
 */
export async function readFileRetry(path: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFile(path, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
    }
  }
}

/** 读取并按模式校验 JSON 文件 */
export async function readJson<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  let raw: string;
  try {
    raw = await readFileRetry(path);
  } catch (e) {
    throw new StorageError(`无法读取文件：${(e as Error).message}`, path);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new StorageError("文件不是合法的 JSON", path);
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new StorageError(`文件格式不对：${r.error.issues[0]?.message}`, path);
  return r.data;
}

/** 只在文件不存在时创建（用于"不可覆盖"的文件，如版本快照） */
export async function writeJsonNew(path: string, value: unknown): Promise<void> {
  if (existsSync(path)) throw new StorageError("文件已存在，不能覆盖", path);
  await writeJson(path, value);
}

/**
 * 向 JSONL 文件追加一行。只追加，不改写已有内容。
 * 如果文件最后一行不完整（上次写到一半崩溃），先补一个换行，避免新行和残行粘在一起。
 */
export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let prefix = "";
  if (existsSync(path)) {
    const fh = await open(path, "r");
    try {
      const { size } = await fh.stat();
      if (size > 0) {
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, size - 1);
        if (buf[0] !== 0x0a) prefix = "\n";
      }
    } finally {
      await fh.close();
    }
  }
  await appendFile(path, prefix + JSON.stringify(value) + "\n", "utf8");
}

export interface JsonlResult<T> {
  items: T[];
  /** 无法解析或不符合模式的行（行号从 1 开始），例如崩溃时写了一半的最后一行 */
  skipped: { line: number; reason: string }[];
}

/** 读取 JSONL：逐行解析，坏行跳过并记录，不影响其他行 */
export async function readJsonl<S extends z.ZodType>(path: string, schema: S): Promise<JsonlResult<z.output<S>>> {
  if (!existsSync(path)) return { items: [], skipped: [] };
  const lines = (await readFileRetry(path)).split("\n");
  const result: JsonlResult<z.output<S>> = { items: [], skipped: [] };
  lines.forEach((line, i) => {
    const text = line.replace(/\r$/, "");
    if (!text.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      result.skipped.push({ line: i + 1, reason: "不是完整的 JSON" });
      return;
    }
    const r = schema.safeParse(json);
    if (r.success) result.items.push(r.data);
    else result.skipped.push({ line: i + 1, reason: r.error.issues[0]?.message ?? "格式不对" });
  });
  return result;
}
