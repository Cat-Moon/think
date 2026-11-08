// 右侧面板：选中项详情与操作、补丁预览、回路列表。
// 所有修改都生成补丁：用户自己的编辑是 origin: user 的补丁（自动接受），AI 的建议由用户逐项处理。
import { useEffect, useState } from "react";
import { labeler } from "../core/describe";
import { findLoops, type Loop } from "../core/loops";
import { PatchError, applyOps, edgeActionOps, planDecisions, type Choices, type EdgeAction } from "../core/patch";
import type { Preview } from "../core/preview";
import type { Graph, Patch, PatchOp } from "../core/schema";
import type { Selection } from "./GraphView";

const POL = { "+": "+", "-": "−", "?": "?" } as const;

/** 一行文字输入 + 确认按钮（Enter 确认，Esc 取消） */
function InlineInput(props: { initial?: string; placeholder: string; confirm: string; danger?: boolean; onConfirm: (text: string) => void; onCancel: () => void; allowEmpty?: boolean }) {
  const [text, setText] = useState(props.initial ?? "");
  const ok = () => (props.allowEmpty || text.trim()) && props.onConfirm(text.trim());
  return (
    <div className="reason">
      <input autoFocus placeholder={props.placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? ok() : e.key === "Escape" && props.onCancel())} />
      <button className={props.danger ? "danger" : "primary"} onClick={ok} disabled={!props.allowEmpty && !text.trim()}>
        {props.confirm}
      </button>
      <button onClick={props.onCancel}>取消</button>
    </div>
  );
}

// ---------- 选中项 ----------

export function SelectionPanel(props: {
  graph: Graph;
  selection: Selection;
  /** 有待处理的 AI 建议时不能直接编辑 */
  locked: boolean;
  readOnly: boolean;
  onEdit: (ops: PatchOp[]) => void;
  onClose: () => void;
}) {
  const { graph, selection, locked, readOnly } = props;
  const [mode, setMode] = useState<null | "rename" | "note" | "delete" | "disagree">(null);
  useEffect(() => {
    setMode(null);
  }, [selection?.id]);
  if (!selection) return null;

  const close = (
    <button className="close" onClick={props.onClose} title="关闭">
      ✕
    </button>
  );
  const done = (ops: PatchOp[]) => {
    props.onEdit(ops);
    setMode(null);
  };
  const blocked = readOnly ? <p className="hint">正在查看旧版本（只读）。</p> : locked ? <p className="hint">先处理 AI 的建议，再修改图。</p> : null;

  const label = labeler(graph);
  if (selection.kind === "node") {
    const n = graph.nodes.find((x) => x.id === selection.id);
    if (!n)
      return (
        <div className="card">
          {close}
          <p className="hint">这个变量在 AI 的建议中，还没有加入图。</p>
        </div>
      );
    const ins = graph.edges.filter((e) => e.to === n.id && e.status !== "rejected").length;
    const outs = graph.edges.filter((e) => e.from === n.id && e.status !== "rejected").length;
    return (
      <div className="card">
        {close}
        <h3>{n.label}</h3>
        <p className="meta">
          {n.origin === "ai" ? "AI 提出" : "你添加"} · {n.status === "rejected" ? "已拒绝" : "已接受"} · 输入 {ins} 条，输出 {outs} 条
        </p>
        {n.note && <p>笔记：{n.note}</p>}
        {blocked ??
          (n.status === "rejected" ? null : (
            <>
              <div className="actions">
                <button onClick={() => setMode("rename")}>重命名</button>
                <button onClick={() => setMode("note")}>{n.note ? "改笔记" : "加笔记"}</button>
                <button className="danger" onClick={() => setMode("delete")}>
                  删除
                </button>
              </div>
              {mode === "rename" && <InlineInput initial={n.label} placeholder="新名称" confirm="重命名" onConfirm={(t) => t !== n.label && done([{ op: "update_node", id: n.id, label: t }])} onCancel={() => setMode(null)} />}
              {mode === "note" && <InlineInput initial={n.note} placeholder="笔记" confirm="保存" allowEmpty onConfirm={(t) => done([{ op: "update_node", id: n.id, note: t }])} onCancel={() => setMode(null)} />}
              {mode === "delete" && (
                <>
                  <p className="hint">删除等同于拒绝：变量保留在记录里，AI 之后不会再提出它。</p>
                  <InlineInput placeholder="理由（可不填，会告诉 AI）" confirm="确认删除" danger allowEmpty onConfirm={(t) => done([{ op: "remove_node", id: n.id, ...(t ? { reason: t } : {}) }])} onCancel={() => setMode(null)} />
                </>
              )}
            </>
          ))}
      </div>
    );
  }

  const e = graph.edges.find((x) => x.id === selection.id);
  if (!e)
    return (
      <div className="card">
        {close}
        <p className="hint">这条关系在 AI 的建议中，还没有加入图。</p>
      </div>
    );
  const act = (a: EdgeAction, opts?: { reason?: string; polarity?: "+" | "-" }) => done(edgeActionOps(e, a, opts));
  const status = { accepted: "已接受", uncertain: "不确定", rejected: "已拒绝" }[e.status];
  return (
    <div className="card">
      {close}
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
      {blocked ??
        (e.status === "rejected" ? (
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
              <button onClick={() => done([{ op: "update_edge", id: e.id, delay: !e.delay }])}>{e.delay ? "去掉延迟" : "有延迟"}</button>
              <button onClick={() => setMode("note")}>{e.note ? "改笔记" : "加笔记"}</button>
              <button className="danger" onClick={() => setMode("disagree")}>
                不同意
              </button>
            </div>
            {mode === "note" && <InlineInput initial={e.note} placeholder="笔记" confirm="保存" allowEmpty onConfirm={(t) => done([{ op: "update_edge", id: e.id, note: t }])} onCancel={() => setMode(null)} />}
            {mode === "disagree" && <InlineInput placeholder="理由（可不填，会告诉 AI）" confirm="确认不同意" danger allowEmpty onConfirm={(t) => act("disagree", { reason: t || undefined })} onCancel={() => setMode(null)} />}
          </>
        ))}
    </div>
  );
}

