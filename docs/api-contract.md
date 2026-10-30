# 接口契约 v1.8（FROZEN · 2026-10-30）

> **本文件是唯一事实来源（single source of truth）。**

## 变更记录

| 日期 | 版本 | 变更 | 兼容性 |
|---|---|---|---|
| 2026-10-22 | v1.0 | 初版：7 个端点 + 数据库 schema | — |
| 2026-10-22 | v1.1 | 新增 `POST /v1/warmup`（§12）、`provider_meta.cache`；数据库新增盲测表与 `attempts.is_blind` / `sentences.owner_user_id`（§13） | **向后兼容**：新端点、新字段均可选，v1.0 的客户端不受影响 |
| 2026-10-23 | v1.2 | **修正 §12.2 缓存 key**：加入 TTS provider 身份与 `"v2"` 版本前缀，避免跨 provider 命中错误缓存 | **缓存失效**（可再生，重新预热即可）；**接口形状不变**，客户端无感 |
| 2026-10-23 | v1.3 | §12.2 缓存 key 再加 `fmt` 分量并升到 `"v3"`：TTS 格式设置修复后音频从 16kHz 变 24kHz，且 mp3/wav 是不同产物；`/v1/tts` 接入同一套缓存 | **缓存失效一次**（重新预热即可）；`/v1/tts` 响应新增 `X-Cache` 与 `X-Audio-Codec/Sample-Rate/Container` 观测头 |
| 2026-10-24 | v1.4 | §6 `/v1/dialogue` 响应新增**可选**字段 `degraded_llm`（`true` = 本条不是大模型生成，走了模板降级）；修正 prompt 质量约束（年龄适配/连续性/纠错分级） | **向后兼容**：新字段可选，v1.3 客户端无感 |
| 2026-10-29 | v1.5 | 新增 §14 `POST /v1/ocr`（拍照识别）与 `capabilities.ocr` / `ocr_provider`；错误码表新增 `provider_unavailable`(503)。OCR **默认走 LLM 视觉**（DeepSeek 多模态），本地 rapidocr 降为可选兜底 | **向后兼容**：新增接口/可选字段；`provider` 取值随部署而变，客户端不得写死 |
| 2026-10-30 | v1.6 | `/v1/health` 新增 `providers_effective`（实际可用 provider）与 `degraded`（降级详情，空对象=健康）；**禁止静默降级**：配置的 provider 不可用时 TTS/ASR/PA 返回 503 `provider_unavailable`，不再回落 mock 返回 200 | 向后兼容（新增字段；行为变更：此前会静默返回 mock 音频/结果，属 bug 修复）|
| 2026-10-30 | v1.7 | `/v1/asr` 的 `language` 支持 `zh`/`zh-CN`（响应回显规范化 locale）；新增 §15 `POST /v1/story/rewrite`（中文讲述→分级英文改写）| 向后兼容：新增端点与可选枚举值 |
| 2026-10-30 | v1.8 | 新增 §16 `POST /v1/story/retell`（复述覆盖度评估，鼓励优先、不评发音分）；`warnings` 新增 `feedback_template` | 向后兼容：新增端点 |
> `web/` 与 `voice/` 两个模块并行开发，任何一方需要改本契约，必须先通知 Lead 并同步改本文件。
> 冻结范围：路径、请求字段名、响应字段名、枚举值、错误码。
> 未冻结范围：各 provider 内部实现、日志格式、额外字段（允许追加 `provider_meta` 等可选字段，不得删除或改名已有字段）。

## 0. 模块边界

```
浏览器 ──HTTP──► web (Next.js :3000) ──HTTP──► voice (FastAPI :8100) ──► 云 API / 本地模型
                     │                              │
                     │ SQLite + 本地音频文件         └── ASR / 发音评测 / TTS / LLM 反馈 / 对话
                     └ 账号、会话、错音本、SRS、家长面板
```

**设计原则：web 不直接持有任何模型密钥，所有 AI 调用都经过 voice（AI Gateway）。**
好处：密钥集中一处、web 可以在 `PROVIDER_MODE=mock` 下完全离线开发、模型可整体替换。

- 服务端调用地址：`VOICE_SERVICE_URL`（compose 内为 `http://voice:8100`）。
- 浏览器**不**直接访问 voice，只有音频播放走 web 的反向代理：`/voice/*` → `http://voice:8100/*`
  （Next.js `rewrites` 配置）。因此契约里返回的音频 URL 一律写成 `/voice/v1/audio/<id>`（同源相对路径）。
- 统一 16kHz 单声道 PCM16 作为内部音频标准；上传音频接受 `audio/webm;codecs=opus`（浏览器 MediaRecorder 默认）、
  `audio/wav`、`audio/mp4`、`audio/ogg`。voice 内部用 PyAV/ffmpeg 转 16k mono。

---

## 1. `GET /v1/health`

用于 compose healthcheck 与 web 启动自检。

