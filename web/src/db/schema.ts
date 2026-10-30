/**
 * Drizzle ORM schema —— 字段名严格对应 docs/api-contract.md §10（冻结）。
 * 迁移 SQL 见 migrations/0001_init.sql（DDL 的唯一事实来源）。
 */
import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  birthYear: integer("birth_year"),
  ageBand: text("age_band").notNull(),
  cefrLevel: text("cefr_level").notNull().default("A1"),
  nativeLanguage: text("native_language").notNull().default("zh"),
  avatar: text("avatar"),
  dailyLimitMinutes: integer("daily_limit_minutes").notNull().default(20),
  allowFreeChat: integer("allow_free_chat").notNull().default(1),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: text("user_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_sessions_user").on(t.userId)],
);

export const sentences = sqliteTable(
  "sentences",
  {
    id: text("id").primaryKey(),
    text: text("text").notNull(),
    translationZh: text("translation_zh").notNull(),
    level: text("level").notNull(),
    tags: text("tags").notNull().default("[]"),
    focusPhonemes: text("focus_phonemes").notNull().default("[]"),
    /** 'official' | 'parent'（契约 v1.1 §13.2） */
    source: text("source").notNull().default("official"),
    /** 家长自定义语料的归属；官方语料为 NULL */
    ownerUserId: text("owner_user_id"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("idx_sentences_level").on(t.level, t.sortOrder)],
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    sentenceId: text("sentence_id"),
    mode: text("mode").notNull().default("scripted"),
    referenceText: text("reference_text").notNull(),
    recognizedText: text("recognized_text"),
    scoresJson: text("scores_json"),
    issuesJson: text("issues_json"),
    intonationJson: text("intonation_json"),
    feedbackJson: text("feedback_json"),
    audioPath: text("audio_path"),
    refAudioUrl: text("ref_audio_url"),
    durationMs: integer("duration_ms"),
    warningsJson: text("warnings_json").notNull().default("[]"),
    /** 1 = 盲测产生的记录；不参与 phoneme_mastery / 趋势 / SRS（契约 §13.3） */
    isBlind: integer("is_blind").notNull().default(0),
    /** 这条 attempt 读的是哪个故事/材料（task-50）；NULL = 普通跟读 */
    materialId: text("material_id"),
    /** 异步评分状态（task-24）：pending | scoring | done | failed；历史行默认 done */
    status: text("status").notNull().default("done"),
    scoredAt: text("scored_at"),
    error: text("error"),
    blindTestId: text("blind_test_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_attempts_user_created").on(t.userId, t.createdAt),
    index("idx_attempts_blind").on(t.userId, t.isBlind, t.createdAt),
  ],
);

export const phonemeScores = sqliteTable(
  "phoneme_scores",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id").notNull(),
    userId: text("user_id").notNull(),
    word: text("word").notNull(),
    phoneme: text("phoneme").notNull(),
    score: real("score"),
    actual: text("actual"),
    errorType: text("error_type"),
    hintKey: text("hint_key"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_pscores_user_phoneme").on(t.userId, t.phoneme),
    index("idx_pscores_attempt").on(t.attemptId),
  ],
);

export const phonemeMastery = sqliteTable(
  "phoneme_mastery",
  {
    userId: text("user_id").notNull(),
    phoneme: text("phoneme").notNull(),
    attempts: integer("attempts").notNull().default(0),
    avgScore: real("avg_score"),
    bestScore: real("best_score"),
    lastScore: real("last_score"),
    trendJson: text("trend_json").notNull().default("[]"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.phoneme] })],
);

export const srsCards = sqliteTable(
  "srs_cards",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    ease: real("ease").notNull().default(2.5),
    intervalDays: integer("interval_days").notNull().default(0),
    dueAt: text("due_at").notNull(),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    lastGrade: text("last_grade"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_srs_due").on(t.userId, t.dueAt),
    uniqueIndex("srs_cards_user_kind_ref_unique").on(t.userId, t.kind, t.ref),
  ],
);

