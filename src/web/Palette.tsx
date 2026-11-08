// Ctrl+K 快速切换：按标题搜索图并打开，或直接新建。
import { useState } from "react";
import type { JobView, MapSummary } from "../server/api";
import { StatusDot } from "./Sidebar";

export function QuickSwitch(props: { maps: MapSummary[]; jobs: Record<string, JobView>; onOpen: (name: string) => void; onCreate: (topic: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const query = q.trim().toLowerCase();
  const hits = props.maps.filter((m) => !query || m.meta.title.toLowerCase().includes(query) || m.name.toLowerCase().includes(query));
  const items: { key: string; label: string; act: () => void; map?: MapSummary }[] = hits.map((m) => ({ key: m.name, label: m.meta.title, act: () => props.onOpen(m.name), map: m }));
  if (q.trim()) items.push({ key: "__new", label: `新建「${q.trim()}」`, act: () => props.onCreate(q.trim()) });
  const sel = Math.min(i, items.length - 1);
  return (
    <div className="modal-bg palette-bg" onClick={props.onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="快速切换">
        <input
          autoFocus
          placeholder="搜索图的标题，或输入新主题后按 Enter 新建"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
            if (e.key === "ArrowDown") setI((x) => Math.min(x + 1, items.length - 1));
            if (e.key === "ArrowUp") setI((x) => Math.max(x - 1, 0));
            if (e.key === "Enter" && items[sel]) {
              e.preventDefault();
              items[sel].act();
            }
          }}
        />
        <ul>
          {items.map((it, k) => (
            <li key={it.key} className={k === sel ? "on" : ""} onMouseEnter={() => setI(k)} onClick={it.act}>
              {it.map ? <StatusDot summary={it.map} job={props.jobs[it.map.name]} /> : <span className="plus">＋</span>}
              <span className="t">{it.label}</span>
              {it.map && (
                <span className="meta">
                  {it.map.nodes} 变量 · {it.map.loops} 回路
                </span>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="hint">没有图。输入主题后按 Enter 新建。</li>}
        </ul>
      </div>
    </div>
  );
}
