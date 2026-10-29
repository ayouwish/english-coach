/** 与 docs/api-contract.md §1–§9 一一对应的类型定义。 */

export type ProviderMode = "mock" | "local" | "cloud" | "hybrid";
export type AgeBand = "child" | "teen" | "adult";
export type Role = "parent" | "child";
export type ErrorType =
  | "None"
  | "Mispronunciation"
  | "Omission"
  | "Insertion"
  | "UnexpectedBreak"
  | "MissingBreak"
  | "Monotone";
export type Severity = "high" | "medium" | "low";
export type VoiceWarning =
  | "phoneme_level_unavailable"
  | "prosody_unavailable"
  | "intonation_unavailable"
  | "low_snr"
  | "too_short"
  | "asr_mismatch"
  | "provider_fallback";

export type VoiceErrorCode =
  | "bad_request"
  | "unsupported_audio"
  | "audio_too_long"
  | "payload_too_large"
  | "provider_error"
  | "provider_timeout"
  | "no_provider"
  | "audio_not_found"
  | "internal_error"
  | "voice_unreachable";

export interface VoiceCapabilities {
  phoneme_level: boolean;
  /** OCR（拍照识别，task-26）：voice 未实现/未启用时可能缺省或 false */
  ocr?: boolean;
  prosody: boolean;
  intonation_curve: boolean;
  nbest_phonemes: boolean;
  ssml: boolean;
  gpu: boolean;
}

export interface VoiceHealth {
  status: string;
  version: string;
  mode: ProviderMode;
  providers: Record<string, string>;
  capabilities: VoiceCapabilities;
}

export interface NBestPhoneme {
  phoneme: string;
  score: number;
}

export interface PhonemeDetail {
  phoneme: string;
  score: number | null;
  start_ms: number | null;
  end_ms: number | null;
  nbest?: NBestPhoneme[] | null;
}

export interface WordScore {
  word: string;
  start_ms: number | null;
  end_ms: number | null;
  score: number | null;
  error_type: ErrorType | null;
  phonemes?: PhonemeDetail[] | null;
}

export interface PronounceIssue {
  type: ErrorType;
  severity: Severity;
  word: string;
  phoneme?: string | null;
  expected?: string | null;
  actual?: string | null;
  score?: number | null;
  start_ms?: number | null;
  end_ms?: number | null;
  hint_key?: string | null;
}

export type F0Point = [number, number | null];

export interface WorstRegion {
  start_ms: number;
  end_ms: number;
  text: string;
  issue:
    | "expected_rise_but_flat"
    | "expected_fall_but_flat"
    | "wrong_direction"
    | "stress_misplaced"
    | "monotone_overall"
    | "unexpected_pause";
  user_slope: number | null;
  ref_slope: number | null;
}

export interface Intonation {
  available: boolean;
  dtw_distance: number | null;
  user_f0: F0Point[];
  reference_f0: F0Point[];
  worst_regions: WorstRegion[];
  reference_audio_url: string | null;
}

export interface PronounceScores {
  pron: number | null;
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  prosody: number | null;
}

export interface PronounceResult {
  provider: string;
  granularity: "phoneme" | "word";
  mode: "scripted" | "unscripted";
  reference_text: string;
  recognized_text: string;
  duration_ms: number;
  scores: PronounceScores;
  words: WordScore[];
  issues: PronounceIssue[];
  intonation: Intonation;
  warnings: VoiceWarning[];
  provider_meta?: Record<string, unknown>;
}

export interface OcrLine {
  text: string;
  confidence?: number | null;
}

export interface OcrResult {
  provider: string;
  text: string;
  /** voice 预处理后的 JPEG（base64，不含 data: 前缀）；voice 未实现时缺省 */
  image_jpeg_b64?: string | null;
  lines: OcrLine[];
  width?: number | null;
  height?: number | null;
  elapsed_ms?: number | null;
  warnings?: string[];
}

export interface AsrResult {
  text: string;
  language: string;
  duration_ms: number;
  words: { word: string; start_ms: number; end_ms: number; probability: number }[];
  provider: string;
}

export type CorrectionType = "grammar" | "vocabulary" | "politeness" | "pronunciation" | "none";

export interface DialogueCorrection {
  has_error: boolean;
  type: CorrectionType | null;
  original: string | null;
  better: string | null;
  explain_zh: string | null;
  severity: Severity | null;
}

export interface DialogueResult {
  provider: string;
  /** true = 本条不是大模型生成的（voice 侧降级为固定话术）；见契约 v1.4 §6 */
  degraded_llm?: boolean;
  reply: string;
  reply_zh: string | null;
  correction: DialogueCorrection;
  suggested_replies: string[];
  target_words: string[];
  flag: "ok" | "unsafe_filtered" | "off_topic";
  done: boolean;
}

export interface DialogueScenarioPayload {
  id: string;
  title: string;
  title_zh: string;
  setting_zh: string;
  role_prompt: string;
  opening_line: string;
  level: string;
  min_age: number;
}

export interface DialogueLearner {
  age_band: AgeBand;
  level: string;
  native_language: string;
  child_safe: boolean;
}

export interface FeedbackPoint {
  title: string;
  why: string;
  how: string;
  practice_words: string[];
  demo_text: string;
  severity: Severity;
}

export interface FeedbackResult {
  provider: string;
  summary: string;
  praise: string;
  points: FeedbackPoint[];
  closing: string;
}

/** POST /api/attempts 的响应（web 自己的形状，不是 voice 契约的一部分）。 */
export interface AttemptApiResponse {
  attempt_id: string;
  degraded: boolean;
  retryable: boolean;
  message: string;
  result: PronounceResult | null;
  feedback: FeedbackResult;
  usage: {
    minutes: number;
    limitMinutes: number;
    remainingMinutes: number;
    exceeded: boolean;
    attemptCount: number;
    chatTurnCount: number;
  };
}

export interface CapabilitySummary {
  reachable: boolean;
  mode: string;
  capabilities: VoiceCapabilities;
}

export interface SentenceItem {
  id: string;
  text: string;
  translation_zh: string;
  level: string;
  tags: string[];
  focus_phonemes: string[];
}
