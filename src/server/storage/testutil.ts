// 存储测试用：每个测试一个临时目录，测试结束后删除。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

export function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "think-test-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});