export const blindTests = sqliteTable(
  "blind_tests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    startedAt: text("started_at").notNull(),
    /** NULL = 进行中；进行中不得对外暴露任何分数（契约 §13.3） */
    endedAt: text("ended_at"),
    itemCount: integer("item_count").notNull().default(0),
    avgPron: real("avg_pron"),
    avgAccuracy: real("avg_accuracy"),
    avgFluency: real("avg_fluency"),
    avgIntonationDistance: real("avg_intonation_distance"),
    sentenceIdsJson: text("sentence_ids_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_blind_tests_user").on(t.userId, t.startedAt)],
);

export const chatScenarios = sqliteTable("chat_scenarios", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  titleZh: text("title_zh").notNull(),
  settingZh: text("setting_zh").notNull(),
  rolePrompt: text("role_prompt").notNull(),
  openingLine: text("opening_line").notNull(),
  level: text("level").notNull(),
  minAge: integer("min_age").notNull().default(6),
  tags: text("tags").notNull().default("[]"),
  enabled: integer("enabled").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    scenarioId: text("scenario_id").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    turnCount: integer("turn_count").notNull().default(0),
    summaryJson: text("summary_json"),
  },
  (t) => [index("idx_chat_sessions_user").on(t.userId, t.startedAt)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id").notNull(),
    role: text("role").notNull(),
    text: text("text").notNull(),
    textZh: text("text_zh"),
    correctionJson: text("correction_json"),
    flag: text("flag"),
    audioPath: text("audio_path"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_chat_messages_session").on(t.chatSessionId, t.createdAt)],
);

export const practiceSessions = sqliteTable(
  "practice_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    minutes: real("minutes").notNull().default(0),
    itemCount: integer("item_count").notNull().default(0),
  },
  (t) => [index("idx_practice_user_started").on(t.userId, t.startedAt)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    ts: text("ts").notNull(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    detailJson: text("detail_json").notNull().default("{}"),
  },
  (t) => [index("idx_audit_ts").on(t.ts)],
);

/** 「提建议」（task-23）：家里人在使用中随手留建议，家长集中查看并导出。 */
export const suggestions = sqliteTable(
  "suggestions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    userRole: text("user_role"),
    page: text("page"),
    category: text("category"),
    content: text("content").notNull(),
    contextJson: text("context_json"),
    status: text("status").notNull().default("open"),
    createdAt: text("created_at").notNull(),
    handledAt: text("handled_at"),
  },
  (t) => [
    index("idx_suggestions_created").on(t.createdAt),
    index("idx_suggestions_status").on(t.status, t.createdAt),
  ],
);

/** 书页材料库（task-29）：识别的文本 + voice 预处理后的 JPEG，供连读反复练习。 */
export const readingMaterials = sqliteTable(
  "reading_materials",
  {
    id: text("id").primaryKey(),
    createdBy: text("created_by"),
    title: text("title").notNull(),
    text: text("text").notNull(),
    imagePath: text("image_path"),
    sentenceCount: integer("sentence_count").notNull().default(0),
    source: text("source").notNull().default("photo"),
    /** page = 拍照书页（历史行默认）；story = 孩子讲的故事（task-49） */
    kind: text("kind").notNull().default("page"),
    /** 故事的中文原稿（"你说"那一栏） */
    sourceZh: text("source_zh"),
    /** 难度 A1/A2/B1/B2（故事改写用） */
    level: text("level"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_materials_created").on(t.createdAt)],
);

/** 复述记录（task-50 P3）：读完之后"讲给我听"的评估结果，挂在故事上。 */
export const storyRetells = sqliteTable(
  "story_retells",
  {
    id: text("id").primaryKey(),
    materialId: text("material_id"),
    userId: text("user_id"),
    storySentencesJson: text("story_sentences_json"),
    transcript: text("transcript"),
    coverage: real("coverage"),
    coveredJson: text("covered_json"),
    missingJson: text("missing_json"),
    feedbackZh: text("feedback_zh"),
    feedbackEn: text("feedback_en"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_story_retells_material").on(t.materialId, t.createdAt)],
);

/** web 私有扩展表：纠正强度 / 音色 / 语速偏好（不改动契约冻结列）。 */
export const userPrefs = sqliteTable("user_prefs", {
  userId: text("user_id").primaryKey(),
  correctionLevel: text("correction_level").notNull().default("gentle"),
  ttsVoice: text("tts_voice"),
  ttsRate: text("tts_rate").notNull().default("normal"),
  updatedAt: text("updated_at").notNull(),
});
