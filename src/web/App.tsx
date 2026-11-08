import { useEffect, useMemo, useState } from "react";
import { findLoops } from "../core/loops";
import { previewPatch } from "../core/preview";
import type { HealthResponse } from "../server/api";
import { Graph as GraphSchema, type Graph } from "../core/schema";
import { initialVersion } from "../core/version";
import { applyEdgeAction, current, demoState, resolvePending, type DemoState } from "./demo";
import fixtures from "./fixtures/real-graphs.json";
import { GraphView, type Positions, type Selection } from "./GraphView";
import { LoopPanel, PatchPanel, SelectionPanel } from "./Panels";

// 调试用：?graph=<序号> 打开 runs/ 中真实生成的图；?fresh 忽略已保存的位置（看默认布局）
const params = new URLSearchParams(location.search);
const fixtureIndex = params.get("graph");
const fresh = params.has("fresh");
const POS_KEY = `think-demo-positions${fixtureIndex ? `-${fixtureIndex}` : ""}`;

function initialState(): DemoState {
  const f = fixtureIndex !== null ? (fixtures as { name: string; graph: unknown }[])[Number(fixtureIndex)] : undefined;
  if (!f) return demoState();
  const graph: Graph = GraphSchema.parse(f.graph);
  const v0 = initialVersion(graph.frame.topic, new Date().toISOString());
  return { versions: [{ ...v0, version: graph.version, graph }], patches: [], pending: null };
}

/** 位置只是方便：读写失败（如隐私模式）时照常工作 */
function loadPositions(): Positions {
  if (fresh) return {};
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? "{}") as Positions;
  } catch {
    return {};
  }
}
function savePositions(p: Positions) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    // 忽略
  }
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [state, setState] = useState<DemoState>(initialState);
  const [hoverLoop, setHoverLoop] = useState<string | null>(null);
  const [positions, setPositions] = useState<Positions>(loadPositions);
  const [selection, setSelection] = useState<Selection>(null);
  const [highlightLoop, setHighlightLoop] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const [accepted, setAccepted] = useState<Record<number, boolean>>({});
  const [hoverOp, setHoverOp] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const graph = current(state);
  const { loops, truncated } = useMemo(() => findLoops(graph), [graph]);
  const preview = useMemo(() => (state.pending ? previewPatch(graph, state.pending, state.patches) : null), [graph, state.pending, state.patches]);

  const onPositions = (p: Positions) => {
    setPositions(p);
    savePositions(p);
  };
  const reset = () => {
    setState(initialState());
    setAccepted({});
    setSelection(null);
    setHighlightLoop(null);
  };
  const relayout = () => onPositions({});

  return (
    <div className="app">
      <header>
        <h1>Think</h1>
        <span className="topic">{graph.frame.topic}</span>
        <span className="meta">
          {graph.version} · {fixtureIndex !== null ? `真实生成的图 #${fixtureIndex}` : "示例数据"}（M4）{health ? "" : " · 服务未连接"}
        </span>
        <div className="spacer" />
        <label className="toggle">
          <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} /> 显示已拒绝的
        </label>
        <button onClick={relayout}>重新布局</button>
        <button onClick={reset}>重置示例</button>
      </header>
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
        />
        <aside>
          <SelectionPanel graph={graph} selection={selection} locked={Boolean(state.pending)} onEdgeAction={(id, a, o) => setState((s) => applyEdgeAction(s, id, a, o))} />
          {state.pending && preview && (
            <PatchPanel
              graph={graph}
              patch={state.pending}
              preview={preview}
              accepted={accepted}
              onToggle={(i, v) => setAccepted((a) => ({ ...a, [i]: v }))}
              onHover={setHoverOp}
              onResolve={(choices) => {
                setState((s) => resolvePending(s, choices));
                setAccepted({});
                setHoverOp(null);
              }}
            />
          )}
          <LoopPanel graph={graph} loops={loops} truncated={truncated} highlight={highlightLoop} onClick={setHighlightLoop} onHover={setHoverLoop} />
          <div className="legend">
            <span className="pol pol-pos">→(+)</span> 同向　<span className="pol pol-neg">→(−)</span> 反向　<span className="pol pol-unk">→(?)</span> 未知　‖ 有延迟　⚑ 有争议　虚线：不确定　橙色虚框：AI 建议（预览）
          </div>
        </aside>
      </main>
    </div>
  );
}
