// ID 工具：节点 n1、边 e1、版本 v001、补丁 p001、回合 t001。

/** 取出 ID 中的数字部分，如 "n12" → 12 */
export function idNumber(id: string): number {
  const m = id.match(/(\d+)$/);
  return m ? Number(m[1]) : NaN;
}

/** 按前缀和数字排序，保证 n2 排在 n10 之前 */
export function compareIds(a: string, b: string): number {
  const pa = a.replace(/\d+$/, "");
  const pb = b.replace(/\d+$/, "");
  if (pa !== pb) return pa < pb ? -1 : 1;
  return idNumber(a) - idNumber(b);
}

/** 下一个节点 / 边 ID：已有最大编号 + 1（被拒绝的项保留在图中，所以不会复用） */
export function nextItemId(prefix: "n" | "e", existing: Iterable<{ id: string }>): string {
  let max = 0;
  for (const { id } of existing) max = Math.max(max, idNumber(id) || 0);
  return `${prefix}${max + 1}`;
}

/** 下一个序号 ID，至少 3 位：v003 → v004，p099 → p100 */
export function nextSeqId(id: string): string {
  const prefix = id.replace(/\d+$/, "");
  return `${prefix}${String(idNumber(id) + 1).padStart(3, "0")}`;
}

export function firstSeqId(prefix: "v" | "p" | "t", start = 0): string {
  return `${prefix}${String(start).padStart(3, "0")}`;
}