```json
{
  "status": "ok",
  "version": "0.1.0",
  "mode": "mock",
  "providers": { "asr": "mock", "pa": "mock", "tts": "mock", "llm": "mock" },
  "providers_effective": { "asr": "mock", "pa": "mock", "tts": "mock", "llm": "template" },
  "degraded": {},
  "capabilities": {
    "phoneme_level": false,
    "prosody": false,
    "intonation_curve": true,
    "nbest_phonemes": false,
    "ssml": false,
    "gpu": false,
    "ocr": false
  }
}
```

- **`providers_effective`（v1.6 新增）**：**实际可用**的 provider（与 `providers` 的配置值区分）。
  配置了 azure 但 SDK 缺失时，`providers.tts` 仍是 `"azure"`，而 `providers_effective.tts` 为 `"none"`。
- **`degraded`（v1.6 新增）**：降级详情，**空对象 `{}` 表示健康**；否则形如
  `{"tts": {"configured": "azure", "effective": "none", "reason": "...is not installed"}}`。
  **语义要求（v1.6 的行为契约）**：非 `mock` 模式下，配置的 provider 不可用时，TTS/ASR/PA **必须返回 503 `provider_unavailable`**，
  **不得**回落到 mock 后返回 200 —— 把合成音当"母语者示范"返回是事故（2026-10-29 真实发生过）。
  回落到的若是**真实 provider**（hybrid 下的 local/piper/gop）则允许 200。
- `mode` ∈ `mock` | `local` | `cloud` | `hybrid`。
- `capabilities` 决定 UI 降级：`phoneme_level=false` 时前端只显示单词级热力图，不显示 IPA；
  **`ocr`（v1.5 新增，bool）**：拍照识别是否可用 = **任一 OCR provider 可用**（LLM 视觉已配置，或本地 OCR 依赖已装）。
  `false` 时前端必须把「拍照识别」按钮置灰或明确提示"未启用"，**不允许让用户点了一直转圈**。
  **`ocr_provider`（v1.5 新增，`"llm" | "local" | null`）**：实际首选的 OCR provider（自检/排查用）。
  默认 `llm`（DeepSeek 多模态为主），`local` 仅在装了本地依赖且 LLM 不可用时出现。
  **`heic`（v1.5 新增，bool）**：是否支持 HEIC/HEIF 解码（iPhone 相册照片默认格式）。
  `false` 时前端应在**上传前**拦下 HEIC 并提示改用「拍照」或先存为 JPEG。
  **UI 必须按 capabilities 自适应，不允许硬编码假设。**

---

## 2. `POST /v1/asr`

`multipart/form-data`：`audio`(file, 必填)、`language`(str, 默认 `en`)、`prompt`(str, 可选，热词/上下文)。

```json
{
  "text": "I think the weather is really nice today",
  "language": "en",
  "duration_ms": 3420,
  "words": [
    { "word": "I", "start_ms": 0, "end_ms": 120, "probability": 0.98 },
    { "word": "think", "start_ms": 140, "end_ms": 430, "probability": 0.71 }
  ],
  "provider": "faster_whisper"
}
```

---

## 3. `POST /v1/pronounce` ★ 核心接口

`multipart/form-data`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `audio` | file | ✅ | 用户录音 |
| `reference_text` | str | ✅ | 跟读模式的参考文本；自由说模式传空串 |
| `mode` | str | | `scripted`(默认) \| `unscripted` |
| `granularity` | str | | `phoneme`(默认) \| `word`（provider 能力不足时自动降级并在 warnings 里说明） |
| `with_intonation` | bool | | 默认 `true`，计算 F0+DTW 语调对比 |
| `tts_voice` | str | | 生成示范音频用的音色，默认 provider 默认音色 |
| `tts_rate` | str | | `normal`(默认) \| `slow` |
| `learner_age_band` | str | | `child` \| `teen` \| `adult`，影响示范音频语速 |

响应（HTTP 200）：

```json
{
  "provider": "azure",
  "granularity": "phoneme",
  "mode": "scripted",
  "reference_text": "I think the weather is really nice today.",
  "recognized_text": "I think the weather is really nice today",
  "duration_ms": 3420,
  "scores": {
    "pron": 72.0,
    "accuracy": 78.0,
    "fluency": 80.0,
    "completeness": 100.0,
    "prosody": 61.0
  },
  "words": [
    {
      "word": "think",
      "start_ms": 420,
      "end_ms": 800,
      "score": 55.0,
      "error_type": "Mispronunciation",
      "phonemes": [
        {
          "phoneme": "θ",
          "score": 41.0,
          "start_ms": 430,
          "end_ms": 500,
          "nbest": [
            { "phoneme": "s", "score": 100.0 },
            { "phoneme": "f", "score": 62.0 }
          ]
        }
      ]
    }
  ],
  "issues": [
    {
      "type": "Mispronunciation",
      "severity": "high",
      "word": "think",
      "phoneme": "θ",
      "expected": "θ",
      "actual": "s",
      "score": 41.0,
      "start_ms": 430,
      "end_ms": 500,
      "hint_key": "th_voiceless"
    }
  ],
  "intonation": {
    "available": true,
    "dtw_distance": 0.42,
    "user_f0": [[0, 180.2], [20, 182.0], [40, null]],
    "reference_f0": [[0, 195.0], [20, 194.2], [40, null]],
    "worst_regions": [
      {
        "start_ms": 1180,
        "end_ms": 1620,
        "text": "really nice",
        "issue": "expected_rise_but_flat",
        "user_slope": -0.2,
        "ref_slope": 3.1
      }
    ],
    "reference_audio_url": "/voice/v1/audio/ref_7f3a91c2.wav"
  },
  "warnings": ["phoneme_level_unavailable"],
  "provider_meta": {}
}
```

