// Vitest 全局设置：测试期间把默认工作区指向临时目录，保证任何测试都碰不到真实工作区。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "think-test-default-"));
process.env.THINK_WORKSPACE = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
