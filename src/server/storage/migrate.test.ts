import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrateMapFolder } from "./migrate";
import { tmpRoot } from "./testutil";

const mapWithVersion = (v: unknown) => {
  const dir = tmpRoot();
  writeFileSync(join(dir, "map.json"), JSON.stringify({ schema_version: v, title: "x" }));
  return dir;
};

afterEach(() => {
  delete MIGRATIONS[1];
});

describe("migrateMapFolder", () => {
  it("当前版本不需要迁移", async () => {
    expect(await migrateMapFolder(mapWithVersion(1))).toEqual([]);
  });

  it("比程序新的数据格式拒绝打开", async () => {
    await expect(migrateMapFolder(mapWithVersion(2))).rejects.toThrow(/请先更新 Think/);
  });

  it("schema_version 不合法时报错", async () => {
    await expect(migrateMapFolder(mapWithVersion("1"))).rejects.toThrow(/不合法/);
    await expect(migrateMapFolder(tmpRoot())).rejects.toThrow(/无法读取/);
  });

  it("旧格式缺少迁移步骤时报错", async () => {
    await expect(migrateMapFolder(mapWithVersion(1), 2)).rejects.toThrow(/缺少从 v1 升级到 v2/);
  });

  it("按顺序执行迁移步骤（模拟以后的 v1 → v2）", async () => {
    const dir = mapWithVersion(1);
    MIGRATIONS[1] = async (d) => {
      const p = join(d, "map.json");
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), schema_version: 2 }));
    };
    expect(await migrateMapFolder(dir, 2)).toEqual([1]);
    expect(JSON.parse(readFileSync(join(dir, "map.json"), "utf8")).schema_version).toBe(2);
  });
});