### 3.1 字段约定（严格遵守）

- `scores.*`：`0–100` 浮点。不可得的项为 `null`（不是 0，不是 -1）。
- `scores.pron`：综合分。provider 直接给就用 provider 的；否则按 `0.4*最差 + 0.2*次差 + 0.2*第三 + 0.2*最好`（四项时）。
- `error_type` ∈ `"None" | "Mispronunciation" | "Omission" | "Insertion" | "UnexpectedBreak" | "MissingBreak" | "Monotone"`。
- `issues[].severity` ∈ `"high" | "medium" | "low"`。**映射规则由 voice 决定，web 不再重算。**
- `issues` 已按严重度降序排序，最多 5 条。UI 只展示前 2 条（教学原则：一次别纠太多）。
- `issues[].hint_key`：可选的教学提示键，web 用它映射到本地化的口型/舌位提示文案。
  可用键：`th_voiceless` `th_voiced` `r_l_v` `v_w` `short_i_long_i` `ae_e` `s_sh` `n_ng` `l_dark` `schwa` `final_consonant` `consonant_cluster` `stress_wrong` `monotone` `pause_wrong` `omission` `insertion`。
- `user_f0` / `reference_f0`：`[time_ms, f0_hz|null]` 二元组数组，**20ms 步长，最多 600 个点**（超过则等间隔抽稀）；
  `null` 表示该帧清音/无基频。两条曲线必须使用**同一时间轴与同一长度**（已 DTW 对齐）。
- `worst_regions[].issue` ∈ `"expected_rise_but_flat" | "expected_fall_but_flat" | "wrong_direction" | "stress_misplaced" | "monotone_overall" | "unexpected_pause"`。
- `intonation.dtw_distance`：已做半音归一化（各自减去自身浊音段 F0 均值再取 `12*log2`）后的归一化距离，越小越接近。
  **语调计算不依赖云 API**，任何 provider 下都应可用；不可用时 `available=false` 且其余字段为 `null`。
- `warnings` ∈ `"phoneme_level_unavailable"` `"prosody_unavailable"` `"intonation_unavailable"` `"low_snr"` `"too_short"` `"asr_mismatch"` `"provider_fallback"`。
  **降级必须显式暴露，不许静默给假分数。**

### 3.2 各 provider 的能力矩阵

| provider | 音素级 | NBest | Prosody | 说明 |
|---|---|---|---|---|
| `azure` | ✅ | ✅ | ✅(仅 en-US) | 首选。脚本化模式算 completeness/omission |
| `xfyun` | ✅ | ➖ | ➖ | 国内替代（留接口位，V1 不实现） |
| `local` | ❌(词级) | ❌ | ❌ | faster-whisper 词级置信度 + 时长/停顿 + 文本比对；**必须**带 `phoneme_level_unavailable` warning |
| `mock` | ✅(假数据) | ✅ | ✅ | 确定性、离线、可复现，用于 E2E 测试与无密钥开发 |

**红线：绝不允许拿 ASR 置信度冒充音素级发音分。** `local` 的词级分数必须走独立字段并在 UI 上标注为"单词级（粗）"。

---

## 4. `POST /v1/tts`

`application/json`：

```json
{ "text": "think, thank, three", "voice": "en-US-JennyNeural", "rate": "slow", "format": "mp3", "ssml": null }
```

- `rate` ∈ `"slow" | "normal"`。`slow` 教学场景用（Azure 侧转 `prosody rate="-30%"`）。
- `ssml` 非空时优先使用（仅 `ssml` 能力为 true 的 provider 支持），否则用 `text`。
- 响应：**二进制音频**，`Content-Type: audio/mpeg`(mp3) 或 `audio/wav`，附响应头 `X-TTS-Provider`、`X-Audio-Duration-Ms`。
- 文本长度上限 2000 字符，超限 413。

---

## 5. `POST /v1/feedback`

把评测 JSON 转成"人话"中文反馈。`application/json`：

```json
{
  "reference_text": "I think the weather is really nice today.",
  "scores": { "pron": 72, "accuracy": 78, "fluency": 80, "completeness": 100, "prosody": 61 },
  "issues": [ { "type": "Mispronunciation", "word": "think", "phoneme": "θ", "actual": "s", "score": 41 } ],
  "intonation": { "dtw_distance": 0.42, "worst_regions": [{ "text": "really nice", "issue": "expected_rise_but_flat" }] },
  "learner": { "age_band": "child", "level": "A2", "native_language": "zh" }
}
```

响应：