// ---------- 补丁预览 ----------

export function PatchPanel(props: {
  graph: Graph;
  patch: Patch;
  preview: Preview;
  accepted: Record<number, boolean>;
  /** 设置项：是否提示接受后程序会检测到的新回路（默认关闭） */
  showNewLoops: boolean;
  busy: boolean;
  onToggle: (index: number, value: boolean) => void;
  onHover: (index: number | null) => void;
  onResolve: (choices: Choices) => void;
}) {
  const { graph, patch, preview, accepted } = props;
  /** 拒绝的理由（可不填）：保存在补丁记录里，并在之后的对话中告诉 AI */
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [rejectAll, setRejectAll] = useState<string | null>(null);
  const reasonOf = (i: number) => reasons[i]?.trim() || undefined;
  const choices: Choices = Object.fromEntries(
    patch.ops.map((_, i) => [i, accepted[i] === false ? { decision: "rejected" as const, ...(reasonOf(i) ? { reason: reasonOf(i) } : {}) } : { decision: "accepted" as const }]),
  );

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
      {/* AI 的说明和问题放在最上面（对话里不再重复），列表再长也能先看到 */}
      {patch.message && <p>{patch.message}</p>}
      {patch.question && <p className="question">{patch.question}</p>}
      <p className="hint">取消勾选表示拒绝这一项，可以写一句理由（可不填）。处理完再回答上面的问题。</p>
      <ul className="ops">
        {preview.ops.map((o) => {
          const off = accepted[o.index] === false;
          return (
            <li key={o.index} className={`op op-${o.effect}${off || auto.has(o.index) ? " off" : ""}`} onMouseEnter={() => props.onHover(o.index)} onMouseLeave={() => props.onHover(null)}>
              <label>
                <input type="checkbox" checked={!off && !auto.has(o.index)} disabled={auto.has(o.index)} onChange={(ev) => props.onToggle(o.index, ev.target.checked)} />
                <span className="badge">{{ add: "新增", modify: "修改", remove: "去掉" }[o.effect]}</span>
                <span>{o.text}</span>
              </label>
              {o.reason && <p className="why">理由：{o.reason}</p>}
              {auto.has(o.index) && <p className="why warn">依赖的新变量没有被接受，这一项会自动拒绝</p>}
              {off && !auto.has(o.index) && (
                <input className="reject-reason" placeholder="为什么拒绝？（可不填，会告诉 AI）" value={reasons[o.index] ?? ""} onChange={(ev) => setReasons((r) => ({ ...r, [o.index]: ev.target.value }))} />
              )}
            </li>
          );
        })}
      </ul>
      {preview.bypasses.map((b) => (
        <p key={b} className="warn">
          ⚠ {b}
        </p>
      ))}
      {applyError && <p className="warn">⚠ 这个建议无法应用：{applyError}</p>}
      {props.showNewLoops && newLoops.length > 0 && (
        <p className="meta">
          接受后程序会检测到新的回路：{newLoops.map((l) => `${l.polarity === "?" ? "?" : l.polarity}（${[...l.nodes, l.nodes[0]!].map(label).join(" → ")}）`).join("；")}
        </p>
      )}
      {/* 接受 / 拒绝按钮固定在底部：列表很长时也不用滚动到最后 */}
      <div className="patch-footer">
      {rejectAll === null ? (
        <div className="actions">
          <button className="primary" disabled={props.busy || Boolean(applyError) || n === 0} onClick={() => props.onResolve(choices)}>
            接受选中的 {n} 项
          </button>
          <button disabled={props.busy} onClick={() => setRejectAll("")}>
            全部拒绝
          </button>
        </div>
      ) : (
        <div className="reason">
          <input autoFocus placeholder="理由（可不填，会告诉 AI）" value={rejectAll} onChange={(e) => setRejectAll(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setRejectAll(null)} />
          <button
            className="danger"
            disabled={props.busy}
            onClick={() => props.onResolve(Object.fromEntries(patch.ops.map((_, i) => [i, { decision: "rejected" as const, ...(rejectAll.trim() ? { reason: rejectAll.trim() } : {}) }])))}
          >
            确认全部拒绝
          </button>
          <button onClick={() => setRejectAll(null)}>取消</button>
        </div>
      )}
      </div>
    </div>
  );
}

