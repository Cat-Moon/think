// 一个 Map 的工作界面：图视图 + 右侧（选中项、对话与 AI 建议、回路、版本与笔记）。
// 所有数据来自服务端的 Map 文件夹；节点位置写入 layout.json。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findLoops } from "../core/loops";
import type { Choices } from "../core/patch";
import { previewPatch } from "../core/preview";
import type { PatchOp, WorkspaceConfig } from "../core/schema";
import type { MapState } from "../server/api";
import { api, streamTurn } from "./client";
import { ChatInput, ChatLog, type Busy } from "./Chat";
import { GraphView, type Positions, type Selection } from "./GraphView";
import { freeSpotNear, nodeBoxes, nodeWidth } from "./layout";
import { LoopPanel, PatchPanel, SelectionPanel } from "./Panels";
import { Notes, Timeline } from "./Timeline";

type Tab = "chat" | "loops" | "versions";

/** 本机便利：每个 Map 未发送的草稿（读写失败时照常工作） */
const draftKey = (name: string) => `think-draft:${name}`;
const loadDraft = (name: string) => {
  try {
    return localStorage.getItem(draftKey(name)) ?? "";
  } catch {
    return "";
  }
};
const saveDraft = (name: string, text: string) => {
  try {
    if (text) localStorage.setItem(draftKey(name), text);
    else localStorage.removeItem(draftKey(name));
  } catch {
    // 忽略
  }
};
const LEGEND_KEY = "think-legend-open";