```json
{
  "provider": "deepseek",
  "summary": "整句读得很完整，节奏也不错 👍",
  "praise": "weather 和 really 都读得很清楚。",
  "points": [
    {
      "title": "think 里的 /θ/ 读成了 /s/",
      "why": "舌尖没有伸出来，气流从牙龈缝隙出去了。",
      "how": "舌尖轻轻伸到上下齿之间，让气流从缝里摩擦出来，声带不振动。",
      "practice_words": ["think", "thank", "three", "thick"],
      "demo_text": "think, thank, three",
      "severity": "high"
    }
  ],
  "closing": "再来一遍试试？我读一次你跟读 🔊"
}
```

- `points` 最多 2 条（**硬约束**，由 voice 侧 prompt + 截断双重保证）。
- **儿童模式额外约束**：`learner.age_band == "child"` 时，文案必须避开 IPA 符号，用"音"和口型描述代替；
  语气必须鼓励；不得出现任何批评性词汇。
- LLM 不可用时：voice 返回**模板化反馈**（基于 `hint_key` 查表），`provider` 字段为 `"template"`，HTTP 仍 200。
  **离线也必须能给出可用反馈。**

---

## 6. `POST /v1/dialogue`

日常对话训练的单轮推进。`application/json`：

```json
{
  "scenario": {
    "id": "ordering_coffee",
    "title": "Ordering coffee",
    "title_zh": "在咖啡店点单",
    "setting_zh": "你是一名咖啡店店员，学习者是顾客。",
    "role_prompt": "You are a friendly barista. Keep each reply under 15 words. Ask one question at a time.",
    "opening_line": "Hi there! What can I get for you today?",
    "level": "A2",
    "min_age": 6
  },
  "learner": { "age_band": "child", "level": "A2", "native_language": "zh", "child_safe": true },
  "history": [
    { "role": "assistant", "text": "Hi there! What can I get for you today?" },
    { "role": "user", "text": "I want a coffee." }
  ],
  "correction_level": "gentle",
  "turn_index": 1
}
```

响应：

```json
{
  "provider": "deepseek",
  "degraded_llm": false,
  "reply": "Sure! Hot or iced?",
  "reply_zh": "好的！热的还是冰的？",
  "correction": {
    "has_error": true,
    "type": "politeness",
    "original": "I want a coffee.",
    "better": "I'd like a coffee, please.",
    "explain_zh": "点单时用 I'd like 比 I want 更礼貌。",
    "severity": "low"
  },
  "suggested_replies": ["Hot, please.", "Iced, please."],
  "target_words": ["iced", "hot"],
  "flag": "ok",
  "done": false
}
```

- `correction.type` ∈ `"grammar" | "vocabulary" | "politeness" | "pronunciation" | "none"`；无错时 `has_error=false`，其余字段为 `null`。
- `correction_level` ∈ `"gentle"`(默认，只纠1处且语气轻) `| "standard"` `| "none"`(纯聊天不纠错)。
- `suggested_replies`：2–3 条**学习者当前水平能说出口**的应答，点击即用（儿童模式必备，降低开口门槛）。
- `flag` ∈ `"ok" | "unsafe_filtered" | "off_topic"`；`unsafe_filtered` 时 `reply` 必须已被替换为安全内容。
- **`degraded_llm`**（v1.4 新增，可选布尔）：`true` 表示**本条回复不是大模型生成的**（LLM 未配置 / 超时 / 输出非法 JSON 重试后仍失败 → 走 `template` 固定话术）。
  - 前端**必须**在 `degraded_llm=true` 时给出提示（例如"离线对话：当前未接入大模型"），否则用户会把按轮次念的固定台词误认为智能对话——这种误解不会报错，只会让产品显得很笨。
  - 与 `provider` 的关系：降级时 `provider="template"` 且 `degraded_llm=true`；正常时 `provider` 是实际模型（`deepseek` / `openai_compatible` / `ollama` …）且 `degraded_llm=false`。**两者不得互相矛盾。**
- `done` 为 `true` 表示本场景该收尾了（`turn_index >= 6` 或 LLM 判定）。

---

## 7. `GET /v1/audio/{audio_id}`

返回 voice 自己生成的示范音频（TTS 生成的参考音），`audio/wav` 或 `audio/mpeg`。
`audio_id` 由 voice 内部生成（`ref_<sha1前12位>.<ext>`），**只读、可缓存、`Cache-Control: public, max-age=604800`**。
找不到 → 404 `{"error":{"code":"audio_not_found","message":"..."}}`。

---

## 8. 统一错误格式

任何非 2xx：

```json
{ "error": { "code": "provider_error", "message": "human readable", "detail": {} } }
```

`code` ∈ `"bad_request"` `"unsupported_audio"` `"audio_too_long"` `"payload_too_large"` `"provider_error"` `"provider_timeout"` `"no_provider"` `"audio_not_found"` `"internal_error"` `"provider_unavailable"`。

> **`provider_unavailable`（503，v1.5 新增）**：**能力依赖未安装**（例如离线 OCR 的 rapidocr 没装）。
> 与 `no_provider`（没配置任何 provider）语义不同：前者"装了就能用"，后者"没配"。`message` 必须给出可执行的安装提示。

