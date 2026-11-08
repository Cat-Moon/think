// 对话面板：消息列表、AI 回合进度（流式"思考中 / 正在写"，可取消）、失败后重试、输入框。
// 输入不丢：用户消息在调用 AI 之前就已保存在服务端；失败或取消后可以直接重试。
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Patch, Turn } from "../core/schema";

export interface Busy {
  startedAt: number;
  attempt: number;
  phase: "waiting" | "thinking" | "writing";
  chars: number;
  /** 重试的原因 */
  retryReason?: string;
  /** 正在发送的消息（服务端保存前先显示出来） */
  text?: string;
}

function useSeconds(since: number | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.floor((Date.now() - since) / 1000);
}

function patchSummary(p: Patch | undefined): string | null {
  if (!p) return null;
  if (!p.resolution) return "建议待处理";
  const d = p.resolution.decisions;
  const acc = d.filter((x) => x.decision === "accepted").length;
  const rej = d.length - acc;
  return acc === 0 ? "建议已全部拒绝" : `接受了 ${acc} 项${rej ? `，拒绝 ${rej} 项` : ""}`;
}

/** 一次 AI 回合失败的原因（来自服务端的 done 事件） */
export interface TurnFailure {
  kind: string;
  message: string;
  resetsAt?: string;
  violations?: string[];
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : `${d.getMonth() + 1}/${d.getDate()} `}${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
/** 原因的第一行，截短 */
const brief = (s: string) => {
  const line = s.split("\n")[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

/** 按类型说明失败原因 */
export function failureText(f: TurnFailure): { title: string; detail?: string } {
  switch (f.kind) {
    case "cancelled":
      return { title: "已取消" };
    case "timeout":
      return { title: "超时", detail: "AI 超过 3 分钟没有回复，已停止。" };
    case "rate_limit":
      return { title: "额度用完", detail: f.resetsAt ? `订阅额度已用完，约 ${hhmm(f.resetsAt)} 重置。` : "订阅额度已用完或请求过于频繁，请稍后再试。" };
    case "auth":
      return { title: "Claude Code 未登录", detail: "请在终端运行 claude 并登录，然后重试。" };
    case "not_installed":
      return { title: "找不到 Claude Code CLI", detail: brief(f.message) };
    case "invalid_output":
      return { title: "AI 的回复没有通过检查", detail: f.violations?.length ? brief(f.violations.join("；")) : brief(f.message) };
    default:
      return { title: "出错了", detail: brief(f.message) };
  }
}

export function ChatLog(props: {
  turns: Turn[];
  patches: Patch[];
  busy: Busy | null;
  error: TurnFailure | null;
  canRetry: boolean;
  onRetry: () => void;
  /** 放弃对话末尾没有回复的消息，把它放回输入框改写 */
  onAbandon: () => void;
  onCancel: () => void;
  /** 待处理的补丁对应的 AI 回合：它的说明和问题显示在建议卡片顶部，这里不重复 */
  hideTurn?: string | null;
  children?: ReactNode;
}) {
  const { turns, patches, busy } = props;
  const abandoned = new Set(turns.flatMap((t) => (t.abandoned_turn ? [t.abandoned_turn] : [])));
  const fail = props.error ? failureText(props.error) : null;
  const secs = useSeconds(busy?.startedAt ?? null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [turns.length, Boolean(busy), props.error, Boolean(props.children)]);

  const phase = busy ? { waiting: "等待 AI 回复", thinking: "思考中", writing: "正在写" }[busy.phase] : "";
  return (
    <div className="chat">
      {turns.length === 0 && !busy && <p className="hint">说一说你想弄明白的现象，AI 会先画一张小的起点图。图里的关系都是假设，由你逐项确认。</p>}
      {turns.map((t) =>
        t.turn_id === props.hideTurn ? null : t.role === "user" ? (
          <div key={t.turn_id} className={`msg user${abandoned.has(t.turn_id) ? " abandoned" : ""}`} title={abandoned.has(t.turn_id) ? "已放弃，没有发给 AI 处理" : undefined}>
            {t.text}
          </div>
        ) : t.role === "ai" ? (
          <div key={t.turn_id} className="msg ai">
            <p>{t.text}</p>
            {t.question && <p className="question">{t.question}</p>}
            {t.patch_id && <p className="meta">{patchSummary(patches.find((p) => p.patch_id === t.patch_id))}</p>}
          </div>
        ) : (
          <div key={t.turn_id} className="msg system meta">
            {t.text}
          </div>
        ),
      )}
      {busy?.text && <div className="msg user pending">{busy.text}</div>}
      {busy && (
        <div className="msg ai thinking">
          <span className="dots" aria-hidden>
            ●●●
          </span>{" "}
          {phase}
          {busy.phase !== "waiting" && busy.chars > 0 && `（${busy.chars} 字）`} · {secs} 秒{busy.attempt > 1 && ` · 第 ${busy.attempt} 次（上一次没通过检查，正在重试）`}
          <button className="cancel" onClick={props.onCancel}>
            取消
          </button>
        </div>
      )}
      {!busy && (fail || props.canRetry) && (
        <div className="msg error">
          {fail ? (
            <p>
              <b>⚠ {fail.title}</b>
              {fail.detail && <>：{fail.detail}</>}
            </p>
          ) : (
            <p>
              <b>上一条消息还没有得到回复。</b>
            </p>
          )}
          {props.canRetry && (
            <p>
              你的消息已保存。
              <button className="primary" onClick={props.onRetry}>
                重试
              </button>
              <button onClick={props.onAbandon} title="这条消息不再发给 AI，放回输入框，可以改写后重发">
                放弃这条消息
              </button>
            </p>
          )}
        </div>
      )}
      {props.children}
      <div ref={end} />
    </div>
  );
}

export function ChatInput(props: { draft: string; onDraft: (s: string) => void; onSend: () => void; disabled: string | null; busy: boolean }) {
  const can = !props.disabled && !props.busy && props.draft.trim().length > 0;
  return (
    <div className="chat-input">
      {props.disabled && <p className="hint">{props.disabled}</p>}
      <textarea
        rows={3}
        value={props.draft}
        placeholder="输入消息，Ctrl+Enter 发送"
        onChange={(e) => props.onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && can) {
            e.preventDefault();
            props.onSend();
          }
        }}
      />
      <button className="primary" disabled={!can} onClick={props.onSend}>
        发送
      </button>
    </div>
  );
}
