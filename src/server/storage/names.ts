// 主题名 → 文件夹名（设计文档第 9.4 节）。
// 保留中文；去掉 Windows 文件名中的非法字符；避开保留名；避免重名。

const MAX_NAME_CHARS = 40;
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** 把主题名变成安全的文件夹名片段（不含日期、不处理重名） */
export function sanitizeName(topic: string): string {
  let s = topic
    .normalize("NFKC") // 全角字母数字转半角，如 "ＡＩ" → "AI"
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-. ]+$/g, ""); // Windows 不允许以点或空格结尾
  s = [...s].slice(0, MAX_NAME_CHARS).join("").replace(/[-. ]+$/g, ""); // 按字符截断，不切坏中文或 emoji
  if (!s) s = "map";
  if (RESERVED.test(s.split(".")[0]!)) s = `_${s}`;
  return s;
}

/** 本地日期 YYYY-MM-DD */
export function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 生成 Map 文件夹名：2026-11-08_房价为什么持续上涨；重名时加 -2、-3 …
 * existing 是已有的文件夹名；比较时不区分大小写（Windows 文件系统不区分）。
 */
export function mapFolderName(topic: string, now: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  const base = `${localDate(now)}_${sanitizeName(topic)}`;
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = `${base}-${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}