- 状态码：400 请求错误 / 404 / 413 / 422 音频无法解码 / 502 provider 失败 / 504 provider 超时 / 500。
- **降级优先于报错**：provider 挂掉时应尽力返回模板/本地结果并带 `warnings`，只有在完全无法产出时才报错。

## 9. 超时与重试约定

| 调用 | 客户端超时 | provider 侧超时 | 重试 |
|---|---|---|---|
| `/v1/asr` | 30s | 25s | 1 次 |
| `/v1/pronounce` | 60s | 50s（含 TTS 参考音生成） | 0（评测不可重试，避免重复计费） |
| `/v1/tts` | 20s | 15s | 1 次 |
| `/v1/feedback` | 40s | 30s | 1 次（失败→模板降级） |
| `/v1/dialogue` | 40s | 30s | 1 次（失败→固定话术降级） |
| `/v1/health` | 3s | — | — |

web 侧对 `/v1/pronounce` 失败的处理：**保存音频与参考文本，返回"稍后可重试"的降级结果，绝不丢数据。**

---

## 10. web 侧数据库 schema（web 拥有，此处冻结字段名供家长面板/文档引用）

```
users(id, email, password_hash, display_name, role, birth_year, age_band, cefr_level,
      native_language, avatar, daily_limit_minutes, allow_free_chat, created_at)
sessions(token, user_id, expires_at, created_at)
sentences(id, text, translation_zh, level, tags, focus_phonemes, source, sort_order)
attempts(id, user_id, sentence_id, mode, reference_text, recognized_text, scores_json,
         issues_json, intonation_json, feedback_json, audio_path, ref_audio_url,
         duration_ms, warnings_json, created_at)
phoneme_scores(id, attempt_id, user_id, word, phoneme, score, actual, error_type, hint_key, created_at)
phoneme_mastery(user_id, phoneme, attempts, avg_score, best_score, last_score, trend_json, updated_at)
srs_cards(id, user_id, kind, ref, ease, interval_days, due_at, reps, lapses, last_grade, created_at)
chat_scenarios(id, title, title_zh, setting_zh, role_prompt, opening_line, level, min_age, tags, enabled, sort_order)
chat_sessions(id, user_id, scenario_id, started_at, ended_at, turn_count, summary_json)
chat_messages(id, chat_session_id, role, text, text_zh, correction_json, flag, audio_path, created_at)
practice_sessions(id, user_id, kind, started_at, ended_at, minutes, item_count)
audit_log(id, ts, actor_user_id, action, detail_json)
```

- `users.role` ∈ `"parent" | "child"`；`age_band` ∈ `"child" | "teen" | "adult"`。
- `srs_cards.kind` ∈ `"phoneme" | "word" | "sentence"`。
- 语音文件落在 `data/audio/<user_id>/<yyyy-mm>/<id>.<ext>`，仅存本地，不入库二进制。

## 11. 变更流程

1. 需要改契约 → 在 `docs/api-contract.md` 顶部改版本号 + 追加"变更记录"。
2. 通知 Lead，由 Lead 同步另一方。
3. **禁止单方面改字段名。** 新增字段必须可选（向后兼容）。

---

## 12. v1.1 新增：`POST /v1/warmup`（缓存预热）

### 12.1 为什么需要

跟读语料是固定的，而**示范音频（TTS）与参考 F0 曲线的生成是跟读闭环里最慢的一步**。
两者都是 `(text, voice, rate)` 的纯函数，可以预生成一次、永久复用。

目标：**把首次跟读的反馈延迟从 4–6 秒压到 2 秒以内**，且把云 TTS 的调用量降到接近零
（每条语料只合成一次，之后全部命中本地缓存）。这是"省延迟"和"省钱"同时达成的少数优化。

### 12.2 缓存约定（两条）

> **v1.2 修正**：缓存 key **必须包含 TTS provider 身份**。v1.1 的 key 只有 `(text, voice, rate)`，
> 而 `azure_tts_voice` / `edge_tts_voice` / `default_tts_voice` 默认是**同一个字符串**，
> 于是 mock 模式灌下的缓存会被 azure 模式命中——**用户会听到合成音当作"母语者示范"，
> 并且真实语音被拿去和合成扫频曲线做 DTW，语调反馈静默变成垃圾**。
> 这不是理论风险：mock 优先是本项目文档里的默认路径，切 Azure 是必然会发生的动作。

- **参考音频缓存**：按 `sha1("v3" + "\x1f" + tts_provider + "\x1f" + fmt + "\x1f" + text + "\x1f" + voice + "\x1f" + rate)` 寻址，
  落 `DATA_DIR/cache/audio/<hash>.<ext>`。`tts_provider` 取实际产出音频的 provider 名
  （`mock` / `edge_tts` / `azure` 等，与 `/v1/health` 的 `providers.tts` 同口径）。
  对外 `ref_<hash 前12位>.<ext>` 的形态不变（`reference_audio_url` 契约不变）。
