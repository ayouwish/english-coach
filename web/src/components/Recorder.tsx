"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  onRecorded: (blob: Blob, durationMs: number) => void;
  disabled?: boolean;
  isChild?: boolean;
  recording?: boolean;
  /** 递增这个数字即可从外部触发一次录音（用于「跟我读」：示范音播完自动开录） */
  startSignal?: number;
  /**
   * 视觉主次。跟读页里「跟我读」才是主操作，这个按钮是次要入口，
   * 传 "secondary" 避免出现两个主色按钮、让用户不知道该点哪个。
   */
  emphasis?: "primary" | "secondary";
}

type MicState = "idle" | "preparing" | "recording" | "error";

/** 短于这个时长视为误触，不提交评测（省一次云端调用，也避免 0:00 的空录音） */
const MIN_RECORD_MS = 600;

/**
 * 浏览器录音（MediaRecorder，audio/webm;codecs=opus，契约 §0 允许的格式）。
 *
 * ## 麦克风的开启策略：**每次录音才申请，录完立即释放**
 * 早期版本为了消除"开头丢词"改成常驻复用一条流，但那样会导致
 * **音频输出被占住、示范音播不出来**（USB 耳麦会切到通话模式 / 系统把输出路由到通话通道）。
 * 对跟读练习来说"能听到示范音"优先级更高，所以恢复成按需开启：
 *
 *   click → 「麦克风准备中…」→（设备就绪）→ 自动开始录音 → 点「说完啦」→ 立即释放设备
 *
 * 这样做会带来 1–3 秒的开麦延迟（USB 耳麦冷启动）。为了避免用户"对着还没采集的麦克风说话"，
 * 按钮会**显式显示「麦克风准备中…」**，就绪后**自动开始录音**（不需要再点一次），
 * 用户看到按钮变成「⏹️ 说完啦 0s」再开口即可。
 *
 * 「跟我读」的顺序天然规避了冲突：**先播示范音（麦克风关着）→ 播完才开麦录音**。
 *
 * 隐私：麦克风只在你按下录音/跟我读之后才打开，停止或出错立即释放，不做任何后台录音。
 */
export function Recorder({
  onRecorded,
  disabled = false,
  isChild = false,
  recording = false,
  startSignal,
  emphasis = "primary",
}: Props) {
  const [isRecording, setIsRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [micState, setMicState] = useState<MicState>("idle");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number>(0);
  /** 正在取消：onstop 里据此丢弃录音（不调 onRecorded、不提交、不产生云端调用） */
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unmountedRef = useRef(false);

  /** 释放设备：这是"能继续播放声音"的关键，任何结束路径都必须走到 */
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setMicState((s) => (s === "error" ? s : "idle"));
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  /** 每次录音都重新申请：不做跨次复用，避免占住音频输出 */
  const acquireStream = useCallback(async (): Promise<MediaStream> => {
    setMicState("preparing");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    return stream;
  }, []);

  const beginRecording = useCallback(
    (stream: MediaStream) => {
      const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
      const mimeType = mimeCandidates.find(
        (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const durationMs = Date.now() - startedAtRef.current;
        stopTimer();
        setSeconds(0);
        setIsRecording(false);
        recorderRef.current = null;
        // ★ 立刻释放麦克风：让音频输出（示范音/回放）恢复正常 —— 取消路径同样必须走到这里
        releaseStream();
        // 取消：彻底丢弃，不触发 onRecorded（也就不会提交/评测/花钱）
        if (cancelledRef.current) {
          cancelledRef.current = false;
          chunksRef.current = [];
          setError(null);
          return;
        }
        // 太短多半是误触（点了开始又立刻点停止）：直接拦掉，别浪费一次云端评测
        if (durationMs < MIN_RECORD_MS) {
          setError(
            isChild
              ? "这次录得太短啦，点「按这里开始说」，读完句子再点「说完啦」😊"
              : `录音只有 ${(durationMs / 1000).toFixed(1)} 秒，太短了。请读完整个句子再点停止。`,
          );
          return;
        }
        setError(null);
        onRecorded(blob, durationMs);
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      // 250ms 分片：即使 stop 有过早触发，也尽量保住尾部数据
      recorder.start(250);
      setIsRecording(true);
      setMicState("recording");
      timerRef.current = setInterval(
        () => setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)),
        250,
      );
    },
    [onRecorded, releaseStream, stopTimer, isChild],
  );

  const start = useCallback(async () => {
    if (recorderRef.current?.state === "recording") return; // 已在录，不重复
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("这个浏览器不支持录音，建议换 Chrome / Edge 再试。");
      return;
    }
    try {
      const stream = await acquireStream();
      if (unmountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      beginRecording(stream);
    } catch (err) {
      setMicState("error");
      setError(
        `无法访问麦克风：${(err as Error).message}。请检查麦克风是否插好、系统是否允许浏览器使用麦克风。`,
      );
    }
  }, [acquireStream, beginRecording]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  /** 取消录音：停止 → 丢弃 → 释放麦克风（不调 onRecorded） */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stopTimer();
    setSeconds(0);
    setError(null);
    chunksRef.current = [];
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      rec.stop(); // onstop 里会 releaseStream() 并因 cancelledRef 直接 return
    } else {
      // 极端情况（还没进入 recording 就被取消）：直接释放设备
      setIsRecording(false);
      releaseStream();
    }
  }, [releaseStream, stopTimer]);

  // 卸载：确保设备一定被释放（否则会一直占着音频输出）
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      stopTimer();
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [stopTimer]);

  // 外部触发（「跟我读」：示范音播完自动开录）。用 ref 记住上一次信号，避免重复触发。
  const lastSignalRef = useRef<number>(0);
  useEffect(() => {
    if (!startSignal || startSignal === lastSignalRef.current) return;
    lastSignalRef.current = startSignal;
    if (!disabled && !recording) void start();
  }, [startSignal, disabled, recording, start]);

  const preparing = micState === "preparing";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {isRecording ? (
          <>
            <button type="button" className="ec-btn ec-recording bg-[#ef4444] text-white" onClick={stop}>
              ⏹️ {isChild ? "说完啦" : "停止录音"} {seconds}s
            </button>
            <button
              type="button"
              data-testid="record-cancel"
              aria-label={isChild ? "不要了，取消这次录音" : "取消这次录音"}
              onClick={cancel}
              className="ec-btn ec-btn-ghost"
            >
              ✖️ {isChild ? "不要了" : "取消"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`ec-btn ${emphasis === "primary" ? "ec-btn-primary" : "ec-btn-ghost"}`}
            onClick={() => void start()}
            disabled={disabled || recording || preparing}
            aria-busy={preparing}
          >
            🎤{" "}
            {preparing
              ? isChild
                ? "麦克风准备中…"
                : "正在打开麦克风…"
              : isChild
                ? "按这里开始说"
                : "开始录音"}
          </button>
        )}
        {recording ? (
          <span className="text-sm text-[var(--ec-muted)]">评测中…请稍候 ⏳</span>
        ) : preparing ? (
          <span className="text-sm text-[var(--ec-muted)]" data-testid="mic-preparing">
            正在打开麦克风，准备好会自动开始录音 ⏳
          </span>
        ) : null}
      </div>
      {error ? <p className="text-sm text-[#b45309]">{error}</p> : null}
    </div>
  );
}
