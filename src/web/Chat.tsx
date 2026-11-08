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

export function ChatLog(props: { turns: Turn[]; patches: Patch[]; busy: Busy | null; error: string | null; canRetry: boolean; onRetry: () => void; onCancel: () => void; children?: ReactNode }) {
  const { turns, patches, busy } = props;
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
        t.role === "user" ? (
          <div key={t.turn_id} className="msg user">
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
      {!busy && (props.error || props.canRetry) && (
        <div className="msg error">
          {props.error && <p>⚠ {props.error}</p>}
          {props.canRetry && (
            <p>
              你的消息已保存。
              <button className="primary" onClick={props.onRetry}>
                重试
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
