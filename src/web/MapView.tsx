// 一个 Map 的工作区（工作台右侧的一个标签页）：工具栏 + 图视图 + 右侧面板（选中项，以及对话 / 回路 / 版本 / 笔记之一）。
// 所有数据来自服务端的 Map 文件夹；节点位置写入 layout.json。
// AI 回合在服务端排队执行（job），这里只显示它的状态；切到别的图再回来，进度还在。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findLoops } from "../core/loops";
import type { Choices } from "../core/patch";
import { previewPatch } from "../core/preview";
import type { PatchOp, WorkspaceConfig } from "../core/schema";
import type { JobView, MapState } from "../server/api";
import { ChatInput, ChatLog, type Busy, type TurnFailure } from "./Chat";
import { api } from "./client";
import { GraphView, type Positions, type Selection } from "./GraphView";
import { freeSpotNear, nodeBoxes, nodeWidth } from "./layout";
import { LoopPanel, PatchPanel, SelectionPanel } from "./Panels";
import { Notes, Timeline } from "./Timeline";

/** 侧栏子项 / 工具栏上的视图：图、对话、回路、版本、笔记（与 Map 文件夹中的文件对应） */
export type MapViewKind = "graph" | "chat" | "loops" | "versions" | "notes";
export const VIEWS: { key: MapViewKind; label: string; file: string }[] = [
  { key: "graph", label: "图", file: "graph.json" },
  { key: "chat", label: "对话", file: "conversation.jsonl" },
  { key: "loops", label: "回路", file: "由程序从图中检测" },
  { key: "versions", label: "版本", file: "versions/" },
  { key: "notes", label: "笔记", file: "notes.md" },
];

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

