// 工作台（设计文档第 9.2.4 节）：左侧常驻侧栏（新建、图列表、回收站），右侧是打开的图，用顶部标签页切换。
// 打开的图都保持挂载（只是隐藏），切换回来时界面状态还在；AI 回合的状态在服务端，通过 /api/events 推送。
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobView, MapListResponse, SettingsUpdate, StatusResponse, TrashEntry } from "../server/api";
import { api, subscribe } from "./client";
import { PrivacyNotice, Settings } from "./Home";
import { MapView, type MapViewKind } from "./MapView";
import { QuickSwitch } from "./Palette";
import { Sidebar, StatusDot } from "./Sidebar";
import { loadLocal, saveLocal, shortTime, sortByRecent } from "./workbench";

const TABS_KEY = "think-tabs";
const ACTIVE_KEY = "think-active";
const VIEWS_KEY = "think-views";
const OPENED_KEY = "think-opened";
/** 窗口窄于这个宽度时，侧栏默认折叠 */
export const NARROW = 1100;

const mapFromUrl = () => new URLSearchParams(location.search).get("map");

/** 顶部的 Claude Code 状态和额度（额度来自 Claude Code 本地缓存，不调用模型） */
function CliStatus(props: { status: StatusResponse; onClick: () => void }) {
  const { provider: p, usage, lastRateLimit: rl } = props.status;
  const now = Date.now();
  const parts: string[] = [];
  const tips: string[] = [p ? p.message : "正在检测 Claude Code…"];
  if (usage?.fiveHour) {
    const r = usage.fiveHour.resetsAt;
    parts.push(r && Date.parse(r) < now ? "5 小时额度已重置" : `5 小时 ${usage.fiveHour.utilization}%${r ? `（${shortTime(r)} 重置）` : ""}`);
  }
  if (usage?.sevenDay) {
    const r = usage.sevenDay.resetsAt;
    if (!(r && Date.parse(r) < now)) parts.push(`7 天 ${usage.sevenDay.utilization}%`);
  }
  if (usage) tips.push(`额度数据来自 Claude Code 本地缓存，更新于 ${shortTime(usage.fetchedAt)}（Think 不会为此调用模型；在 Claude Code 里查看额度时会更新）`);
  if (rl && rl.status !== "allowed") parts.unshift(`额度受限${rl.resetsAt ? `，约 ${shortTime(rl.resetsAt)} 重置` : ""}`);
  if (rl) tips.push(`最近一次调用（${shortTime(rl.seenAt)}）：${rl.status}${rl.resetsAt ? `，${rl.type ?? ""} 额度 ${shortTime(rl.resetsAt)} 重置` : ""}`);
  const stale = usage && now - Date.parse(usage.fetchedAt) > 3600_000;
  return (
    <button className={`cli-status${p && !p.ok ? " bad" : ""}`} onClick={props.onClick} title={tips.join("\n")}>
      <span className={`dot ${p ? (p.ok ? "dot-ok" : "dot-failed") : "dot-idle"}`} />
      {p ? (p.ok ? "Claude Code 已连接" : "Claude Code 未连接") : "检测中…"}
      {parts.length > 0 && <span className={`usage${stale ? " stale" : ""}`}>{parts.join(" · ")}</span>}
    </button>
  );
}

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [list, setList] = useState<MapListResponse | null>(null);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [jobs, setJobs] = useState<Record<string, JobView>>({});
  const [revs, setRevs] = useState<Record<string, number>>({});
  const [tabs, setTabs] = useState<string[]>(() => {
    const saved = loadLocal<string[]>(TABS_KEY, []);
    const fromUrl = mapFromUrl();
    return fromUrl && !saved.includes(fromUrl) ? [...saved, fromUrl] : saved;
  });
  const [active, setActive] = useState<string | null>(() => mapFromUrl() ?? loadLocal<string | null>(ACTIVE_KEY, null));
  const [views, setViews] = useState<Record<string, MapViewKind>>(() => loadLocal(VIEWS_KEY, {}));
  const [opened, setOpened] = useState<Record<string, number>>(() => loadLocal(OPENED_KEY, {}));
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= NARROW);
  const [palette, setPalette] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStatus = useCallback(async (refresh = false) => {
    try {
      const s = await api.status(refresh);
      setStatus(s);
      setStatusError(null);
      return s;
    } catch (e) {
      setStatusError((e as Error).message);
      return null;
    }
  }, []);
  const refreshList = useCallback(async () => {
    try {
      const [l, t] = await Promise.all([api.listMaps(), api.listTrash()]);
      setList(l);
      setTrash(t.entries);
    } catch (e) {
      setStatusError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadStatus().then((s) => s && !s.config.privacy_notice_seen && setShowPrivacy(true));
    void refreshList();
    // 额度缓存可能被 Claude Code 更新：定期重新读取（不调用模型）
    const t = setInterval(() => void loadStatus(), 30_000);
    const unsub = subscribe(
      (e) => {
        if (e.type === "jobs") setJobs(e.jobs);
        if (e.type === "map") {
          setRevs((r) => ({ ...r, [e.name]: (r[e.name] ?? 0) + 1 }));
          void refreshList();
          void loadStatus();
        }
        if (e.type === "maps") void refreshList();
      },
      () => void refreshList(),
    );
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [loadStatus, refreshList]);
  // 服务端刚启动时 CLI 还在检测：稍后再问
  useEffect(() => {
    if (status && !status.provider) {
      const t = setTimeout(() => void loadStatus(), 1500);
      return () => clearTimeout(t);
    }
  }, [status, loadStatus]);

  // 标签页不随某一次列表结果增减（读取偶尔失败时不能把标签关掉、把当前图换掉）；删除时由 close() 关闭标签
  const liveTabs = tabs;
  // 记住每个图最近一次读到的标题：某次列表里暂时没有它时，标签和侧栏仍显示原标题
  const titles = useRef<Record<string, string>>({});
  for (const m of list?.maps ?? []) titles.current[m.name] = m.meta.title;
  const current = active && liveTabs.includes(active) ? active : (liveTabs[0] ?? null);

  useEffect(() => saveLocal(TABS_KEY, liveTabs), [liveTabs.join("\n")]);
  useEffect(() => {
    saveLocal(ACTIVE_KEY, current);
    if (current)
      setOpened((o) => {
        const next = { ...o, [current]: Date.now() };
        saveLocal(OPENED_KEY, next);
        return next;
      });
    history.replaceState(null, "", current ? `?map=${encodeURIComponent(current)}` : location.pathname);
  }, [current]);

  const open = (name: string, view?: MapViewKind) => {
    setTabs((t) => (t.includes(name) ? t : [...t, name]));
    setActive(name);
    if (view) setView(name, view);
    setOpened((o) => {
      const next = { ...o, [name]: Date.now() };
      saveLocal(OPENED_KEY, next);
      return next;
    });
    setPalette(false);
  };
  const close = (name: string) => {
    const i = liveTabs.indexOf(name);
    const rest = liveTabs.filter((t) => t !== name);
    setTabs(rest);
    if (current === name) setActive(rest[Math.min(i, rest.length - 1)] ?? null);
  };
  const setView = (name: string, v: MapViewKind) =>
    setViews((x) => {
      const next = { ...x, [name]: v };
      saveLocal(VIEWS_KEY, next);
      return next;
    });

  const showToast = (text: string, undo?: () => void) => {
    setToast({ text, undo });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 10_000);
  };

  const create = async (topic: string) => {
    try {
      const m = await api.createMap(topic);
      await refreshList();
      open(m.name, "chat");
    } catch (e) {
      showToast(`没能新建：${(e as Error).message}`);
    }
  };
  const rename = async (name: string, title: string) => {
    try {
      await api.renameMap(name, title);
      await refreshList();
    } catch (e) {
      showToast(`没能重命名：${(e as Error).message}`);
    }
  };
  const restore = async (entry: string) => {
    try {
      const { name } = await api.restoreTrash(entry);
      setToast(null);
      await refreshList();
      open(name);
    } catch (e) {
      showToast(`没能恢复：${(e as Error).message}`);
    }
  };
  const remove = async (name: string) => {
    const title = list?.maps.find((m) => m.name === name)?.meta.title ?? name;
    try {
      const { entry } = await api.deleteMap(name);
      close(name);
      await refreshList();
      showToast(`已删除「${title}」（移到回收站，30 天后清理）`, () => void restore(entry));
    } catch (e) {
      showToast(`没能删除：${(e as Error).message}`);
    }
  };
  const changeSettings = async (s: SettingsUpdate) => {
    const config = await api.saveSettings(s);
    setStatus((st) => (st ? { ...st, config } : st));
  };

  // Ctrl+K（Mac 上 ⌘K）：快速切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (statusError && !status) return <p className="warn home">⚠ {statusError}</p>;
  if (!status) return <p className="hint home">连接中…</p>;

  const maps = list?.maps ?? [];
  const summaries = new Map(maps.map((m) => [m.name, m]));
  const sorted = sortByRecent(maps, opened);
  const p = status.provider;
  return (
    <div className={`workbench${sidebar ? "" : " side-closed"}`}>
      <header className="topbar">
        <button className="side-toggle" onClick={() => setSidebar((v) => !v)} title={sidebar ? "收起侧栏" : "展开侧栏"} aria-expanded={sidebar}>
          ☰
        </button>
        <h1>Think</h1>
        <div className="tabs-bar" role="tablist">
          {liveTabs.map((t) => (
            <div key={t} className={`tab${t === current ? " on" : ""}`} role="tab" aria-selected={t === current} data-map={t}>
              <button className="tab-main" onClick={() => open(t)} title={summaries.get(t)?.meta.title ?? titles.current[t] ?? t}>
                <StatusDot summary={summaries.get(t)} job={jobs[t]} />
                <span className="t">{summaries.get(t)?.meta.title ?? titles.current[t] ?? t}</span>
              </button>
              <button className="tab-close" onClick={() => close(t)} title="关闭标签（不会停止 AI）">
                ✕
              </button>
            </div>
          ))}
        </div>
        <CliStatus status={status} onClick={() => setShowSettings(true)} />
        <button onClick={() => setShowSettings(true)} title="设置">
          ⚙
        </button>
      </header>
      {p?.apiKeyEnvSet && <div className="notice">检测到环境变量 ANTHROPIC_API_KEY：Think 调用 CLI 时会把它从子进程环境中移除，以使用你的订阅登录（不会按 API 计费）。</div>}
      {statusError && <div className="notice warn">⚠ {statusError}</div>}
      <div className="wb-body">
        {sidebar && (
          <Sidebar
            maps={sorted}
            broken={list?.broken ?? []}
            jobs={jobs}
            active={current}
            activeView={current ? (views[current] ?? "chat") : null}
            trash={trash}
            onCreate={create}
            onOpen={open}
            onRename={rename}
            onDelete={(n) => void remove(n)}
            onRestore={(e) => void restore(e)}
          />
        )}
        <section className="wb-main">
          {liveTabs.length === 0 && (
            <div className="empty-main">
              <p>在左侧新建一个图，或从列表里打开一个。</p>
              <p className="hint">Ctrl+K 可以按标题搜索，或直接新建。</p>
              {!sidebar && <button onClick={() => setSidebar(true)}>展开侧栏</button>}
            </div>
          )}
          {liveTabs.map((t) => (
            <div key={t} className={`tab-pane${t === current ? "" : " hidden"}`} data-map={t}>
              <MapView
                name={t}
                config={status.config}
                job={jobs[t]}
                rev={revs[t] ?? 0}
                maxParallel={status.maxParallel}
                view={views[t] ?? "chat"}
                onView={(v) => setView(t, v)}
                onChanged={() => void refreshList()}
              />
            </div>
          ))}
        </section>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast.text}
          {toast.undo && (
            <button className="primary" onClick={toast.undo}>
              撤销
            </button>
          )}
          <button onClick={() => setToast(null)}>✕</button>
        </div>
      )}
      {palette && <QuickSwitch maps={sorted} jobs={jobs} onOpen={(n) => open(n)} onCreate={(t) => void create(t).then(() => setPalette(false))} onClose={() => setPalette(false)} />}
      {showSettings && (
        <Settings
          status={status}
          onChange={changeSettings}
          onRecheck={() => void loadStatus(true)}
          onShowPrivacy={() => {
            setShowSettings(false);
            setShowPrivacy(true);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showPrivacy && (
        <PrivacyNotice
          status={status}
          onClose={() => {
            setShowPrivacy(false);
            if (!status.config.privacy_notice_seen) void changeSettings({ privacy_notice_seen: true });
          }}
        />
      )}
    </div>
  );
}