// ---------- 回路 ----------

export function LoopPanel(props: { graph: Graph; loops: Loop[]; truncated: boolean; highlight: string | null; onClick: (id: string | null) => void; onHover: (id: string | null) => void }) {
  const label = labeler(props.graph);
  return (
    <div>
      {props.loops.length === 0 && <p className="hint">还没有回路。</p>}
      <ul className="loops">
        {props.loops.map((l) => (
          <li key={l.id} className={props.highlight === l.id ? "on" : ""} onClick={() => props.onClick(props.highlight === l.id ? null : l.id)} onMouseEnter={() => props.onHover(l.id)} onMouseLeave={() => props.onHover(null)}>
            <span className={`loop-badge loop-${l.polarity === "?" ? "U" : l.polarity}`}>{l.id}</span>
            <span>
              {[...l.nodes, l.nodes[0]!].map(label).join(" → ")}
              {l.uncertain && "（含不确定的关系）"}
              {l.edges.some((id) => props.graph.edges.find((e) => e.id === id)?.contested) && <span className="contested-note">（含有争议的关系 ⚑）</span>}
            </span>
          </li>
        ))}
      </ul>
      {props.truncated && <p className="warn">回路太多，只显示了前 200 个。</p>}
      <p className="hint">回路由程序根据关系和极性检测。R：增强，B：平衡，?：含极性未知的关系。回路较多时，图上只显示选中或鼠标所指回路的标记。</p>
    </div>
  );
}
