import { describe, expect, it } from "vitest";
import { localDate, mapFolderName, sanitizeName } from "./names";

describe("sanitizeName", () => {
  it("保留中文", () => {
    expect(sanitizeName("房价为什么持续上涨")).toBe("房价为什么持续上涨");
  });

  it("去掉 Windows 非法字符，空白变成连字符", () => {
    expect(sanitizeName('为什么: "越修路" 越堵?')).toBe("为什么-越修路-越堵");
    expect(sanitizeName("A/B\\C|D*E<F>G")).toBe("A-B-C-D-E-F-G");
    expect(sanitizeName("tab\there\nnewline")).toBe("tab-here-newline");
  });

  it("不以点或空格结尾，也不以点开头", () => {
    expect(sanitizeName("拖延...")).toBe("拖延");
    expect(sanitizeName("..隐藏")).toBe("隐藏");
  });

  it("全角字母数字转半角", () => {
    expect(sanitizeName("ＡＩ与注意力")).toBe("AI与注意力");
  });

  it("避开 Windows 保留名", () => {
    expect(sanitizeName("CON")).toBe("_CON");
    expect(sanitizeName("nul")).toBe("_nul");
    expect(sanitizeName("com1.txt")).toBe("_com1.txt");
    expect(sanitizeName("console")).toBe("console");
  });

  it("按字符截断到 40 个，不切坏中文或 emoji", () => {
    const long = "社交媒体".repeat(20);
    expect([...sanitizeName(long)]).toHaveLength(40);
    const emoji = "😀".repeat(50);
    expect(sanitizeName(emoji)).toBe("😀".repeat(40));
  });

  it("全是非法字符时用 map", () => {
    expect(sanitizeName('???"*')).toBe("map");
    expect(sanitizeName("   ")).toBe("map");
  });
});

describe("mapFolderName", () => {
  const now = "2026-11-08T06:00:00.000Z";
  const date = localDate(now);

  it("日期 + 主题", () => {
    expect(mapFolderName("拖延", now, [])).toBe(`${date}_拖延`);
  });

  it("重名时加后缀，不区分大小写", () => {
    expect(mapFolderName("拖延", now, [`${date}_拖延`])).toBe(`${date}_拖延-2`);
    expect(mapFolderName("拖延", now, [`${date}_拖延`, `${date}_拖延-2`])).toBe(`${date}_拖延-3`);
    expect(mapFolderName("Focus", now, [`${date}_focus`])).toBe(`${date}_Focus-2`);
  });
});
