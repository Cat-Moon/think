// 工作台左侧栏：新建、图列表（状态点、最后修改时间、变量数、回路数；可展开成 图 / 对话 / 回路 / 版本 / 笔记）、重命名、删除、回收站。
import { useState } from "react";
import type { JobView, MapSummary, TrashEntry } from "../server/api";
import { VIEWS, type MapViewKind } from "./MapView";
import { STATUS_TEXT, mapStatus, shortTime } from "./workbench";

export function StatusDot(props: { summary: MapSummary | undefined; job: JobView | undefined }) {
  const s = mapStatus(props.summary, props.job);
  return <span className={`dot dot-${s}`} title={STATUS_TEXT[s]} aria-label={STATUS_TEXT[s]} />;
}

export function Sidebar(props: {
  maps: MapSummary[];
  broken: { name: string; error: string }[];
  jobs: Record<string, JobView>;
  active: string | null;
  activeView: MapViewKind | null;
  trash: TrashEntry[];
  onCreate: (topic: string) => Promise<void>;
  onOpen: (name: string, view?: MapViewKind) => void;
  onRename: (name: string, title: string) => Promise<void>;
  onDelete: (name: string) => void;
  onRestore: (entry: string) => void;
}) {
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<{ name: string; title: string } | null>(null);
  const [showTrash, setShowTrash] = useState(false);

  const create = async () => {
    if (!topic.trim() || creating) return;
    setCreating(true);
    try {
      await props.onCreate(topic.trim());
      setTopic("");
    } finally {
      setCreating(false);
    }
  };

  return (
    <nav className="sidebar" aria-label="图列表">
      <div className="new-map">
        <input value={topic} placeholder="新建：想弄明白的现象" onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
        <button className="primary" disabled={!topic.trim() || creating} onClick={() => void create()} title="新建一个图">
          新建
        </button>
      </div>
      <p className="hint side-hint">Ctrl+K 快速切换</p>
      <ul className="map-tree">
        {props.maps.length === 0 && <li className="hint">还没有图。</li>}
        {props.maps.map((m) => {
          const open = expanded[m.name];
          const isActive = props.active === m.name;
          const job = props.jobs[m.name];
          return (
            <li key={m.name} className={`map-item${isActive ? " active" : ""}`} data-map={m.name}>
              <div className="map-row">
                <button className="chev" onClick={() => setExpanded((x) => ({ ...x, [m.name]: !open }))} title={open ? "收起" : "展开"} aria-expanded={Boolean(open)}>
                  {open ? "▾" : "▸"}
                </button>
                <StatusDot summary={m} job={job} />
                {renaming?.name === m.name ? (
                  <input
                    className="rename-input"
                    autoFocus
                    value={renaming.title}
                    onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRenaming(null);
                      if (e.key === "Enter" && renaming.title.trim()) void props.onRename(m.name, renaming.title.trim()).then(() => setRenaming(null));
                    }}
                    onBlur={() => setRenaming(null)}
                  />
                ) : (
                  <button className="map-title" onClick={() => props.onOpen(m.name)} title={m.meta.title}>
                    <span className="t">{m.meta.title}</span>
                    <span className="meta">
                      {shortTime(m.meta.updated_at)} · {m.nodes} 变量 · {m.loops} 回路
                    </span>
                  </button>
                )}
                <span className="row-actions">
                  <button title="重命名" onClick={() => setRenaming({ name: m.name, title: m.meta.title })}>
                    ✎
                  </button>
                  <button title="删除（移到回收站，可以撤销）" onClick={() => props.onDelete(m.name)}>
                    🗑
                  </button>
                </span>
              </div>
              {open && (
                <ul className="sub-items">
                  {VIEWS.map((v) => (
                    <li key={v.key}>
                      <button className={isActive && props.activeView === v.key ? "on" : ""} onClick={() => props.onOpen(m.name, v.key)}>
                        {v.label}
                        <span className="meta">{v.file}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {props.broken.map((b) => (
        <p key={b.name} className="warn side-hint">
          ⚠ 无法读取「{b.name}」：{b.error}
        </p>
      ))}
      <div className="trash">
        <button className="trash-toggle" onClick={() => setShowTrash((v) => !v)}>
          {showTrash ? "▾" : "▸"} 回收站（{props.trash.length}）
        </button>
        {showTrash && (
          <ul>
            {props.trash.length === 0 && <li className="hint">空的。删除的图在这里保留 30 天。</li>}
            {props.trash.map((t) => (
              <li key={t.entry}>
                <span className="t">{t.title}</span>
                <span className="meta">删除于 {shortTime(t.deletedAt)}</span>
                <button onClick={() => props.onRestore(t.entry)}>恢复</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