- **`fmt`**（`mp3` / `wav`）：两者是**不同产物**（容器/编码/码率都不同），必须进 key。
  参考音（`pronounce` / `warmup`）固定用 `"wav"`；`/v1/tts` 用请求里的 `format`。
  注意：**格式设置写错会静默失效**（Azure SDK 只有 `set_speech_synthesis_output_format()`，
  没有同名属性；写成属性赋值不报错但不生效，曾导致全部音频停留在 16kHz），
  所以 `/v1/tts` 现在额外返回 `X-Audio-Codec` / `X-Audio-Sample-Rate` / `X-Audio-Container` 供观测。
- **参考 F0 曲线缓存**：按同一个 hash 寻址，落 `DATA_DIR/cache/f0/<hash>.json`。
  内容为归一化前的 `[time_ms, f0_hz|null]` 序列——归一化与 DTW 与用户音频相关，不能缓存，只缓存参考侧。
- **缓存必须内容校验后使用**：JSON 解析失败或点数异常一律视为未命中并重新生成，绝不因为坏缓存而给错分。
- **缓存必须有上限与淘汰**（建议 LRU，默认上限 500 MB / 2000 条，可用环境变量覆盖），
  避免在几十条语料反复试读的机器上无限增长。
- **版本前缀必须保留**：`"v2"` 参与 hash，这样规则变更时旧缓存自动失效。缓存是可再生的，
  失效只需重新预热，**不要为了"复用旧缓存"而省略版本前缀**。

### 12.3 请求

`application/json`：

```json
{
  "items": [
    { "text": "I think the weather is really nice today.", "voice": "en-US-JennyNeural", "rate": "slow" },
    { "text": "I think the weather is really nice today.", "voice": null, "rate": "normal" }
  ],
  "concurrency": 2
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `items` | ✅ | 1–500 条；超过 500 返回 413 `payload_too_large` |
| `items[].text` | ✅ | 空串或长度 > 2000 → 400 `bad_request` |
| `items[].voice` | | `null`/省略 = provider 默认音色 |
| `items[].rate` | | `slow` \| `normal`（默认 `normal`） |
| `concurrency` | | 1–8，默认 2。**不要贪大**：云 TTS 有并发/限流，预热是后台任务不是用户请求 |

### 12.4 响应

```json
{
  "requested": 120,
  "generated": 110,
  "cached": 10,
  "failed": [
    { "text": "…", "voice": "en-US-JennyNeural", "rate": "slow", "error": "provider_timeout" }
  ],
  "skipped_duplicates": 4,
  "elapsed_ms": 45210,
  "cache": { "audio_entries": 118, "f0_entries": 118, "bytes": 12345678 }
}
```

- `requested = generated + cached + failed + skipped_duplicates`（**必须自洽**，便于脚本校验）。
- **单条失败不能让整个预热失败**：失败项进 `failed` 数组，HTTP 仍返回 200。
  只有整个请求格式非法才返回 4xx。
- 预热是**幂等**的：重复调用同一批，第二次应全部命中 `cached`。

### 12.5 `provider_meta.cache`（`/v1/pronounce` 的可选新增字段）

```json
"provider_meta": {
  "cache": { "reference_audio": "hit", "reference_f0": "miss" }
}
```

取值 `"hit" | "miss" | "disabled"`。用于验证缓存真的生效（web 侧与验收脚本会读它）。
**v1.0 的客户端不读这个字段，所以是向后兼容的。**

---

## 13. v1.1 新增：盲测与自定义语料的数据库字段（web 拥有）

### 13.1 为什么需要盲测

平时的分数**不能用来证明长期进步**：用户看完反馈会立刻重读，分数自然上升，这是即时模仿不是习得。
唯一诚实的指标是**盲测**——同样的 10 句，全程不给任何反馈，与上周对比。

### 13.2 schema 增量（冻结字段名）

```
sentences
  + owner_user_id TEXT NULL      -- 家长自定义语料时记录归属；官方语料为 NULL
  (source 取值扩展：'official' | 'parent')

attempts
  + is_blind INTEGER NOT NULL DEFAULT 0    -- 1 = 盲测产生的记录
  + blind_test_id TEXT NULL                -- 归属的盲测批次

blind_tests
  id, user_id, started_at, ended_at, item_count,
  avg_pron, avg_accuracy, avg_fluency, avg_intonation_distance,
  sentence_ids_json, created_at
  -- ended_at IS NULL 表示进行中
```

### 13.3 盲测的硬性行为要求（不是 UI 偏好，是功能正确性）

1. **盲测进行中，接口不得返回任何分数或反馈。**
   `POST /api/attempts`（带 `blind_test_id`）只返回 `{ "attempt_id", "blind": true, "progress": { "done": 3, "total": 10 } }`，
   **不含 `result` / `feedback` / `scores`**。
   理由：用户一旦看到分数就会立刻重读，盲测随即失效——这会静默地毁掉这个功能。
2. 盲测记录必须**排除在**练习趋势、`phoneme_mastery` 的日常统计之外
   （`is_blind=1` 的行不参与 `avg_score` 与 SRS 排期），否则两套指标会互相污染。
3. `POST /api/blind-tests/:id/finish` 之后分数才可读，并写入 `blind_tests.avg_*`。
4. 盲测句子必须**从学习者练过的语料里抽**（否则测的是没学过的东西，分数没有可比性），
   且每次抽同一组固定的句子，才能与上周对比。

### 13.4 新增 web API（字段名冻结）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/blind-tests` | 开始一次盲测；body `{}`；返回 `{ blind_test_id, sentence_ids[], total }` |
| `POST` | `/api/attempts` | 新增可选 form 字段 `blind_test_id`；行为见 §13.3 |
| `POST` | `/api/blind-tests/:id/finish` | 结束并计算 `avg_*`；返回本次汇总与与上次的差值 |
| `GET` | `/api/blind-tests` | 历史列表（按时间倒序）+ 周环比趋势，供家长面板画图 |

