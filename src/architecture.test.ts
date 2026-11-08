// 架构保险：src/core/ 必须是纯逻辑，不允许依赖 server/、web/ 或 Node 内置模块。
// （设计文档第 13 节：core 不依赖界面、文件系统或网络。）
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const CORE = join(SRC, "core");

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split("/")[0]!]));

/** 抽出源码中所有模块说明符：import / export from / 副作用 import / 动态 import() / require() */
export function extractSpecifiers(source: string): string[] {
  const re =
    /\b(?:import|export)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const out: string[] = [];
  for (const m of source.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) out.push(spec);
  }
  return out;
}

/** 返回违规原因；合法时返回 null。filePath 是 core 内的文件绝对路径。 */
export function checkCoreImport(filePath: string, spec: string): string | null {
  if (spec.startsWith("node:") || NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split("/")[0]!)) {
    return `不允许 import Node 内置模块 "${spec}"`;
  }
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const target = resolve(dirname(filePath), spec);
    const rel = relative(CORE, target);
    if (rel.startsWith("..") || rel.includes(":")) {
      return `不允许 import core/ 之外的文件 "${spec}"`;
    }
  }
  if (/^(?:@\/|src\/)?(?:server|web)(?:\/|$)/.test(spec)) {
    return `不允许 import server/ 或 web/ "${spec}"`;
  }
  return null;
}

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return listTsFiles(p);
    return /\.(ts|tsx|mts|cts)$/.test(d.name) ? [p] : [];
  });
}

describe("core/ 的依赖边界", () => {
  it("core/ 中的所有文件都没有违规 import", () => {
    const violations: string[] = [];
    for (const file of listTsFiles(CORE)) {
      for (const spec of extractSpecifiers(readFileSync(file, "utf8"))) {
        const why = checkCoreImport(file, spec);
        if (why) violations.push(`${relative(SRC, file).split(sep).join("/")}: ${why}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // 确认检查本身是有效的（否则上面的测试可能"永远通过"）
  it("检查规则能识别各种违规写法", () => {
    const f = join(CORE, "x.ts");
    const bad = [
      `import { readFileSync } from "node:fs";`,
      `import fs from "fs";`,
      `import { join } from "path/posix";`,
      `import type { HealthResponse } from "../server/api";`,
      `export { App } from "../web/App";`,
      `import "../server/index";`,
      `const m = await import("node:child_process");`,
      `const fs = require("fs");`,
      `import { x } from "../other";`,
    ];
    for (const src of bad) {
      const specs = extractSpecifiers(src);
      expect(specs.length, src).toBe(1);
      expect(checkCoreImport(f, specs[0]!), src).not.toBeNull();
    }
    const ok = [`import { z } from "zod";`, `import { Graph } from "./schema";`, `import type { A } from "./sub/a";`];
    for (const src of ok) {
      const specs = extractSpecifiers(src);
      expect(specs.length, src).toBe(1);
      expect(checkCoreImport(f, specs[0]!), src).toBeNull();
    }
  });
});
