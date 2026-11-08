// 右侧面板：选中项详情与点按按钮、补丁预览、回路列表。
import { useState } from "react";
import { labeler } from "../core/describe";
import { findLoops, type Loop } from "../core/loops";
import { PatchError, applyOps, planDecisions, type Choices, type EdgeAction } from "../core/patch";
import type { Preview } from "../core/preview";
import type { Graph, Patch } from "../core/schema";
import type { Selection } from "./GraphView";

const POL = { "+": "+", "-": "−", "?": "?" } as const;

// ---------- 选中项 ----------

export function SelectionPanel(props: {
  graph: Graph;
  selection: Selection;
  locked: boolean;
  onEdgeAction: (edgeId: string, action: EdgeAction, opts?: { reason?: string; polarity?: "+" | "-" }) => void;
}) {
  const { graph, selection, locked } = props;
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  if (!selection) return <p className="hint">点击一条关系，可以表示同意、修改或不同意；点击回路标记（R / B / ?）可以高亮整个回路。</p>;

  const label = labeler(graph);
  if (selection.kind === "node") {
    const n = graph.nodes.find((x) => x.id === selection.id);
    if (!n) return <p className="hint">（这个变量在补丁预览中，还没有加入图）</p>;
    const ins = graph.edges.filter((e) => e.to === n.id && e.status !== "rejected").length;
    const outs = graph.edges.filter((e) => e.from === n.id && e.status !== "rejected").length;
    return (
      <div className="card">
        <h3>{n.label}</h3>
        <p className="meta">
          {n.origin === "ai" ? "AI 提出" : "你添加"} · {n.status === "rejected" ? "已拒绝" : "已接受"} · 输入 {ins} 条，输出 {outs} 条
        </p>
        {n.note && <p>笔记：{n.note}</p>}
      </div>
    );
  }

  const e = graph.edges.find((x) => x.id === selection.id);
  if (!e) return <p className="hint">（这条关系在补丁预览中，还没有加入图）</p>;
  const act = (a: EdgeAction, opts?: { reason?: string; polarity?: "+" | "-" }) => {
    props.onEdgeAction(e.id, a, opts);
    setAsking(false);
    setReason("");
  };
  const status = { accepted: "已接受", uncertain: "不确定", rejected: "已拒绝" }[e.status];
  return (
    <div className="card">
      <h3>
        {label(e.from)} <span className={`pol pol-${e.polarity === "+" ? "pos" : e.polarity === "-" ? "neg" : "unk"}`}>→({POL[e.polarity]})</span> {label(e.to)}
      </h3>
      <p className="meta">
        {e.origin === "ai" ? "AI 提出" : "你添加"} · {status}
        {e.delay && " · ‖ 有延迟"}
        {e.contested && " · ⚑ 有争议"}
      </p>
      {e.rationale && <p>理由：{e.rationale}</p>}
      {e.note && <p>笔记：{e.note}</p>}
      {locked ? (
        <p className="hint">先处理下面 AI 的建议，再修改图。</p>
      ) : e.status === "rejected" ? (
        <div className="actions">
          <button onClick={() => act("agree")}>重新启用</button>
        </div>
      ) : (
        <>
          <div className="actions">
            <button onClick={() => act("agree")} disabled={e.status === "accepted"}>
              同意
            </button>
            {e.polarity === "?" ? (
              <>
                <button onClick={() => act("flip_polarity", { polarity: "+" })}>极性定为 +</button>
                <button onClick={() => act("flip_polarity", { polarity: "-" })}>极性定为 −</button>
              </>
            ) : (
              <button onClick={() => act("flip_polarity")}>极性相反</button>
            )}
            <button onClick={() => act("reverse")}>方向反了</button>
            <button onClick={() => act("uncertain")} disabled={e.status === "uncertain"}>
              不确定
            </button>
            <button className="danger" onClick={() => setAsking(true)}>
              不同意
            </button>
          </div>
          {asking && (
            <div className="reason">
              <input autoFocus placeholder="理由（可不填）" value={reason} onChange={(ev) => setReason(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && act("disagree", { reason: reason.trim() || undefined })} />
              <button className="danger" onClick={() => act("disagree", { reason: reason.trim() || undefined })}>
                确认不同意
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------- 补丁预览 ----------

export function PatchPanel(props: {
  graph: Graph;
  patch: Patch;
  preview: Preview;
  accepted: Record<number, boolean>;
  onToggle: (index: number, value: boolean) => void;
  onHover: (index: number | null) => void;
  onResolve: (choices: Choices) => void;
}) {
  const { graph, patch, preview, accepted } = props;
  const choices: Choices = Object.fromEntries(patch.ops.map((_, i) => [i, { decision: accepted[i] === false ? ("rejected" as const) : ("accepted" as const) }]));

  // 按当前勾选算出自动拒绝的项，以及接受后图里会检测到的回路（由代码计算）
  let auto = new Set<number>();
  let loopsAfter: Loop[] | null = null;
  let applyError: string | null = preview.error;
  try {
    const decisions = planDecisions(patch.ops, choices);
    auto = new Set(decisions.filter((d) => d.auto).map((d) => d.op_index));
    const ok = decisions.filter((d) => d.decision === "accepted").map((d) => ({ index: d.op_index, op: patch.ops[d.op_index]! }));
    loopsAfter = findLoops(applyOps(graph, ok, patch.origin)).loops;
  } catch (e) {
    if (!(e instanceof PatchError)) throw e;
    applyError = e.message;
  }
  const before = new Set(findLoops(graph).loops.map((l) => l.edges.join()));
  const newLoops = loopsAfter?.filter((l) => !before.has(l.edges.join())) ?? [];
  const label = labeler(preview.after ?? graph);
  const n = patch.ops.filter((_, i) => accepted[i] !== false && !auto.has(i)).length;

  return (
    <div className="card patch">
      <h3>AI 的建议</h3>
      {patch.message && <p>{patch.message}</p>}
      <ul className="ops">
        {preview.ops.map((o) => (
          <li key={o.index} className={`op op-${o.effect}${accepted[o.index] === false || auto.has(o.index) ? " off" : ""}`} onMouseEnter={() => props.onHover(o.index)} onMouseLeave={() => props.onHover(null)}>
            <label>
              <input type="checkbox" checked={accepted[o.index] !== false && !auto.has(o.index)} disabled={auto.has(o.index)} onChange={(ev) => props.onToggle(o.index, ev.target.checked)} />
              <span className="badge">{{ add: "新增", modify: "修改", remove: "去掉" }[o.effect]}</span>
              <span>{o.text}</span>
            </label>
            {o.reason && <p className="why">理由：{o.reason}</p>}
            {auto.has(o.index) && <p className="why warn">依赖的新变量没有被接受，这一项会自动拒绝</p>}
          </li>
        ))}
      </ul>
      {preview.bypasses.map((b) => (
        <p key={b} className="warn">
          ⚠ {b}
        </p>
      ))}
      {applyError && <p className="warn">⚠ 这个建议无法应用：{applyError}</p>}
      {newLoops.length > 0 && (
        <p className="meta">
          接受后程序会检测到新的回路：{newLoops.map((l) => `${l.polarity === "?" ? "?" : l.polarity}（${[...l.nodes, l.nodes[0]!].map(label).join(" → ")}）`).join("；")}
        </p>
      )}
      {patch.question && <p className="question">{patch.question}</p>}
      <div className="actions">
        <button className="primary" disabled={Boolean(applyError) || n === 0} onClick={() => props.onResolve(choices)}>
          接受选中的 {n} 项
        </button>
        <button onClick={() => props.onResolve({})}>全部拒绝</button>
      </div>
    </div>
  );
}

// ---------- 回路 ----------

export function LoopPanel(props: { graph: Graph; loops: Loop[]; truncated: boolean; highlight: string | null; onClick: (id: string | null) => void; onHover: (id: string | null) => void }) {
  const label = labeler(props.graph);
  return (
    <div className="card">
      <h3>回路（程序检测）</h3>
      {props.loops.length === 0 && <p className="hint">还没有回路。</p>}
      <ul className="loops">
        {props.loops.map((l) => (
          <li key={l.id} className={props.highlight === l.id ? "on" : ""} onClick={() => props.onClick(props.highlight === l.id ? null : l.id)} onMouseEnter={() => props.onHover(l.id)} onMouseLeave={() => props.onHover(null)}>
            <span className={`loop-badge loop-${l.polarity === "?" ? "U" : l.polarity}`}>{l.id}</span>
            <span>
              {[...l.nodes, l.nodes[0]!].map(label).join(" → ")}
              {l.uncertain && "（含不确定的关系）"}
            </span>
          </li>
        ))}
      </ul>
      {props.truncated && <p className="warn">回路太多，只显示了前 200 个。</p>}
      <p className="hint">R：增强，B：平衡，?：含极性未知的关系。由代码根据极性计算。回路较多时，图上只显示选中或鼠标所指回路的标记。</p>
    </div>
  );
}
