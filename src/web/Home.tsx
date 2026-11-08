// Map 列表与新建；首次启动的隐私说明；设置。
import { useEffect, useState } from "react";
import type { WorkspaceConfig } from "../core/schema";
import type { MapListResponse, SettingsUpdate, StatusResponse } from "../server/api";
import { api } from "./client";

const time = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function MapList(props: { onOpen: (name: string) => void }) {
  const [list, setList] = useState<MapListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    api.listMaps().then(setList, (e: Error) => setError(e.message));
  }, []);
  const create = async () => {
    if (!topic.trim()) return;
    setCreating(true);
    try {
      const m = await api.createMap(topic.trim());
      props.onOpen(m.name);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };
  return (
    <div className="home">
      <div className="card">
        <h3>新建</h3>
        <p className="hint">写下你想弄明白的现象，例如"为什么我总是拖延"、"城市为什么越修路越堵"。</p>
        <div className="reason">
          <input autoFocus value={topic} placeholder="主题" onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
          <button className="primary" disabled={!topic.trim() || creating} onClick={() => void create()}>
            新建
          </button>
        </div>
      </div>
      {error && <p className="warn">⚠ {error}</p>}
      <div className="card">
        <h3>我的图</h3>
        {!list && !error && <p className="hint">读取中…</p>}
        {list?.maps.length === 0 && <p className="hint">还没有。</p>}
        <ul className="map-list">
          {list?.maps.map((m) => (
            <li key={m.name} onClick={() => props.onOpen(m.name)}>
              <b>{m.meta.title}</b>
              <span className="meta">
                {time(m.meta.updated_at)}
                {m.meta.parent && ` · 分叉自 ${m.meta.parent.map}`}
              </span>
            </li>
          ))}
        </ul>
        {list?.broken.map((b) => (
          <p key={b.name} className="warn">
            ⚠ 无法读取「{b.name}」：{b.error}
          </p>
        ))}
      </div>
    </div>
  );
}

/** 首次启动的隐私说明（之后可在设置中再次查看） */
export function PrivacyNotice(props: { status: StatusResponse; onClose: () => void }) {
  const { status } = props;
  return (
    <div className="modal-bg">
      <div className="modal card">
        <h3>开始之前：数据去了哪里</h3>
        <ul>
          <li>
            <b>对话会发给 Anthropic。</b>每次请 AI 回复时，Think 通过你本机已登录的 Claude Code CLI 发送：主题、当前的图（变量、关系、理由、你写在变量和关系上的笔记）、你拒绝过的内容和理由、最近的对话。使用的是你的 Claude 订阅额度。
          </li>
          <li>
            <b>其余都存在本机：</b>
            <code>{status.workspaceDir}</code>
            <br />
            每个图一个文件夹（<code>maps/</code> 下），包括版本、补丁、对话记录和调用日志（<code>logs/</code>，含发给 AI 的完整内容）。"笔记"页里的内容不会发给 AI。
          </li>
          <li>Think 不会把数据上传到其他任何地方。服务只监听本机（127.0.0.1）。</li>
          {status.provider?.apiKeyEnvSet && (
            <li className="warn">
              检测到环境变量 <code>ANTHROPIC_API_KEY</code>。Think 调用 CLI 时会把它从子进程环境中移除，以使用订阅登录（否则 CLI 会改用 API key 按量计费）。
            </li>
          )}
        </ul>
        <div className="actions">
          <button className="primary" onClick={props.onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}

const EFFORTS: { value: string | null; label: string }[] = [
  { value: null, label: "CLI 默认" },
  { value: "low", label: "low（更快、更省）" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
];

export function Settings(props: { status: StatusResponse; onChange: (s: SettingsUpdate) => Promise<void>; onRecheck: () => void; onShowPrivacy: () => void; onClose: () => void }) {
  const c: WorkspaceConfig = props.status.config;
  const effortSelect = (key: "effort_short" | "effort_long") => (
    <select value={c[key] ?? ""} onChange={(e) => void props.onChange({ [key]: e.target.value || null })}>
      {EFFORTS.map((o) => (
        <option key={o.label} value={o.value ?? ""}>
          {o.label}
        </option>
      ))}
    </select>
  );
  const p = props.status.provider;
  return (
    <div className="modal-bg" onClick={props.onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={props.onClose}>
          ✕
        </button>
        <h3>设置</h3>
        <p className="meta">保存在 {props.status.workspaceDir}\workspace.json</p>
        <table className="settings">
          <tbody>
            <tr>
              <td>短回合的思考程度</td>
              <td>{effortSelect("effort_short")}</td>
            </tr>
            <tr>
              <td colSpan={2} className="hint">
                澄清、回答"为什么"等。
              </td>
            </tr>
            <tr>
              <td>长回合的思考程度</td>
              <td>{effortSelect("effort_long")}</td>
            </tr>
            <tr>
              <td colSpan={2} className="hint">
                种子图、补充建议。
              </td>
            </tr>
            <tr>
              <td>预览中提示新回路</td>
              <td>
                <input type="checkbox" checked={c.show_new_loops} onChange={(e) => void props.onChange({ show_new_loops: e.target.checked })} />
              </td>
            </tr>
            <tr>
              <td colSpan={2} className="hint">
                打开后，AI 建议的预览中会提示接受后程序会检测到的新回路。
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Claude Code：{p ? p.message : "检测中…"}{" "}
          <button onClick={props.onRecheck}>重新检测</button>
        </p>
        <div className="actions">
          <button onClick={props.onShowPrivacy}>查看隐私说明</button>
        </div>
      </div>
    </div>
  );
}