export function MapView(props: { name: string; config: WorkspaceConfig; onBack: () => void; onSettings: () => void }) {
  const { name, config } = props;
  const [state, setState] = useState<MapState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [positions, setPositionsState] = useState<Positions>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [highlightLoop, setHighlightLoop] = useState<string | null>(null);
  const [hoverLoop, setHoverLoop] = useState<string | null>(null);
  const [showAllLoops, setShowAllLoops] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [accepted, setAccepted] = useState<Record<number, boolean>>({});
  const [hoverOp, setHoverOp] = useState<number | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [newNode, setNewNode] = useState<{ model: { x: number; y: number }; rendered: { x: number; y: number }; label: string } | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [draft, setDraftState] = useState(() => loadDraft(name));
  const [busy, setBusy] = useState<Busy | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [legendOpen, setLegendOpen] = useState(() => {
    try {
      return localStorage.getItem(LEGEND_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const abort = useRef<AbortController | null>(null);
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setDraft = (t: string) => {
    setDraftState(t);
    saveDraft(name, t);
  };

  const reload = useCallback(async () => {
    try {
      const s = await api.getMap(name);
      setState(s);
      // 服务端的布局（例如双击新增变量时写入的位置）与本地尚未保存的位置合并
      setPositionsState((p) => ({ ...s.layout.positions, ...p }));
      if (s.repairs.length) setNotice(`打开时自动修复：${s.repairs.join("；")}`);
      return s;
    } catch (e) {
      setLoadError((e as Error).message);
      return null;
    }
  }, [name]);

  useEffect(() => {
    void api.getMap(name).then(
      (s) => {
        setState(s);
        setPositionsState(s.layout.positions);
        if (s.repairs.length) setNotice(`打开时自动修复：${s.repairs.join("；")}`);
      },
      (e: Error) => setLoadError(e.message),
    );
    return () => abort.current?.abort();
  }, [name]);

  // 位置写入 layout.json（拖动后稍等再写，避免频繁写盘）
  const onPositions = (p: Positions) => {
    setPositionsState(p);
    if (layoutTimer.current) clearTimeout(layoutTimer.current);
    layoutTimer.current = setTimeout(() => void api.saveLayout(name, p).catch((e: Error) => setNotice(`位置没有保存：${e.message}`)), 400);
  };

  const latest = state?.versions.at(-1);
  const shown = viewing ? state?.versions.find((v) => v.version === viewing) : latest;
  const graph = shown?.graph;
  const readOnly = Boolean(viewing);
  const pending = !readOnly ? (state?.patches.find((p) => p.resolution === null) ?? null) : null;
  const { loops, truncated } = useMemo(() => (graph ? findLoops(graph) : { loops: [], truncated: false }), [graph]);
  const preview = useMemo(() => (graph && pending ? previewPatch(graph, pending, state!.patches) : null), [graph, pending, state]);

  /** 写操作：执行后重新读取 Map；出错时显示原因 */
  const run = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice((e as Error).message);
    }
    const s = await reload();
    setWorking(false);
    return s;
  };

  const edit = (ops: PatchOp[], newPositions?: Record<string, { x: number; y: number }>) => run(() => api.edit(name, ops, newPositions));

  const resolve = async (choices: Choices) => {
    if (!pending) return;
    const s = await run(() => api.resolve(name, pending.patch_id, choices));
    setAccepted({});
    setHoverOp(null);
    // 没被接受的预览变量：去掉它们的临时位置
    if (s) {
      const ids = new Set(s.versions.at(-1)!.graph.nodes.map((n) => n.id));
      const kept = Object.fromEntries(Object.entries(positions).filter(([id]) => ids.has(id)));
      if (Object.keys(kept).length !== Object.keys(positions).length) onPositions(kept);
    }
  };

  const connect = async (from: string, to: string) => {
    const before = new Set(graph?.edges.map((e) => e.id));
    const s = await edit([{ op: "add_edge", from, to, polarity: "?", rationale: "" }]);
    const added = s?.versions.at(-1)!.graph.edges.find((e) => !before.has(e.id));
    if (added) setSelection({ kind: "edge", id: added.id }); // 极性默认"?"，在右侧可以改
  };

  const sendTurn = async (text: string | undefined) => {
    if (busy) return;
    const ac = new AbortController();
    abort.current = ac;
    setTurnError(null);
    setTab("chat");
    if (text !== undefined) setDraft("");
    setBusy({ startedAt: Date.now(), attempt: 1, phase: "waiting", chars: 0, text });
    let done;
    try {
      done = await streamTurn(
        name,
        text,
        (e) =>
          setBusy((b) =>
            !b ? b : e.type === "attempt" ? { ...b, attempt: e.attempt, retryReason: e.reason, phase: "waiting", chars: 0 } : { ...b, attempt: e.attempt, phase: e.phase, chars: e.chars },
          ),
        ac.signal,
      );
    } catch (e) {
      done = { type: "done" as const, ok: false as const, error: { kind: "cli_error", message: (e as Error).message }, saved: false };
    }
    setBusy(null);
    abort.current = null;
    const s = await reload();
    const last = s?.turns.at(-1);
    const saved = last?.role === "user";
    if (!done.ok) {
      // 消息没有保存（例如有待处理的建议）：放回输入框，不丢
      if (text !== undefined && !(saved && last?.text === text) && !draft) setDraft(text);
      setTurnError(`${done.error.message}${done.ok === false && done.violations?.length ? `：${done.violations.join("；")}` : ""}`);
    }
  };

  const cancel = () => abort.current?.abort();

  if (loadError)
    return (
      <div className="home">
        <p className="warn">⚠ {loadError}</p>
        <button onClick={props.onBack}>返回</button>
      </div>
    );
  if (!state || !graph || !latest) return <p className="hint home">读取中…</p>;

  const lastTurn = state.turns.at(-1);
  const canRetry = !busy && lastTurn?.role === "user";
  const inputDisabled = readOnly ? "正在查看旧版本。回到当前版本后才能继续对话。" : pending ? "先处理上面 AI 的建议（接受或拒绝），再继续对话。" : canRetry ? "上一条消息还没有 AI 回复，可以先重试。" : null;

  return (
    <div className="app">
      <header>
        <button onClick={props.onBack}>← 全部</button>
        <span className="topic">{state.meta.title}</span>
        <span className="meta">
          {readOnly ? `正在查看 ${viewing}（只读）· 当前是 ${latest.version}` : latest.version}
        </span>
        {readOnly && <button onClick={() => setViewing(null)}>回到当前</button>}
        <div className="spacer" />
        {!readOnly && (
          <>
            <button className={connectMode ? "primary" : ""} disabled={Boolean(pending)} onClick={() => setConnectMode((v) => !v)} title="依次点击起点和终点变量，新增一条关系（极性默认 ?）">
              {connectMode ? "退出连线" : "连线"}
            </button>
            <span className="meta">双击空白处新增变量</span>
          </>
        )}
        <label className="toggle">
          <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} /> 显示已拒绝的
        </label>
        {!readOnly && <button onClick={() => onPositions({})}>重新布局</button>}
        <button onClick={props.onSettings} title="设置">
          ⚙
        </button>
      </header>
      {notice && (
        <div className="notice">
          {notice} <button onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
      <main>
        <GraphView
          graph={graph}
          loops={loops}
          preview={preview}
          accepted={accepted}
          hoverOp={hoverOp}
          positions={positions}
          onPositions={onPositions}
          selection={selection}
          onSelect={setSelection}
          highlightLoop={highlightLoop}
          hoverLoop={hoverLoop}
          onLoopClick={setHighlightLoop}
          showRejected={showRejected}
          showAllLoops={showAllLoops}
          onToggleAllLoops={() => setShowAllLoops((v) => !v)}
          readOnly={readOnly}
          connectMode={connectMode && !pending}
          onConnect={(a, b) => void connect(a, b)}
          onCanvasDblClick={pending || readOnly ? undefined : (model, rendered) => setNewNode({ model, rendered, label: "" })}
          onRelayout={() => onPositions({})}
        >
          {newNode && (
            <div className="new-node" style={{ left: newNode.rendered.x, top: newNode.rendered.y }}>
              <input
                autoFocus
                placeholder="新变量的名称"
                value={newNode.label}
                onChange={(e) => setNewNode({ ...newNode, label: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setNewNode(null);
                  if (e.key === "Enter" && newNode.label.trim()) {
                    const n = newNode;
                    setNewNode(null);
                    // 双击的位置离已有变量太近时，就近找空位（不压住已有变量）
                    const spot = freeSpotNear(n.model, nodeWidth(n.label.trim()), nodeBoxes(graph, positions));
                    void edit([{ op: "add_node", ref: "$new", label: n.label.trim() }], { $new: spot });
                  }
                }}
                onBlur={() => setNewNode(null)}
              />
              <span className="meta">Enter 确认 · Esc 取消</span>
            </div>
          )}
          <details
            className="legend"
            open={legendOpen}
            onToggle={(e) => {
              const open = (e.target as HTMLDetailsElement).open;
              setLegendOpen(open);
              try {
                localStorage.setItem(LEGEND_KEY, open ? "1" : "0");
              } catch {
                // 忽略
              }
            }}
          >
            <summary>图例</summary>
            <div>
              <span className="pol pol-pos">→(+)</span> 同向　<span className="pol pol-neg">→(−)</span> 反向　<span className="pol pol-unk">→(?)</span> 未知　‖ 有延迟
            </div>
            <div>
              <span className="swatch contested" /> 紫色描边加 ⚑：有争议　<span className="swatch dashed" /> 虚线：你标为不确定
            </div>
            <div>
              <span className="swatch ghost" /> 橙色：AI 建议（尚未接受）　<span className="swatch ghost-mod" /> 粗橙描边加"改"：建议修改
            </div>
            <div>
              <span className="swatch selected" /> 蓝色描边：选中　<span className="loop-badge loop-R">R</span> 增强回路　<span className="loop-badge loop-B">B</span> 平衡回路
            </div>
          </details>
        </GraphView>
        <aside>
          <div className="aside-scroll">
            <SelectionPanel graph={graph} selection={selection} locked={Boolean(pending)} readOnly={readOnly} onEdit={(ops) => {
                if (ops.some((o) => o.op === "remove_node")) setSelection(null); // 删除后不再显示它的详情
                void edit(ops);
              }} onClose={() => setSelection(null)} />
            <div className="tabs">
              {(
                [
                  ["chat", "对话"],
                  ["loops", `回路（${loops.length}）`],
                  ["versions", `版本与笔记（${state.versions.length}）`],
                ] as const
              ).map(([k, t]) => (
                <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                  {t}
                </button>
              ))}
            </div>
            {pending && tab !== "chat" && (
              <p className="notice-inline">
                有待处理的 AI 建议。<button onClick={() => setTab("chat")}>查看</button>
              </p>
            )}
            {tab === "chat" && (
              <ChatLog turns={state.turns} patches={state.patches} busy={busy} error={turnError} canRetry={canRetry && !readOnly} onRetry={() => void sendTurn(undefined)} onCancel={cancel}>
                {pending && preview && (
                  <PatchPanel
                    key={pending.patch_id}
                    graph={graph}
                    patch={pending}
                    preview={preview}
                    accepted={accepted}
                    showNewLoops={config.show_new_loops}
                    busy={working}
                    onToggle={(i, v) => setAccepted((a) => ({ ...a, [i]: v }))}
                    onHover={setHoverOp}
                    onResolve={(c) => void resolve(c)}
                  />
                )}
              </ChatLog>
            )}
            {tab === "loops" && <LoopPanel graph={graph} loops={loops} truncated={truncated} highlight={highlightLoop} onClick={setHighlightLoop} onHover={setHoverLoop} />}
            {tab === "versions" && (
              <>
                <Timeline versions={state.versions} patches={state.patches} viewing={viewing} onView={setViewing} busy={working} onRestore={(v) => void run(() => api.restore(name, v)).then(() => setViewing(null))} />
                <h3>笔记</h3>
                <Notes text={state.notes} onSave={(t) => api.saveNotes(name, t).then(() => undefined)} />
              </>
            )}
            {state.skippedTurns > 0 && <p className="warn">对话记录中有 {state.skippedTurns} 行无法读取，已跳过。</p>}
          </div>
          {tab === "chat" && <ChatInput draft={draft} onDraft={setDraft} onSend={() => void sendTurn(draft.trim())} disabled={inputDisabled} busy={Boolean(busy)} />}
        </aside>
      </main>
    </div>
  );
}
