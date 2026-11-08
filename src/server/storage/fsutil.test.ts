import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StorageError, appendJsonl, atomicWrite, readJson, readJsonl, writeJson, writeJsonNew } from "./fsutil";
import { tmpRoot } from "./testutil";

const Row = z.object({ n: z.number() });

describe("atomicWrite", () => {
  it("写入、覆盖，且不留下临时文件", async () => {
    const dir = tmpRoot();
    const p = join(dir, "sub", "a.json");
    await atomicWrite(p, "one");
    await atomicWrite(p, "two");
    expect(readFileSync(p, "utf8")).toBe("two");
    expect(readdirSync(join(dir, "sub"))).toEqual(["a.json"]);
  });

  it("中文内容按 UTF-8 写入", async () => {
    const p = join(tmpRoot(), "n.md");
    await atomicWrite(p, "房价 ‖ 延迟");
    expect(readFileSync(p, "utf8")).toBe("房价 ‖ 延迟");
  });
});

describe("readJson / writeJsonNew", () => {
  it("校验格式，错误时抛出 StorageError", async () => {
    const dir = tmpRoot();
    await writeJson(join(dir, "ok.json"), { n: 1 });
    expect(await readJson(join(dir, "ok.json"), Row)).toEqual({ n: 1 });

    writeFileSync(join(dir, "bad.json"), "{ n: 1");
    await expect(readJson(join(dir, "bad.json"), Row)).rejects.toThrow(/不是合法的 JSON/);
    await writeJson(join(dir, "wrong.json"), { n: "x" });
    await expect(readJson(join(dir, "wrong.json"), Row)).rejects.toBeInstanceOf(StorageError);
    await expect(readJson(join(dir, "missing.json"), Row)).rejects.toThrow(/无法读取/);
  });

  it("writeJsonNew 不覆盖已有文件", async () => {
    const p = join(tmpRoot(), "v.json");
    await writeJsonNew(p, { n: 1 });
    await expect(writeJsonNew(p, { n: 2 })).rejects.toThrow(/不能覆盖/);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ n: 1 });
  });
});

describe("JSONL", () => {
  it("只追加，按行读取", async () => {
    const p = join(tmpRoot(), "c.jsonl");
    expect(await readJsonl(p, Row)).toEqual({ items: [], skipped: [] });
    await appendJsonl(p, { n: 1 });
    await appendJsonl(p, { n: 2 });
    expect(readFileSync(p, "utf8")).toBe('{"n":1}\n{"n":2}\n');
    expect((await readJsonl(p, Row)).items).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("最后一行不完整时，其余行照常读出", async () => {
    const p = join(tmpRoot(), "c.jsonl");
    writeFileSync(p, '{"n":1}\n{"n":2}\n{"n":3, "tru');
    const r = await readJsonl(p, Row);
    expect(r.items).toEqual([{ n: 1 }, { n: 2 }]);
    expect(r.skipped).toEqual([{ line: 3, reason: "不是完整的 JSON" }]);
  });

  it("在不完整的行之后追加，新行不会和残行粘在一起", async () => {
    const p = join(tmpRoot(), "c.jsonl");
    writeFileSync(p, '{"n":1}\n{"n":2, "tru');
    await appendJsonl(p, { n: 3 });
    const r = await readJsonl(p, Row);
    expect(r.items).toEqual([{ n: 1 }, { n: 3 }]);
    expect(r.skipped.map((s) => s.line)).toEqual([2]);
  });

  it("兼容 CRLF 换行，跳过空行和格式不对的行", async () => {
    const p = join(tmpRoot(), "c.jsonl");
    writeFileSync(p, '{"n":1}\r\n\r\n{"n":"x"}\r\n{"n":2}\r\n');
    const r = await readJsonl(p, Row);
    expect(r.items).toEqual([{ n: 1 }, { n: 2 }]);
    expect(r.skipped.map((s) => s.line)).toEqual([3]);
  });
});
