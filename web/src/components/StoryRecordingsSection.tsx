import type { RecordingView } from "@/lib/story-recordings";
import { RecordingRetryButton } from "./RecordingRetryButton";

/**
 * 「🎙️ 我的录音」（task-77，服务端渲染）：最近 20 条故事录音。
 * 显示时间/状态/时长/转录文字，可回放原始录音；失败的可重试转录。
 */
export function StoryRecordingsSection({ items, isChild }: { items: RecordingView[]; isChild: boolean }) {
  return (
    <section className="ec-card" data-testid="story-recordings">
      <h2 className="text-base font-extrabold">🎙️ 我的录音</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        {isChild ? "你说过的故事都存着啦，随时可以再听一遍。" : "录音原始文件已保存；转录失败也能重试，不用重录。"}
      </p>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--ec-muted)]" data-testid="story-recordings-empty">
          还没有录音，点上面的「🎤 说中文」讲一个吧。
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((r) => (
            <li key={r.id} className="rounded-lg bg-[#f8f9ff] p-2 text-sm" data-testid="story-recording-item">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-[var(--ec-muted)]">{new Date(r.created_at).toLocaleString("zh-CN")}</span>
                {r.status === "transcribed" ? (
                  <span className="rounded-full bg-[#e8f7ee] px-2 py-0.5 text-xs text-[#166534]">已转录</span>
                ) : r.status === "failed" ? (
                  <span className="rounded-full bg-[#fff3d6] px-2 py-0.5 text-xs text-[#7a4d00]">转录失败</span>
                ) : (
                  <span className="rounded-full bg-[#eef0f8] px-2 py-0.5 text-xs">待转录</span>
                )}
                {r.provider ? <span className="text-xs text-[var(--ec-muted)]">provider: {r.provider}</span> : null}
                {r.size_bytes ? <span className="text-xs text-[var(--ec-muted)]">{(r.size_bytes / 1024).toFixed(0)} KB</span> : null}
              </div>
              {r.status === "transcribed" && r.transcript_zh ? (
                <p className="mt-1 break-words">{r.transcript_zh}</p>
              ) : (
                <p className="mt-1 text-xs text-[#7a4d00]" data-testid="story-recording-failed-hint">
                  录音已保存，可以重试转录（不用重录）。
                  {r.error ? `（${r.error}）` : ""}
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <audio controls preload="metadata" src={r.audio_url} data-testid="story-recording-audio" className="h-8 w-56" />
                {r.status !== "transcribed" ? <RecordingRetryButton recordingId={r.id} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