`GET /api/blind-tests` 响应：
```json
{
  "tests": [
    { "id": "bt_…", "user_id": "u-girl", "started_at": "…", "ended_at": "…", "item_count": 10,
      "avg_pron": 71.2, "avg_accuracy": 74.0, "avg_fluency": 79.5, "avg_intonation_distance": 0.41 }
  ],
  "trend": { "current": {"avg_pron": 71.2}, "previous": {"avg_pron": 66.8}, "delta_pron": 4.4, "weeks": 3 }
}
```

---

## 14. v1.5 新增：`POST /v1/ocr`（拍照识别）

把书页照片里的英文转成文本，供「拍照 → 切句 → 连读」使用。

`multipart/form-data`：`image`(file, 必填, ≤10MB)。

```json
200 {
  "provider": "rapidocr",
  "text": "Hello! My name is Lily.\nI like drawing cats and dogs.",
  "lines": [{ "text": "Hello! My name is Lily.", "confidence": 0.982 }],
  "width": 820, "height": 300,
  "elapsed_ms": 584,
  "warnings": []
}
```

- **`text` 已按阅读顺序（从上到下）用 `\n` 连接**，前端可直接 `split("\n")` 切句；`lines[]` 给逐行置信度。
- 契约层面可依赖的行为：
  - **手机 EXIF 旋转会被修正**（竖拍照片不会识别成乱码）；
  - 长边 >1600px 时等比缩小，并给 `warnings:["image_downscaled"]`；
  - 空白页返回 `text=""` + `warnings:["no_text_found"]`；
  - **图片只在内存处理、不落盘**（服务端不保存任何图片）。
- **`provider`（v1.5 实测值）**：`"deepseek vision"`（LLM 视觉，默认）或 `"rapidocr"`（本地兜底）。
- **`lines[].confidence`**：LLM 路径为 **`null`**（诚实表示"模型不给置信度"，不编造）；本地路径为 0–1 浮点。
- **隐私（重要）**：服务端**不保存任何图片**；但走 LLM 路径时图片会**临时上传到所配置的 LLM 服务**（如 DeepSeek）用于识别。
  前端必须如实提示这一点（不能说"纯本地识别"），并给用户"改用文字输入"的替代路径。
- **`warnings` 取值**（v1.5）：`image_downscaled`（长边 >1280 被等比缩小）、`no_text_found`（最终确实没有英文内容）、
  `llm_empty_retried`（首次空结果后用宽容提示词重试过，仍为空）、`image_encode_failed`（无法编码 JPEG）、
  `llm_truncated`（输出被 max_tokens 截断，自动重试后仍截断，返回部分内容）。
- **默认关闭推理（v1.5 实测必需）**：本仓库默认模型是**推理模型**，会先产出 `reasoning_content` 再产出 `content`。
  OCR 默认发送 `"thinking": {"type": "disabled"}` 并设 `max_tokens=1500`。实测（真实绘本照片 4160×3120）：
  `max_tokens=800` 时 794 个 token 被思考吃掉 → 正文被截断甚至为空（表现为"识别失败/没识别到文字"）；
  关思考后同一张图 **785ms 完整识别**（此前 11320ms）。
- **截断自动重试**：若 `finish_reason == "length"`（无论 content 是否非空），服务端会**重试一次**
  （`max_tokens` ×3、上限 4000、强制关思考）；仍截断则加 `warnings:["llm_truncated"]` 并返回已获得的部分内容。
  若端点不接受 `thinking` 参数（400），自动降级为不带该参数重试，**不报错**。
- **空结果重试（v1.5 行为）**：若视觉模型首次返回空/占位符（实测模型会返回 `` `<empty string>` ``、
  `（空字符串）` 或中文解释，而不是真空串），服务端会**用更宽容的提示词重试一次**（明确允许封面标题/标签/装饰字）；
  重试成功则返回正常结果（**不含** `no_text_found`），两次都空才返回 `text=""` + 上述 warnings。
  重试耗时**计入** `elapsed_ms`；`provider` 不变。
- **HEIC/HEIF（v1.5）**：按 ISO BMFF 魔数（`ftyp` + heic/heix/heis/hevc/hevx/heim/hevm/mif1/msf1）识别，
  首次遇到才懒加载 `pillow-heif`；解码后走同一套预处理。若服务端**未启用** HEIC 支持，
  返回 **400** `bad_request`，`message` 为可操作文案（含「HEIC」并建议改用拍照或先转 JPEG），不会落到笼统的"无法解码"。
