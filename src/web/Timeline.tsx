// 版本时间线和笔记。可以回看旧版本（只读）并恢复；恢复会产生一个新版本，历史只增不改。
import { useEffect, useRef, useState } from "react";
import { describeOp } from "../core/describe";
import type { Patch, Version } from "../core/schema";
import { diffGraphs } from "../core/version";

const time = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** 一个版本是怎么来的 */
export function versionSource(v: Version, patches: Patch[], prev: Version | undefined): string {
  if (!v.parent_version) return "创建";
  if (v.restored_from) return `恢复到 ${v.restored_from}`;
  const p = patches.find((x) => x.patch_id === v.patch_id);
  if (!p) return "（来源不明）";
  const accepted = (p.resolution?.decisions ?? []).filter((d) => d.decision === "accepted").map((d) => p.ops[d.op_index]!);
  if (p.origin === "ai") {
    const rej = p.ops.length - accepted.length;
    return `AI 建议：接受 ${accepted.length} 项${rej ? `，拒绝 ${rej} 项` : ""}`;
  }
  const texts = prev ? accepted.map((op) => describeOp(op, prev.graph, p.ops)) : [];
  return `你的编辑：${texts.join("；") || `${accepted.length} 项`}`;
}

function counts(a: Version | undefined, b: Version): string {
  if (!a) return "";
  const d = diffGraphs(a.graph, b.graph);
  const parts = [
    d.nodes.added.length && `+${d.nodes.added.length} 变量`,
    d.edges.added.length && `+${d.edges.added.length} 关系`,
    d.nodes.changed.length + d.edges.changed.length && `${d.nodes.changed.length + d.edges.changed.length} 处修改`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function Timeline(props: { versions: Version[]; patches: Patch[]; viewing: string | null; onView: (id: string | null) => void; onRestore: (id: string) => void; busy: boolean }) {
  const { versions, patches, viewing } = props;
  const latest = versions.at(-1)?.version;
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <div>
      <p className="hint">点击一个版本可以回看（只读）。恢复会产生一个新版本，原来的历史都保留。</p>
      <ul className="timeline">
        {[...versions].reverse().map((v) => {
          const i = versions.indexOf(v);
          const prev = versions[i - 1];
          const on = (viewing ?? latest) === v.version;
          return (
            <li key={v.version} className={on ? "on" : ""} onClick={() => props.onView(v.version === latest ? null : v.version)}>
              <div>
                <b>{v.version}</b> <span className="meta">{time(v.created_at)}</span>
                {v.version === latest && <span className="tag">当前</span>}
              </div>
              <div>{versionSource(v, patches, prev)}</div>
              {counts(prev, v) && <div className="meta">{counts(prev, v)}</div>}
              {on && v.version !== latest && (
                <div className="actions" onClick={(e) => e.stopPropagation()}>
                  {confirm === v.version ? (
                    <>
                      <button className="primary" disabled={props.busy} onClick={() => props.onRestore(v.version)}>
                        确认恢复（生成新版本）
                      </button>
                      <button onClick={() => setConfirm(null)}>取消</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => setConfirm(v.version)}>恢复到这个版本</button>
                      <button onClick={() => props.onView(null)}>回到当前</button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Map 的笔记（notes.md）：停止输入一会儿后自动保存 */
export function Notes(props: { text: string; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState(props.text);
  const [state, setState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setText(props.text);
  }, [props.text]);
  const save = (t: string) => {
    setState("saving");
    props.onSave(t).then(
      () => setState("saved"),
      () => setState("error"),
    );
  };
  return (
    <div className="notes">
      <textarea
        rows={6}
        value={text}
        placeholder="自己的笔记：想法、要验证的事、读到的资料……（只保存在本机，不会发给 AI）"
        onChange={(e) => {
          setText(e.target.value);
          setState("dirty");
          if (timer.current) clearTimeout(timer.current);
          const t = e.target.value;
          timer.current = setTimeout(() => save(t), 800);
        }}
      />
      <p className="meta">{{ saved: "已保存", dirty: "正在输入…", saving: "保存中…", error: "保存失败" }[state]}</p>
    </div>
  );
}