export function MapView(props: {
  name: string;
  config: WorkspaceConfig;
  /** 服务端这个 Map 的 AI 回合（没有则为 undefined） */
  job: JobView | undefined;
  /** 服务端说这个 Map 变了时递增（回合结束等），用来重新读取 */
  rev: number;
  maxParallel: number;
  view: MapViewKind;
  onView: (v: MapViewKind) => void;
  /** 内容变了（列表里的变量数、回路数、状态需要刷新） */
  onChanged: () => void;
}) {
  const { name, config, job, view } = props;
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
  const [draft, setDraftState] = useState(() => loadDraft(name));
  /** 不能开始一轮时的原因（服务端拒绝，消息没有保存） */
  const [startError, setStartError] = useState<TurnFailure | null>(null);
  /** 连线：选好起点和终点后，选择极性（+ / − / ?）再新增，只产生一个版本 */
  const [newEdge, setNewEdge] = useState<{ from: string; to: string; rendered: { x: number; y: number } } | null>(null);
  const [working, setWorking] = useState(false);
  const [legendOpen, setLegendOpen] = useState(() => {
    try {
      return localStorage.getItem(LEGEND_KEY) !== "0";
    } catch {
      return true;
    }
  });
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
        // 新建的 Map：把主题预填进输入框
        if (s.turns.length === 0 && s.versions.length === 1 && !loadDraft(name)) setDraft(s.meta.title);
      },
      (e: Error) => setLoadError(e.message),
    );
  }, [name]);

  // 服务端说这个 Map 变了（回合开始或结束）：重新读取
  const firstRev = useRef(props.rev);
  useEffect(() => {
    if (props.rev !== firstRev.current) void reload();
  }, [props.rev, reload]);

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

  /** AI 正在这个图里思考或排队：不能修改图 */
  const thinking = job?.state === "running" || job?.state === "queued";
  const busy: Busy | null = thinking
    ? {
        startedAt: Date.parse(job.startedAt ?? job.queuedAt),
        attempt: job.attempt,
        phase: job.phase,
        chars: job.chars,
        queued: job.state === "queued",
        position: job.position,
        maxParallel: props.maxParallel,
      }
    : null;
  const failure: TurnFailure | null = job?.state === "failed" && job.error ? { ...job.error, violations: job.violations } : startError;

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
    props.onChanged();
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

  const connect = async (from: string, to: string, polarity: "+" | "-" | "?") => {
    setNewEdge(null);
    const before = new Set(graph?.edges.map((e) => e.id));
    const s = await edit([{ op: "add_edge", from, to, polarity, rationale: "" }]);
    const added = s?.versions.at(-1)!.graph.edges.find((e) => !before.has(e.id));
    if (added) setSelection({ kind: "edge", id: added.id });
  };

  /** 放弃对话末尾没有回复的消息：放回输入框，可以改写后重发 */
  const abandon = async () => {
    const last = state?.turns.at(-1);
    const s = await run(() => api.abandon(name));
    if (s && last?.role === "user" && !draft.trim()) setDraft(last.text);
    setStartError(null);
  };

  /** 开始一轮：服务端先保存消息再排队；不能开始时消息留在输入框 */
  const sendTurn = async (text: string | undefined) => {
    if (thinking) return;
    setStartError(null);
    try {
      await api.startTurn(name, text);
      if (text !== undefined) setDraft("");
    } catch (e) {
      setStartError({ kind: "rejected", message: (e as Error).message });
    }
    await reload();
    props.onChanged();
  };

  const cancel = () => void api.cancelTurn(name).catch((e: Error) => setNotice(e.message));

  // 选中的变量或关系从画面里消失（被去掉、被拒绝、切换版本、关掉"显示已拒绝的"）时，关闭详情卡片
  const visibleGraph = preview?.after ?? graph;
  useEffect(() => {
    if (!selection || !visibleGraph) return;
    const shownNode = (id: string) => visibleGraph.nodes.some((n) => n.id === id && (n.status !== "rejected" || showRejected));
    const ok =
      selection.kind === "node"
        ? shownNode(selection.id)
        : visibleGraph.edges.some((e) => e.id === selection.id && (e.status !== "rejected" || showRejected) && shownNode(e.from) && shownNode(e.to));
    if (!ok) setSelection(null);
  }, [visibleGraph, selection, showRejected]);

  if (loadError) return <p className="warn map-message">⚠ {loadError}</p>;
  if (!state || !graph || !latest) return <p className="hint map-message">读取中…</p>;

  const lastTurn = state.turns.at(-1);
  const canRetry = !thinking && lastTurn?.role === "user";
  const locked = Boolean(pending) || thinking;
  const inputDisabled = readOnly
    ? "正在查看旧版本。回到当前版本后才能继续对话。"
    : pending
      ? "先处理上面 AI 的建议（接受或拒绝），再继续对话。"
      : canRetry
        ? "上一条消息还没有 AI 回复：可以重试，或放弃它后改写重发。"
        : null;

  return (
    <div className="map-view">
      <div className="map-toolbar">
        <span className="meta">{readOnly ? `正在查看 ${viewing}（只读）· 当前是 ${latest.version}` : latest.version}</span>
        {readOnly && <button onClick={() => setViewing(null)}>回到当前</button>}
        <div className="views" role="tablist" title="与左侧子项相同">
          {VIEWS.map((v) => (
            <button key={v.key} className={view === v.key ? "on" : ""} onClick={() => props.onView(v.key)} title={v.file}>
              {v.label}
              {v.key === "loops" ? `（${loops.length}）` : v.key === "versions" ? `（${state.versions.length}）` : ""}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {!readOnly && (
          <>
            <button className={connectMode ? "primary" : ""} disabled={locked} onClick={() => setConnectMode((v) => !v)} title="依次点击起点和终点变量，再选择极性">
              {connectMode ? "退出连线" : "连线"}
            </button>
            <span className="meta hide-narrow">双击空白处新增变量</span>
          </>
        )}
        <label className="toggle">
          <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} /> 显示已拒绝的
        </label>
        {!readOnly && <button onClick={() => onPositions({})}>重新布局</button>}
      </div>
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
          connectMode={connectMode && !locked}
          onConnect={(from, to, rendered) => setNewEdge({ from, to, rendered })}
          onCanvasDblClick={locked || readOnly ? undefined : (model, rendered) => setNewNode({ model, rendered, label: "" })}
          onRelayout={() => onPositions({})}
        >
          {newEdge && (
            <div className="new-edge" style={{ left: newEdge.rendered.x, top: newEdge.rendered.y }}>
              <span className="meta">新关系的极性：</span>
              <button className="pol pol-pos" onClick={() => void connect(newEdge.from, newEdge.to, "+")} title="同向">
                +
              </button>
              <button className="pol pol-neg" onClick={() => void connect(newEdge.from, newEdge.to, "-")} title="反向">
                −
              </button>
              <button className="pol pol-unk" onClick={() => void connect(newEdge.from, newEdge.to, "?")} title="还不确定方向">
                ?
              </button>
              <button onClick={() => setNewEdge(null)}>取消</button>
            </div>
          )}
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
          {thinking && view !== "chat" && (
            <div className="canvas-status">
              {job.state === "queued" ? "AI 排队中…" : "AI 思考中…"} <button onClick={() => props.onView("chat")}>查看</button>
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
            <SelectionPanel
              graph={graph}
              selection={selection}
              locked={thinking ? "AI 正在这个图里思考，等它回复后再修改，或先取消。" : pending ? "先处理 AI 的建议，再修改图。" : null}
              readOnly={readOnly}
              onEdit={(ops) => {
                if (ops.some((o) => o.op === "remove_node")) setSelection(null); // 删除后不再显示它的详情
                void edit(ops);
              }}
              onClose={() => setSelection(null)}
            />
            {pending && view !== "chat" && (
              <p className="notice-inline">
                有待处理的 AI 建议。<button onClick={() => props.onView("chat")}>查看</button>
              </p>
            )}
            {view === "graph" && !selection && <p className="hint">点击一个变量或一条关系，在这里查看详情和修改。对话、回路、版本和笔记在上方或左侧切换。</p>}
            {view === "chat" && (
              <ChatLog
                turns={state.turns}
                patches={state.patches}
                busy={busy}
                error={failure}
                canRetry={canRetry && !readOnly}
                onRetry={() => void sendTurn(undefined)}
                onAbandon={() => void abandon()}
                onCancel={cancel}
                hideTurn={pending?.turn_id}
              >
                {pending && preview && (
                  <PatchPanel
                    key={pending.patch_id}
                    graph={graph}
                    patch={pending}
                    preview={preview}
                    accepted={accepted}
                    showNewLoops={config.show_new_loops}
                    busy={working || thinking}
                    onToggle={(i, v) => setAccepted((a) => ({ ...a, [i]: v }))}
                    onHover={setHoverOp}
                    onResolve={(c) => void resolve(c)}
                  />
                )}
              </ChatLog>
            )}
            {view === "loops" && <LoopPanel graph={graph} loops={loops} truncated={truncated} highlight={highlightLoop} onClick={setHighlightLoop} onHover={setHoverLoop} />}
            {view === "versions" && (
              <Timeline
                versions={state.versions}
                patches={state.patches}
                viewing={viewing}
                onView={setViewing}
                busy={working || thinking}
                onRestore={(v) => void run(() => api.restore(name, v)).then(() => setViewing(null))}
              />
            )}
            {view === "notes" && <Notes text={state.notes} onSave={(t) => api.saveNotes(name, t).then(() => undefined)} />}
            {state.skippedTurns > 0 && <p className="warn">对话记录中有 {state.skippedTurns} 行无法读取，已跳过。</p>}
          </div>
          {view === "chat" && <ChatInput draft={draft} onDraft={setDraft} onSend={() => void sendTurn(draft.trim())} disabled={inputDisabled} busy={thinking} />}
        </aside>
      </main>
    </div>
  );
}