- 错误：非图片 **400** `bad_request`；>10MB **413** `payload_too_large`；
  **503 `provider_unavailable`** = LLM 失败且无本地兜底，或两者都不可用。
- 性能参考：LLM 路径实测 **0.7–1.5s/页**（偶发数秒；服务刚启动首次调用可能更慢）；本地兜底 0.5–0.8s/页（需额外 +157MB 依赖）。

---

## 15. v1.7 新增：`POST /v1/story/rewrite`（中文讲述 → 分级英文）

故事模式的核心：孩子用中文讲自己的故事，服务端把它**改写**（不是直译）成符合其 CEFR 级别的英文。

请求（JSON）：
```json
{"text_zh": "今天我和小明搭积木塔，被小华碰倒了，我很生气。",
 "level": "A1",                 // A1 | A2 | B1 | B2，默认 A1
 "max_sentences": 6,            // 1–6，默认 6
 "weak_phonemes": ["th", "r"],  // 可选：把发音弱的音塞进故事里
 "avoid_words": ["..."]}        // 可选
```

响应：
```json
{"title_en": "The Fallen Block Tower",
 "sentences": ["Today I build a block tower with Xiaoming.", "..."],
 "text_en": "<sentences 用 \n 连接>",
 "level": "A1",
 "readability": {"sentence_count": 6, "avg_words": 6.8, "max_words": 8,
                 "unknown_words": ["cross"], "ok": true},
 "warnings": [],
 "provider": "deepseek",
 "provider_meta": {"weak_phonemes_achieved": ["th"], "weak_phonemes_missing": ["r"]}}
```

**服务端硬校验（不依赖模型自觉）**：
- 句数 ≤ `max_sentences`；平均词数 ≤ **8/10/12/14**（A1/A2/B1/B2）；最长句 ≤ 平均上限 + 4
- **单一叙事时态**（混用 → 重写）；`avoid_words` 出现 → 重写
- 词汇以句库（`web/src/data/sentences.json` 的 A1/A2）+ 常用词为准；人名/专名不算超纲
  `unknown_words > 2` → **自动重写一次**（最多 2 次调用），仍超标 → `warnings:["too_hard"]` 并照常返回
- `weak_phonemes` 未写出 → `warnings:["weak_phonemes_missing"]`

**错误语义**：参数非法 → 400；LLM 未配置 → **503 `provider_unavailable`**；JSON 解析两次失败 → **502 `provider_error`**。
**不落盘、不缓存**（内容每次不同）。实现上用 `disable_thinking`（推理模型会把 token 耗在思考上）。

### `/v1/asr` 的 `language`（v1.7 扩展）
- 接受 `en` / `en-US` / `zh` / `zh-CN`（大小写不敏感，`zh_hans` 等变体规范化）
- 响应里 `language` 回显**规范化后的 locale**（`en-US` / `zh-CN`）
- 非法值 → 400；中文识别结果**原样返回**（不做英文后处理）

---

## 16. v1.8 新增：`POST /v1/story/retell`（复述覆盖度评估）

故事模式的 P3：孩子读完故事后**不看屏幕**用英文讲 2–3 句，系统评估"有没有把关键信息讲出来"。
**不评发音分数**（复述阶段重点是表达，不是音准）。

请求（JSON）：
```json
{"story_sentences": ["Today I built a tall block tower with Ming.", "Hua knocked it down.", "I was very angry."],
 "transcript": "I build tower with Ming and Hua knock it down, I am angry",
 "level": "A2"}
```
- `story_sentences` 1–20 条、每条 ≤200 字符；`transcript` 1–1000 字符；`level` ∈ A1/A2/B1/B2；超限 → 400

响应：
```json
{"coverage": 0.72,
 "covered_points": ["和 Ming 搭积木塔", "Hua 把塔弄倒", "我很生气"],
 "missing_points": ["塔很高"],
 "feedback_zh": "你说出了和 Ming 一起搭塔、Hua 把它弄倒、你很生气，讲得很完整！下次还可以说说塔很高。",
 "feedback_en": "You told us you built a tower with Ming and Hua knocked it down — great job! ...",
 "warnings": [],
 "provider": "deepseek"}
```

**语义要求（服务端强制，不只靠模型）**：
- 用 LLM 做**语义覆盖**（接受 `build`/`built` 变形、语序不同、省略冠词；1–2 句也算成功）
- `coverage` 钳制到 0..1
- **鼓励优先**：`feedback_zh` = 1 句具体肯定（必须提到孩子真的讲到的点）+ **最多 1 条**建议；**不得含否定词**（差/错/失败/不行/不好…）
- `coverage < 0.3` 时语气必须更正向（"你开口讲了！我们再来一次"）
- 模型反馈不合格 → 重生成一次；仍不合格 → 确定性正向模板兜底，并给 `warnings:["feedback_template"]`

**错误语义**：参数非法 → 400；LLM 未配置 → 503 `provider_unavailable`；JSON 两次解析失败 → 502 `provider_error`。
**不落盘、不缓存**（内容每次不同）。
