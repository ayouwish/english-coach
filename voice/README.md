# english-coach · voice（AI 网关）

FastAPI 服务，监听 `:8100`，路径前缀 `/v1`。浏览器**不**直接访问本服务：
`web(Next.js :3000)` 通过 `VOICE_SERVICE_URL`（compose 内 `http://voice:8100`）调用，
音频播放走 web 的反向代理 `/voice/*` → `http://voice:8100/*`。

契约唯一事实来源：[`../docs/api-contract.md`](../docs/api-contract.md)（**冻结，不得单方面改字段**）。

---

## 1. 快速开始（mock 模式，零密钥、零模型、离线）

```bash
cd voice
uv sync                                   # 安装基础依赖（不含 azure / faster-whisper）
PROVIDER_MODE=mock uv run uvicorn app.main:app --host 0.0.0.0 --port 8100
```

默认就是 `PROVIDER_MODE=mock`，**环境里没有任何 API key 也能全链路跑通**：

```bash
curl -s localhost:8100/v1/health
curl -s -X POST localhost:8100/v1/tts -H 'Content-Type: application/json' \
     -d '{"text":"think, thank, three","rate":"slow"}' -o demo.wav
curl -s -X POST localhost:8100/v1/asr -F "audio=@demo.wav" -F "language=en"
curl -s -X POST localhost:8100/v1/pronounce \
     -F "audio=@demo.wav" -F "reference_text=I think the weather is really nice today." \
     -F "learner_age_band=child"
```

> 音频解码用 **PyAV（`av`）**：wheel 自带 FFmpeg 库，**本机不需要安装系统 ffmpeg**，也不调用 ffmpeg 命令行。
> Python ≥ 3.10（开发/CI 用 3.11）。

---

## 2. 端点（严格按契约）

| # | 端点 | 说明 |
|---|---|---|
| 1 | `GET /v1/health` | 无需鉴权（compose healthcheck 用） |
| 2 | `POST /v1/asr` | multipart：`audio` / `language` / `prompt` |
| 3 | `POST /v1/pronounce` | ★ 核心：音素级发音评测 + 语调对比 + 示范音频 |
| 4 | `POST /v1/tts` | JSON；返回二进制音频 + `X-TTS-Provider` / `X-Audio-Duration-Ms` |
| 5 | `POST /v1/feedback` | 评测 JSON → 中文"人话"反馈（≤2 条建议） |
| 6 | `POST /v1/dialogue` | 日常对话单轮推进（纠错 + 建议应答） |
| 7 | `GET /v1/audio/{audio_id}` | 示范音频，只读，`Cache-Control: public, max-age=604800` |
| 8 | `POST /v1/warmup` | v1.1：批量预热参考音 + 参考 F0 缓存（见 §8） |
| 9 | `POST /v1/ocr` | v1.5/v1.6：拍照识别书页英文（LLM 视觉为主、本地兜底，见 §14）|

统一错误格式：`{"error":{"code","message","detail"}}`，错误码为契约 §8 的固定集合。

---

## 3. Provider 架构

```
routes(/v1/*) ──> ProviderSet{ asr, pa, tts } ──> 调用链: 主 provider -> [local] -> mock -> 内置降级
                     └─ intonation(本地, 与 provider 无关)
                     └─ LLMClient(OpenAI 兼容) -> 失败则 hint_key 模板
```

| provider | 音素级 | NBest | Prosody | 实现 |
|---|---|---|---|---|
| `mock` | ✅(假数据) | ✅ | ✅ | 确定性、离线、无模型；供 E2E / 无密钥开发 |
| `azure` | ✅ | ✅ | ✅(en-US) | Azure Speech SDK（ASR + Pronunciation Assessment + Neural TTS）|
| `local` | ❌(词级) | ❌ | ❌ | faster-whisper 词级置信度 + 文本比对 + 停顿分析（TTS 用 edge-tts，需外网）|
| `piper` | — | — | — | **本地 TTS**：Piper VITS ONNX（CPU RTF≈0.036，见 §13）|
| `gop` | ✅ | ✅ | ❌(由本地 F0+DTW 补) | **本地 PA**：wav2vec2 音素 CTC ONNX + CTC 强制对齐 + GOP（见 §13，**质量结论：不可用于错音本**）|

**红线：绝不允许拿 ASR 置信度冒充音素级发音分。** `local` 只产出 `granularity="word"`、
每个词的 `phonemes` 为空数组，并强制带 `phoneme_level_unavailable` warning。
`gop` 是**真正基于音素后验**的评分，但它的质检结论见 §13.4（相关性不足，默认不启用）。

### 3.1 降级优先于报错

- provider 抛错/超时（契约 §9 的 25s/50s/15s/30s/30s）→ 自动尝试链上的下一个；仍失败则用**内置降级实现**
  （`app/degrade.py`：不依赖任何模型/网络，永不失败），HTTP **200** + `warnings:["provider_fallback"]`，
  `provider_meta.primary_error` 保留首个错误原因。
- LLM 无 key / 超时 / 返回非 JSON → `/v1/feedback`、`/v1/dialogue` 返回模板结果，`provider` 字段为 `"template"`，HTTP 仍 200。
- 只有"完全无法产出"才报错：例如音频无法解码 → `422 unsupported_audio`；
  所有 ASR provider 都挂（连 mock 都失败）→ `502 provider_error`。
- 语调模块任何异常都只导致 `intonation.available=false` + `intonation_unavailable` warning，绝不 500。

### 3.2 Provider 选择

`PROVIDER_MODE`（默认 `mock`）：

| mode | asr | pa | tts | llm |
|---|---|---|---|---|
| `mock` | mock | mock | mock | template |
| `local` | local(whisper) | **local**(词级；GOP 需显式 `VOICE_PA_PROVIDER=gop`) | **piper** | key 有则用，否则 template |
| `cloud` | azure | azure | azure | key 有则用，否则 template |
| `hybrid` | azure（无 key 则 local）| 同左（无 key 则词级 local）| 同左（无 key 则 piper）| 同左 |

> GOP 音素级评测经实测**质量不达标**（§13.4），因此**不做静默默认**：要实验请显式
> `VOICE_PA_PROVIDER=gop`（PA 链会先试 gop、失败再落回词级 local）。

可用 `VOICE_ASR_PROVIDER` / `VOICE_PA_PROVIDER` / `VOICE_TTS_PROVIDER` / `VOICE_LLM_PROVIDER` 单独覆盖。

---

## 4. 环境变量清单

**通用**

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROVIDER_MODE` | `mock` | `mock` \| `local` \| `cloud` \| `hybrid` |
| `VOICE_HOST` / `VOICE_PORT` | `0.0.0.0` / `8100` | |
| `DATA_DIR` | `./data`（容器 `/data`）| 音频落盘根目录，实际写入 `$DATA_DIR/audio/`；目录不存在会自动创建 |
| `MODEL_CACHE_DIR` | `/models`（不可写时退回 `<voice>/.model-cache`）| faster-whisper 等模型下载缓存 |
| `DEFAULT_TTS_VOICE` | `en-US-JennyNeural` | |
| `MAX_TTS_CHARS` | `2000` | 超限 → `413 payload_too_large` |
| `MAX_OCR_BYTES` | `10485760`（10MB）| `/v1/ocr` 图片上限，超限 → `413 payload_too_large` |
| `TTS_TRIM_SILENCE` / `TTS_TRIM_THRESHOLD_DB` / `TTS_TRIM_KEEP_MS` | `1` / `-50` / `50` | WAV 输出首尾静音裁剪（task-39，mp3 不裁）|
| `VOICE_OCR_PROVIDER` | `auto` | `auto`（LLM 优先）\|`llm`\|`local`（强制离线 rapidocr）|
| `OCR_TIMEOUT_S` / `OCR_MAX_TOKENS` | `30` / `800` | 视觉 OCR 调用参数 |
| `MAX_UPLOAD_BYTES` | `26214400` | 上传体积上限 → `413` |
| `VOICE_MAX_AUDIO_SECONDS` | `120` | 超长音频 → `413 audio_too_long` |
| `VOICE_GPU` | `false` | 上报到 `capabilities.gpu` |
| `CACHE_ENABLED` | `true` | 关掉后 `provider_meta.cache` 全为 `disabled`，不写缓存（v1.0 行为）|
| `CACHE_MAX_BYTES` | `524288000`（500MB）| 缓存字节上限，超出按 LRU 淘汰 |
| `CACHE_MAX_ENTRIES` | `2000` | 缓存文件条数上限（audio + f0 合计）|
| `WARMUP_MAX_ITEMS` | `500` | 单次 `/v1/warmup` 的 items 上限，超过 413 |
| `WARMUP_CONCURRENCY` | `2` | 预热默认并发（请求里可用 `concurrency` 覆盖，1–8）|

**分项 provider 覆盖**：`VOICE_ASR_PROVIDER`、`VOICE_PA_PROVIDER`、`VOICE_TTS_PROVIDER`、`VOICE_LLM_PROVIDER`

**Azure（可选）**：`AZURE_SPEECH_KEY`、`AZURE_SPEECH_REGION`、`AZURE_SPEECH_ENDPOINT`、`AZURE_TTS_VOICE`

**LLM（OpenAI 兼容：DeepSeek / Ollama / vLLM…）**：
`LLM_BASE_URL`（如 `https://api.deepseek.com/v1`）、`LLM_API_KEY`、`LLM_MODEL`、`LLM_TIMEOUT_S`；
Ollama 别名 `OLLAMA_BASE_URL`（`http://localhost:11434` 会自动补 `/v1`）、`OLLAMA_MODEL`。
没有任何 key 时自动降级为模板反馈（`provider="template"`）。

**本地兜底**：`WHISPER_MODEL`（`tiny`）、`WHISPER_DEVICE`（`cpu`）、`WHISPER_COMPUTE_TYPE`（`int8`）、`EDGE_TTS_VOICE`

模板见 [`.env.example`](.env.example)。

---

## 5. 切换到 Azure（云 provider）

```bash
uv sync --extra azure          # 安装 azure-cognitiveservices-speech（惰性导入，不装也不影响 mock）
export AZURE_SPEECH_KEY=xxxx
export AZURE_SPEECH_REGION=eastasia
export PROVIDER_MODE=cloud     # 或 hybrid：云为主 + 本地/离线兜底
uv run uvicorn app.main:app --host 0.0.0.0 --port 8100
```

> 从 mock 切到 `cloud`/`hybrid` 后**不需要**清缓存：key 里含 `tts_provider`（契约 v1.2），
> mock 时代预热的条目不会被 Azure 命中；但建议按 §8.2 用 azure 重新预热一遍，让示范音一次生成到位。

> **TTS 输出格式（v1.3 修复）**：`mp3` → `Audio24Khz96KBitRateMonoMp3`，`wav` → `Riff24Khz16BitMonoPcm`，
> 必须用 `config.set_speech_synthesis_output_format(枚举)` 设置。Azure SDK 的 `SpeechConfig`
> **没有** `speech_synthesis_output_format` 属性——历史上给它赋值不报错但静默失效，
> 结果无论请求 mp3 还是 wav 都返回默认 16kHz PCM（听起来发闷，且 `content_type` 与实际字节不符）。
> 现在若 setter 缺失会直接报错；返回字节还会用 PyAV 校验真实容器/采样率，不符则打 ERROR 日志。

Pronunciation Assessment 参数（task-1 要求）：`granularity=Phoneme`、`enable_miscue=True`、
`enable_prosody_assessment()`、`phoneme_alphabet="IPA"`、`nbest_phoneme_count=5`、`HundredMark`。
`mode=unscripted`（参考文本为空）时不跑 PA（Azure PA 必须有参考文本），只出 ASR 文本 + 本地语调，
`pron/accuracy/completeness` 为 `null`（**不给假分数**）。

`xfyun` 在契约能力矩阵里预留，V1 不实现（选择它会得到 `no_provider` 并由兜底链接管）。

### local provider（词级兜底）

`local` = faster-whisper 词级 ASR/PA（TTS 走 edge-tts，需要外网；离线部署请用 §13 的 `piper`/`gop`）。

```bash
export PROVIDER_MODE=local
export WHISPER_MODEL_PATH=/models/local/whisper/small.en   # 必须指向本地 CTranslate2 模型目录
```
模型在**第一次真正调用**时才加载；**绝不会**用 `WhisperModel("tiny")` 去 HuggingFace 下载（本机 HF 不可达）。
测试不下载大模型：pytest 用 monkeypatch 替换 `transcribe_words`/`WhisperModel`。

---


---

## 6. 语调模块（与 provider 无关，离线可用）

`app/intonation.py`，任何模式（含 mock）下都会返回 `intonation`：

1. **F0 提取**：`praat-parselmouth`（自相关法），`to_pitch(time_step=0.02)`，清音帧为 `null`；
2. **半音归一化**：各自减去自身浊音段 F0 均值再取 `12*log2` → 消除男女/儿童音高与整体音区差异；
3. **DTW 对齐**：自研 DP（无外部依赖），局部代价 `|Δsemitones|`，一方清音记固定代价；
   `dtw_distance = 累计代价 / 路径长度`（半音，越小越接近）；
4. **对齐输出**：把用户曲线按 DTW 路径映射到参考时间轴 → `user_f0` / `reference_f0` **同时间轴、同长度**、
   20ms 步长、≤600 点（超长按契约等间隔抽稀）；半音域会还原成 Hz 输出；
5. **worst_regions**：对 `|用户-参考|` 平滑后找超阈值区间，按参考/用户斜率分类为
   `expected_rise_but_flat` / `expected_fall_but_flat` / `wrong_direction` / `stress_misplaced` /
   `monotone_overall` / `unexpected_pause`，并用词级时间轴填 `text`，最多 3 条。

参考曲线来自 TTS 生成的示范音频（`mock` 模式用一个**真的有基频**的音调合成器，
见 `app/synth.py`，所以离线也能演示语调对比）。`scores.prosody`：provider 给了就用 provider 的，
否则用 `100 - 90*dtw_distance` 折算；语调不可用时为 `null` + `prosody_unavailable`。

**合成信号验证**（`tests/test_intonation.py`）：正弦扫频验证 F0 跟踪精度（中段误差 <8%）、
静音判为清音、同曲线 DTW=0、整体升八度后距离不变（半音归一化生效）、
"参考上扬 + 用户平"命中 `expected_rise_but_flat`、"反向"命中 `wrong_direction`、
用户中间 400ms 静音命中 `unexpected_pause`、真实波形级（扫频 vs 定频）同样命中上扬未实现。

### 6.1 什么时候 `intonation.available == false`（造测试音频必读）

F0 用 praat 自相关法，搜索区间 **60–500 Hz**，输出网格 20ms（首帧约在 30ms），
最少需要 **3 个浊音帧（≈60ms）** 才够做 DTW。实测边界：

| 用户音频 | 结果 |
|---|---|
| 纯正弦 120 / 180 / 440 / 900 Hz（≥150ms）| ✅ available=true（基频高于 500Hz 时会锁定其分谐波）|
| 滑动基频 + 谐波 + 包络的类浊音（如 `web/scripts/smoke.mjs` 的 `wavBlob()`）| ✅ available=true，147 点曲线 |
| 静音 / 直流 / 白噪声 / 非周期脉冲串 | ❌ available=false + `intonation_unavailable` |
| 基频低于搜索下限（如 30Hz）| ❌ 同上 |
| 时长 ≲50ms（只有 1 个浊音帧）| ❌ 同上 |

降级时 `user_f0`/`reference_f0`/`dtw_distance` 为 `null`、`worst_regions=[]`、
`scores.prosody=null`，并带 `intonation_unavailable` + `prosody_unavailable` warning
（HTTP 仍 200，发音分照常返回）。**造测试音频请用 ≥0.5s 的类浊音信号。**

---

## 7. LLM 层与模板降级

`app/llm.py`：OpenAI 兼容 `POST {LLM_BASE_URL}/chat/completions`（`response_format=json_object`），
任何异常（连接失败、超时、非 JSON）都返回失败态，由调用方降级。

- `/v1/feedback`：LLM 输出 `summary/praise/points/closing`；`points` 在 prompt 和
  `sanitize_feedback()` 双重截断到 **≤2 条**；`learner.age_band=="child"` 时把 IPA 符号替换成
  "th 音 / 短 i 音"这类描述（`strip_ipa` / `child_title`），并保证普通英文单词不被改坏。
- 模板反馈（`app/feedback_templates.py`）：按 `hint_key` 查 17 条中文教学提示表，
  `severity` 缺失时按 `score`/`error_type` 推导，离线可用，`provider="template"`。
- `/v1/dialogue`（task-17 重写）：LLM 走场景 `role_prompt`；prompt 内置**年龄适配**
  （`age_band=child` → A1 词、≤12 词、一次一个简单问题；teen/adult 按 CEFR）、
  **连续性**（必须回应学习者上一句，禁止 "Tell me more / That sounds good" 这类万能句）、
  **不重复问**（history 里的问题列进 `ALREADY_ASKED`）、**纠错分级**（gentle 只纠影响理解的基础错 /
  standard 有错纠 1 处 / none 恒不纠；纠正必须真的改变内容，否则视为无错）、**儿童安全**与
  两段 few-shot JSON 示例。history 只带最近 8 条；JSON 非法或缺 `reply` 时**严格重试一次**再降级。
  降级用内置场景话术 + 规则纠错（`I want` → 礼貌、`I is` → be 动词、三单 -s …），
  `suggested_replies` 保证 2–3 条且每条 ≤6 词、互不相同；`turn_index>=6` 时 `done=true`；
  不安全内容 → `flag="unsafe_filtered"` 且 `reply`/建议被替换。
- **`degraded_llm`（契约 v1.4 新增，可选字段）**：`/v1/dialogue` 响应里的布尔值，
  `true` = 本条不是大模型生成的（模板降级）。前端据此提示"当前为离线对话"，
  别让用户把固定台词当成"智能对话"。`provider` 字段同时保持诚实（降级时是 `"template"`）。

  ```json
  { "provider": "template", "degraded_llm": true, "reply": "…", "reply_zh": "…", "correction": {…},
    "suggested_replies": ["…", "…"], "target_words": ["…"], "flag": "ok", "done": false }
  ```

  配置方式（`voice/.env`）：`LLM_BASE_URL`（如 `https://api.deepseek.com/v1` 或 `http://localhost:11434/v1`）、
  `LLM_API_KEY`、`LLM_MODEL`。没配时 `/v1/health` 的 `providers.llm` 是 `template`，对话走降级且 `degraded_llm=true`。

---

### 7.1 反馈质量硬约束（用户实况驱动）

真实使用中踩过三个"不报错但误导孩子"的坑，现在都钉成了测试：

1. **整句没被录进来时不许表扬**。触发条件（`is_no_speech_payload`）：`recognized_text` 去掉标点后没有任何英文词
   （实况里的 `"."`），或四个分项全 0 且 issues/words 几乎全是 Omission（含分数缺失但每个词都 Omission），
   或全 0 分且 `warnings` 同时带 `low_snr` + `asr_mismatch`。
   该分支：**不含任何表扬词**（`PRAISE_MARKERS` 黑名单：棒/说出来了/坚持读完/读得…），
   改说"我好像没听到你的声音"，并给**三条可执行排查**（靠近麦克风、说大声一点、先点「听示范」听节奏），
   **不做逐词指责**（没听到 vs 漏一个词是两件事）。这一支在 `/v1/feedback` 路由上**直接绕过 LLM**——
   LLM 输出不可控，可能把"真棒"又带回来。
2. **练习词必须与目标词相关**（不许张冠李戴）：
   - `Omission` / `Insertion`：用**该词本身**（`Good` 漏读就给 `Good`，不再给通用表的 `think/weather/really/today`）；
   - `UnexpectedBreak` / `MissingBreak`：用停顿处的那个词；
   - `Mispronunciation` 的音素在 `PHONEME_HINT` 里没有专用条目时（例如 `today /eɪ/` 曾被按拼写猜成"词尾音"），
     改用中性卡片，练习词从**参考句中真正含这个音素**的词里挑（`_sentence_words_with_phoneme`）。
3. **`actual == null` 不许编造**"你读成了 X"：改为"这个音还不够清楚"；只有真的给了 `actual` 才写"读成了 s"。

## 8. 预热与缓存（契约 v1.1 §12）

跟读语料的示范音频与参考 F0 都是 `(text, voice, rate)` 的纯函数：预生成一次即可永久复用。
缓存让**第二次起的跟读不再调用云 TTS、也不再跑 praat**（归一化与 DTW 与用户音频相关，仍然每次都算）。

### 8.1 缓存约定

| 内容 | 路径 | 键（契约 v1.3 §12.2） |
|---|---|---|
| 参考音频 | `DATA_DIR/cache/audio/<hash>.<ext>` | `sha1("v3" + "\x1f" + tts_provider + "\x1f" + fmt + "\x1f" + text + "\x1f" + voice + "\x1f" + rate)` |
| 参考 F0（归一化**前**） | `DATA_DIR/cache/f0/<hash>.json` | 同一个 hash（参考音固定 `fmt="wav"`）|

- **`fmt` 必须参与 key**（`mp3` 与 `wav` 是不同产物：容器/编码/码率都不同）。参考音（`pronounce`/`warmup`）固定用
  `fmt="wav"`；`/v1/tts` 用请求里的 `format`。因此**同一句话的 wav 与 mp3 各缓存一份**，
  「只听示范」请求 mp3 时不会命中预热好的 wav 参考音（这是诚实行为，见 §8.5）。
- **`KEY_VERSION` 已升到 `"v3"`**：v2 时代的缓存全部失效（那里存有 Azure 格式设置静默失效产生的
  16kHz 坏音频），升级后**必须重新预热一次**。
- **`tts_provider` 必须参与 key**（取值与 `/v1/health` 的 `providers.tts` 同口径：`mock` / `local` / `azure`）。
  这不是洁癖：`azure_tts_voice` / `edge_tts_voice` / `default_tts_voice` 的默认值**是同一个字符串**
  （`en-US-JennyNeural`），而 web 练习时不传 `tts_voice`。若 key 不含 provider，
  "先 mock 预热、后切 Azure"就会命中 mock 的缓存 —— 用户把**合成蜂鸣**当成母语者示范听，
  而且**真实语音的 F0 被拿去和合成扫频曲线做 DTW**，语调反馈静默变成垃圾（发音分却一切正常，极难排查）。
- 能进缓存的音频/曲线一定是**主 provider 产出的**（兜底音不落缓存），所以"key 里的 provider == 实际生产者"是硬不变量。
- 版本前缀 `"v2"` 参与 hash：规则再变时旧缓存自动失效（缓存可再生，重新预热即可，不要为了复用而省略前缀）。
- 对外 id 仍是 `ref_<hash 前12位>.<ext>`，`reference_audio_url` 形态与 v1.0 完全一致（`/v1/audio/*` 优先从缓存目录取，其次回落旧的 `DATA_DIR/audio/`）。
- **校验后使用**：JSON 解析失败、点数 <2 或 >600、时间轴非递增、值类型错误、全是清音 —— 一律视为**未命中并重新生成**；
  坏缓存绝不会被拿去算分。自己生成的数据不合法时也一律不落盘。
- **LRU 淘汰**：默认 500MB / 2000 条（`CACHE_MAX_BYTES` / `CACHE_MAX_ENTRIES`），按 mtime 从旧到新删。
- **失败不落缓存**：TTS 全挂时用的本地兜底音不会写进缓存，下次仍会尝试云 TTS（否则会把"降级音"永久固化）。
- **并发单飞**：同一 key 的并发请求只会生成一次（预热与跟读共用同一把 SingleFlight），不会重复烧云 TTS；
  单飞也是 provider 维度的（不同 provider 的同文本不会互相顶替）。

> **升级到 v1.3 后需要重新预热一次**：key 由 `(v2, tts_provider, text, voice, rate)` 变为
> `(v3, tts_provider, fmt, text, voice, rate)`，旧条目（含 16kHz 坏音频）**不会再被命中**
> （不会出错，只是算 miss 并重新生成）。想立刻回收空间就 `rm -rf "$DATA_DIR/cache"`，然后按 §8.2 重跑一次预热即可。

`/v1/pronounce` 的 `provider_meta` 会带缓存状态（契约 §12.5，可选字段）：

```json
"provider_meta": { "cache": { "reference_audio": "hit", "reference_f0": "hit" } }
```

取值 `hit` / `miss` / `disabled`（`with_intonation=false` 或 `CACHE_ENABLED=false` 时为 `disabled`）。
另有一种半命中：音频命中但 F0 缺失时只补算 F0，**不会重新调 TTS**。

### 8.2 预热 CLI

```bash
cd voice
# 纯文本清单（每行一句，# 开头为注释）
.venv/bin/python scripts/warmup.py --text-file corpus/sentences.txt --concurrency 2

# JSON 清单：["句子", ...] 或 [{"text","voice","rate"}, ...] 或 {"items":[...]}
.venv/bin/python scripts/warmup.py --items corpus/warmup.json

# 打已在运行的服务（缺省是在进程内直接预热，不需要起服务）
.venv/bin/python scripts/warmup.py --items corpus/warmup.json --url http://127.0.0.1:8100
```

输出统计：`requested / generated / cached / failed / skipped_duplicates / elapsed_ms / cache{audio_entries,f0_entries,bytes}`；
`failed` 非空时退出码为 1（CI 可用来卡门禁）。

**建议：每次语料变化后跑一次**（新增/修改句子、换 `voice` 或 `rate` 都要重跑）。增量即可：
已缓存的条目会算 `cached`，重复条目算 `skipped_duplicates`，只有变化的部分才真正生成。

### 8.5 「只听示范」也走缓存（`/v1/tts`）

`/v1/tts` 与 `pronounce`/`warmup` 共用同一套内容寻址缓存（key 公式见 §8.1），命中时**完全不调用云 TTS**：

- 响应头 `X-Cache: hit | miss | disabled`（`disabled` = 带 `ssml` 或 `CACHE_ENABLED=false`）；
- 契约要求的 `X-TTS-Provider` / `X-Audio-Duration-Ms` **命中时也始终带**；
- 额外带 `X-Audio-Codec` / `X-Audio-Sample-Rate` / `X-Audio-Container`（解码真实字节得出，
  历史上"标 mp3 实际是 16kHz PCM"就是靠这个维度发现的）；
- 带 `ssml` 的请求无法用 `text` 做 key → 跳过缓存；降级音/兜底音绝不写缓存；
- 同一 key 的并发请求复用 `SingleFlight`，只真正合成一次。

> 注意格式维度：预热产物是 `wav`（参考音分析用）。若前端「只听示范」请求 `mp3`，
> 第一次仍会真合成一次（之后命中自己的 mp3 缓存）。想彻底零调用，可让前端在「只听示范」时
> 直接用 `pronounce` 返回的 `reference_audio_url`（已预热的 wav），或按 §8.2 预热时同时覆盖需要的格式。

### 8.4 TTS 输出首尾静音裁剪（task-39）

Azure 对**短词**返回的 WAV 尾部会带约 1.3s 的低电平噪声（实测 `think` 总 1.82s、真实语音仅 0.19–0.37s、
尾部 ≈ -64dB）——播放时"词一闪就没了，然后一段空白/底噪"，听感浑浊拖沓。

- 只处理 **WAV(PCM16 mono)**：按 10ms 帧 RMS 判定，**阈值 -50dBFS**，首尾各保留 **50ms** 余量
  （不削真实轻声收尾；实测 -44dB 的轻声收尾会保留）。
- **mp3 不裁剪**（没有 ffmpeg，重编码不值得；`conversation` 的 mp3 路径不受影响）。
- 裁剪后 `duration_ms` / `X-Audio-Duration-Ms` 反映真实时长；**缓存里存的是裁剪后的字节**
  （同一 key 两次请求字节一致，第二次 3ms 命中）。
- 整段低于阈值（异常输入）或音频 <10ms 时**原样返回**，不裁坏。
- 参考音（warmup）同样走裁剪后的音频，F0 分析不受影响（静音段本来就不产生 F0）。
- 可配置：`TTS_TRIM_SILENCE=1`（默认开；设 0 关闭）、`TTS_TRIM_THRESHOLD_DB=-50`、`TTS_TRIM_KEEP_MS=50`。

实测（真实 Azure，`fmt=wav`）：

| 文本 / rate | 裁剪前总时长 | 语音段 | 裁剪后总时长 |
|---|---|---|---|
| `think` / normal | 1.82s | 0.37s | **0.47s** |
| `think, sink` / slow | 2.86s | 1.41s | **1.51s** |
| `think` / mp3 | 1.87s | — | 不裁剪（mp3）|

**旧缓存兼容 / 坏音频自愈**（task-42）：task-39 之前写入的 WAV 可能是 **16kHz**（旧的"SDK 静默退回默认格式"
bug 产物，>4kHz 零能量=电话音"浑浊"）。现在：
- `/v1/tts` **命中缓存时**只读 WAV 头部（≤1KB）解析采样率；若是 **azure** 的 wav 且 **<24000Hz**：
  记 WARNING（含 key/采样率/时长）→ 删除该缓存 + 同名 `cache/f0/<key>.json` → 当作 miss 重新合成并写入新 24kHz 缓存。
  （只对 azure 生效；mock 本身 16kHz、Piper 22.05kHz 都是合法输出，不会被误删。）
- 校验阈值按格式收紧：**wav ≥ 24000Hz**、mp3 ≥ 16000Hz；Azure 产出低于阈值会抛 `ProviderError`（不再静默通过，避免坏音频再进缓存）。
- 批量清理：`python scripts/trim_cache.py --fix-low-rate`（默认只报告，带上参数才删，并按文件打印采样率）。

### 8.3 `POST /v1/warmup`

```bash
curl -s -X POST localhost:8100/v1/warmup -H 'Content-Type: application/json' \
  -d '{"items":[{"text":"I think the weather is really nice today.","voice":null,"rate":"normal"}],"concurrency":2}'
```

- `items` 1–500 条（>500 → 413）；`text` 空串或 >2000 → 400；`rate` 仅 `slow|normal`；`concurrency` 1–8（默认 2）。
- `requested = generated + cached + failed + skipped_duplicates`（自洽，脚本可直接校验）。
- **幂等**：同参数第二次调用 `generated=0`、全部 `cached`。
- 单条失败只进 `failed`（`{text, voice, rate, error}`），HTTP 仍 200。

## 9. 目录与落盘

```
app/
  main.py         FastAPI 入口 + 统一错误处理
  api.py          7 个端点
  config.py       环境变量 -> Settings（含 provider 推导）
  errors.py       错误码/HTTP 状态映射
  execution.py    provider 超时 + 兜底链执行
  audio_io.py     PyAV 解码 -> 16k mono float32；PCM16 WAV 编码
  synth.py        离线"有声调"语音合成（mock TTS，供语调对比）
  store.py        示范音频落盘（ref_<sha1前12位>.<ext>）与只读访问
  intonation.py   F0 / 半音归一化 / DTW / worst_regions
  phonemes.py     音素符号归一化（canonical-v1 单一映射表 + 未命中可观测）
  hints.py        error_type / severity / hint_key 映射（表键已规范化）
  text.py         分词、发音词典、词级时间轴估计、序列比对
  feedback_templates.py  模板反馈 + 儿童模式 IPA 处理
  dialogue.py     对话降级话术与校验
  llm.py          OpenAI 兼容客户端
  cache.py        参考音/F0 内容寻址缓存（校验 + LRU + 单飞）
  warmup.py       参考音/F0 的生成复用 + 批量预热编排
  degrade.py      最终兜底（永不失败）
  providers/      base / mock / azure / local / registry
scripts/warmup.py 批量预热 CLI
scripts/trim_cache.py 原地裁剪旧 TTS 缓存 WAV 的首尾静音（task-41，幂等、保留文件名）
tests/            494 个用例（契约字段、mock 全链路、合成信号语调、降级、缓存/预热/并发、音素归一化、跨 provider key、反馈质量、TTS 格式与 /v1/tts 缓存、对话 prompt/健壮性）
```

示范音频写入 `$DATA_DIR/cache/audio/<sha1(text|voice|rate)>.<ext>`（v1.0 的 `$DATA_DIR/audio/` 仍可读，
作为兜底/兼容路径），只存本地不入库，响应 URL 为 `/voice/v1/audio/<id>`（web 反代的同源相对路径）。

> ⚠️ **`voice/data/` 是真实运行数据目录**：300 句语料的参考音 + 参考 F0 缓存、音频 store，线上实例正在用。
> **任何清理动作都不要对 `data/` 这类相对路径执行 `rm -rf`**（一次误删 = 300 句重新预热：3 分钟 + 真实云 TTS 费用；
> 而且不会报错，只是下一次跟读变慢）。做验证/自测请显式指定独立的**绝对**临时目录
> （`DATA_DIR=$(mktemp -d)` 或 `voice/.verify-tmp-*/`），并且只删自己刚建的那个路径。

---

### 9.4 升级后一次性裁剪旧 TTS 缓存（task-39/41）

task-39 起 `/v1/tts` 的 WAV 输出会裁掉首尾静音（Azure 短词尾部有 ~1.3s 低电平噪声）。
但**升级前写入的缓存文件仍是未裁剪的**，用户听到的"拖沓/浑浊"主要来自这些旧缓存；
而缓存 key 是 `sha1(...)`（无反向映射），升 `KEY_VERSION` 会让全部缓存失效、必须重新预热（花 Azure 费用 + 时间）。
所以提供**原地裁剪**脚本：只改文件内容、**保留原文件名/key**，缓存继续命中，不调任何 API。

```bash
# 建议先 dry-run 看统计（不写文件）
docker compose exec -T voice python scripts/trim_cache.py --dry-run
# 确认后原地裁剪（一次即可；幂等，重复跑 trimmed=0）
docker compose exec -T voice python scripts/trim_cache.py

# 只看前 N 个 / 指定数据目录
docker compose exec -T voice python scripts/trim_cache.py --limit 20
docker compose exec -T voice python scripts/trim_cache.py --data-dir /data

# task-42：清理旧 bug 留下的 16kHz 坏缓存（电话音）。默认只报告，--fix-low-rate 才删
docker compose exec -T voice python scripts/trim_cache.py --fix-low-rate
docker compose exec -T voice python scripts/trim_cache.py --fix-low-rate --json
```

低采样率审计输出示例（临时目录）：

```
  低采样率: old16k_badcache.wav  16000Hz < 24000Hz（时长 500ms）  → 删除
结果     : scanned=3 ok=2 low_rate_found=1 deleted=1 (f0=1) trimmed=0 skipped=2 failed=0
```

> 即使不跑脚本，`/v1/tts` 命中这些坏缓存时也会**自动**删除并重新合成（用户无感），
> 脚本只是用于一次性批量清理（不必逐个词触发）。

输出示例（真实临时目录）：

```
结果     : scanned=2 trimmed=2 skipped=0 failed=0（另有 1 个 mp3 未处理）
总时长   : 3.32s -> 0.82s （节省 2.50s = 2500ms，平均每个裁剪 1250ms）
```

- **只处理 `cache/audio/*.wav`**：不碰 mp3（无 ffmpeg，不重编码）、不碰 `cache/f0/`（F0 由音频实时计算，无需改）。
- **幂等**：第二次运行 `trimmed=0`；`--dry-run` 不写任何文件。
- **原子写回**：临时文件 + `os.replace`，保留原文件名（缓存 key 不变）。单文件失败（损坏 WAV）计入 `failed` 并继续，
  有失败时退出码 1；符号链接不会被跟随/改写。
- **不跑也能用**：只是旧缓存音频仍带尾部静音；跑一次就全部变干净（一次性，不调 API、不花钱）。
- **不影响 F0 / 评测**：F0 是对音频实时分析（静音段本来不产生 F0）；评测用上传音频，与本缓存无关。

## 10. 测试

```bash
.venv/bin/python -m pytest  # 494 passed（离线；真实 Azure 用例需 voice/.env 的 key，可用 VOICE_SKIP_REAL_AZURE=1 跳过）
```

覆盖：
- 契约字段逐个校验（health/asr/pronounce/tts/feedback/dialogue/audio 的 key 集合、枚举、范围、排序）；
- mock 全链路 + 参考音频落盘与 `Cache-Control`；
- 合成信号验证 F0/DTW/worst_regions（见 §6）；
- TTS 输出格式（见 §5/§8.5）：setter 调用 + 真实字节容器/采样率断言（含真机 Azure）、`/v1/tts` miss→hit、fmt 参与 key、v2 旧缓存不命中；
- 本地 provider（见 §13）：Piper 合成/RTF、espeak 音素化与 CVC 对齐、GOP 打分公式、local 模式启动惰性（不加载 onnxruntime/piper/whisper）；
- 对话质量（见 §7）：prompt 的年龄/连续性/纠错分级约束、history 截断到 8、非法 JSON 重试一次后诚实降级（`degraded_llm=true`）、suggested_replies 兜底、儿童安全过滤；
- 反馈质量（见 §7.1）：没听到语音时不含表扬词、Omission 练习词相关、actual 缺失不编造；
- 音素符号归一化（见 §12）：变体逐项覆盖、幂等、nbest 顺序/分数不变、未知符号原样返回、issues 同步归一化；
- 缓存 key 的 provider 维度：同文本不同 provider 的 key 不同、切换 provider 必须 miss、v1.1 旧条目永不命中（见 §8.1）；
- 降级：provider 抛错 / 超时 / 全链失败 / LLM 不可达 / 无 Azure key 的 cloud 模式，
  全部断言 **HTTP 200 + warnings**（不是 500）；
- 惰性导入：mock 模式下 `sys.modules` 里不允许出现 `azure` / `faster_whisper` / `edge_tts`。

---

## 11. Docker

`deploy/docker-compose.yml` 的 voice 服务用 `build: {context: ../voice, dockerfile: Dockerfile}`：

```bash
docker build -t english-coach-voice ./voice
docker run --rm -p 8100:8100 \
  -v voice-models:/models -v "$PWD/../data:/data" \
  -e PROVIDER_MODE=mock english-coach-voice
```

- 基础镜像 `python:3.11-slim`，`uv pip install --system -r requirements.txt`（`requirements.txt` 由
  `uv export --frozen --no-dev` 生成，已 pin；等价的 `pip install -r requirements.txt` 也可用）。
- **不安装系统 ffmpeg**：`av` / `praat-parselmouth` / `numpy` 在 PyPI 上都有 cp311 manylinux wheel
  （`av-18.1.0-cp311-abi3-manylinux_2_28_x86_64.whl`、`praat_parselmouth-0.4.7-cp311-cp311-manylinux2014_x86_64.*.whl`），
  PyAV wheel 自带 FFmpeg 库。Dockerfile 里保留了"若某架构缺 wheel"时安装 FFmpeg 开发库的注释行。
- 默认 `PROVIDER_MODE=mock`、`DATA_DIR=/data`、`MODEL_CACHE_DIR=/models`；镜像内 `mkdir -p /data/audio /models`，
  代码也会自行创建缺失目录，因此可以安全挂命名卷 / 绑定挂载。
- `EXPOSE 8100`，`HEALTHCHECK` 用 python 请求 `http://127.0.0.1:8100/v1/health`（slim 镜像没有 curl）。

> 本机 docker 拉不到镜像，`docker build` 未能实测；已验证的是：Dockerfile 语法、所有 `COPY` 源路径存在、
> 依赖在 linux/cp311 上有预编译 wheel、以及容器内同款启动命令在本机 3.11 环境下可直接跑通。

---

## 12. 音素符号空间（v1.2 接缝 · `canonical-v1`）

### 12.1 为什么需要

`focus_phonemes` 是 `srs_cards(kind=phoneme)` 的 key，也是 web 侧 `hintKeyForPhoneme()` 的依据。
语料标注用**英式 RP 符号**（`ɒ ɑː ɔː ɜː iː uː əʊ ʊə eə ɪə`），而全链路目标是 **en-US**；
云 provider（Azure）的 IPA 输出很可能用另一套写法（`ɹ ɛ ɝ ɚ`）。

如果不归一化：云端返回 `ɑ` 而语料写 `ɒ` 时，**同一个发音错误会生成两张卡**，
`phoneme_mastery` 的长期追踪会在部分音素上静默断链——不报错，只是几个月后曲线变得没有意义。
所以 voice 侧对外（`/v1/pronounce` 响应）只输出**一套规范符号**，把"接缝"收在一个地方。

### 12.2 规范空间（canonical-v1）

| 类别 | 规范符号 |
|---|---|
| 辅音 | `p b t d k ɡ f v θ ð s z ʃ ʒ h m n ŋ l r j w tʃ dʒ`（`ɡ` 是 U+0261，不是 ASCII `g`）|
| 单元音 | `i ɪ e æ ʌ ə ɜ ɑ ɔ ʊ u` |
| 双元音 | `eɪ aɪ ɔɪ əʊ aʊ`（另保留语料在用的 `ʊə ɪə eə`）|

对照样例（`app/phonemes.py` 的 `CANONICAL_MAP`）：

| 输入（变体） | 输出（规范） | 说明 |
|---|---|---|
| `ɹ` `ɻ` | `r` | GA 的 r |
| `ʤ` `d͡ʒ` | `dʒ` | 塞擦音两种写法 |
| `ʧ` `t͡ʃ` | `tʃ` | 同上 |
| `g` | `ɡ` | ASCII g 统一成 IPA ɡ |
| `ɛ` | `e` | |
| `ɝ` / `ɚ` | `ɜ` / `ə` | GA 卷舌元音 |
| `ɐ` / `ᵻ` | `ʌ` / `ɪ` | |
| `iː` `uː` `ɔː` `ɜː` `ɑː` | `i` `u` `ɔ` `ɜ` `ɑ` | **长度符统一去掉**，避免一个冒号裂成两张卡 |
| `ɒ` | `ɑ` | **cot–caught 合并**（见下）|
| `oʊ` / `ou` | `əʊ` | 字形对齐语料，不代表音值判断 |
| `n̩` `l̩` | `n` `l` | 成音节辅音 |

**已知取舍**（都写在 `app/phonemes.py` 的模块 docstring 里）：
1. `ɒ → ɑ`：6–9 岁阶段区分 cot/caught 不是教学目标，而"一个音只能有一张卡"是硬要求；
   若要恢复 ɒ/ɑ 两分，**只改这一张表**即可。
2. `oʊ → əʊ`：纯粹为了与语料已有 key 对齐（GA 实际音值接近 [oʊ]）。
3. 长度符一律去掉：RP `iː` 与 GA `i` 归为同一个 key。
4. `ɝ/ɚ` 与 `ɜ/ə` 合并，r 色彩由独立的 `r` 音素承担。

### 12.3 对外保证（可依赖的行为）

- `words[].phonemes[].phoneme`、`nbest[].phoneme`、`issues[].phoneme/expected/actual` 全部落在规范空间；
- **`nbest` 的长度、顺序、分数一律不变**（只改符号；两个变体折叠成同一符号时**不去重**，否则会改变 nbest 语义）；
- **未在表中的符号原样返回**（不丢信息、不猜测），同时打一条 `unmapped phoneme symbol 'xx'` WARNING 并记入
  `app.phonemes.seen_unknown_phonemes()`；
- 归一化**幂等**（`f(f(x)) == f(x)`），且规范符号不会被二次映射（import 时断言）；
- `issues[].hint_key` 会按规范符号重算，所以同一个错误在不同 provider 下映射到同一条教学提示；
- `/v1/pronounce` 的 `provider_meta.phoneme_space` 会返回 `"canonical-v1"`，便于审计与联调对齐；
- **合并的副作用（需要知情）**：当 `expected` 与 `actual` 恰好都被折叠到同一个符号时（例如参考 `ɒ`、实际 `ɑː`），
  `issues[].actual` 会与 `expected` 相同——该条的"替代关系"信息被合并掉了，但 **mastery key 是正确的**
  （这正是本次要保护的东西）。若要保留这层区分，把 `"ɒ": "ɑ"` 从 `CANONICAL_MAP` 删掉即可，
  代价是语料里的 `ɒ` 与云端 `ɑ` 会变成两张卡（需与 corpus-dev 一起决定）。
- 长度 ≤3 且像音素的字符串才会被当符号处理（`"fluent"` / `"1125ms pause"` 这类描述性文本原样保留，不污染日志）。

### 12.4 Azure 联调时：只改一张表

1. 打开 `voice/app/phonemes.py`，找到 `CANONICAL_MAP`；
2. 把实测到的写法加进去（**值必须是 `CANONICAL_PHONEMES` 里的符号**，写错 import 时立刻报错）：

```python
CANONICAL_MAP = {
    ...
    # --- Azure Speech IPA 实测补充（2026-xx-xx 联调）---
    "a": "æ",      # Azure 用 a 表示 TRAP 元音
    "ɜ˞": "ɜ",     # 带卷舌附加符的写法
}
```

3. 排查遗漏：起服务后跑几句，日志里会出现 `unmapped phoneme symbol 'xx'`；
   或在 python 里 `from app.phonemes import seen_unknown_phonemes; seen_unknown_phonemes()` 取全集；
4. 改完只需要重跑测试（`tests/test_phonemes.py` 会逐项校验表的不变量），**其它代码一律不用动**。

> 边界：本模块**不改语料、不改 `focus_phonemes`**（那是 corpus-dev 的线）。它只保证"voice 输出的音素符号是规范化的、可预测的"。
> 如果 corpus-dev 想把语料标注也对齐到同一空间，直接复用这张表（`canonicalize_all`）即可，不要另建一套。

## 13. 本地化：Piper TTS / faster-whisper ASR / GOP 发音评测（task-20）

目标：在**没有任何外网依赖**（HF 不可达、无 GPU）的情况下，voice 自己能合成示范音、自己做 ASR 与发音评测；
Azure 仍可选（`hybrid` 模式优先云、失败落本地）。

### 13.1 模型来源清单（全部 ModelScope，已实测下载可用）

| 用途 | ModelScope 仓库 | 文件 | 去向 |
|---|---|---|---|
| TTS 音色 | `rhasspy/piper-voices`（官方合集）| `en/en_US/lessac/medium/*`（63MB）、`en/en_US/amy/low/*`（63MB）、`voices.json` | `.local-models/piper/` |
| TTS 音色（备选）| `Trelis/piper-en-us-ryan-medium` | `model.onnx`（63MB）+ `model.onnx.json` | 同上 |
| ASR | `pengzhendong/faster-whisper-small.en`（另有 `tiny`/`base`/`medium`/`large-v3`）| `model.bin`（484MB）+ `tokenizer.json` + `vocabulary.txt` | `.local-models/whisper/small.en/` |
| 音素 CTC（GOP）| `onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX` | `onnx/model_int8.onnx`（318MB）+ `vocab.json` + `preprocessor_config.json` | `.local-models/gop/` |

下载（**必须隔离 HOME**，否则 ModelScope SDK 写 `~/.modelscope` 会报只读文件系统）：

```bash
export HOME=$PWD/.isolated-home MODELSCOPE_CACHE=$PWD/.ms-cache
.venv/bin/python -c "from modelscope import snapshot_download as d; \
  d('rhasspy/piper-voices', allow_patterns=['en/en_US/lessac/medium/*','en/en_US/amy/low/*','voices.json'], cache_dir='.ms-cache')"
# faster-whisper-small.en / wav2vec2-lv-60-espeak-cv-ft-ONNX 同理
```

模型统一放在 `LOCAL_MODELS_DIR`（默认 `<voice>/.local-models`；容器里建议 `/models/local`），
**不进 git**（`.gitignore` 已排除 `.local-models/`、`.ms-cache/`、`.isolated-home/`）。

### 13.2 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOCAL_MODELS_DIR` | `<MODEL_CACHE_DIR>/local` 或 `<voice>/.local-models` | 本地模型根目录 |
| `PIPER_VOICE` | `en_US-lessac-medium` | 默认音色名（对应 `<name>.onnx`）|
| `PIPER_VOICE_DIR` | `$LOCAL_MODELS_DIR/piper` | 音色目录 |
| `WHISPER_MODEL` / `WHISPER_MODEL_PATH` | `small.en` / 空 | whisper 名字 / 直接指定本地模型目录 |
| `WHISPER_CPU_THREADS` | `4` | CPU 线程数 |
| `GOP_MODEL_PATH` | 空 | 直接指定 GOP `model_int8.onnx`（或含 `vocab.json` 的目录）|

依赖：本地能力需要 `requirements-local.txt`（piper-tts / onnxruntime / faster-whisper，约 +300MB；
**不需要 torch/transformers**），与基础 `requirements.txt` 分开安装。下载模型另外需要 `modelscope`。

### 13.3 实测数据（本机 CPU：i9-9900K 10 核 / 无 GPU / 无 ffmpeg）

**A. 本地 TTS（Piper `en_US-lessac-medium`，22.05kHz WAV）vs Azure 同句**（60 字符英文）：
| | wall | audio | **RTF** | 输出 |
|---|---|---|---|---|
| Piper（稳态，模型已加载）| **153ms** | 4.24s | **0.036** | WAV 22.05kHz |
| Azure（同句 3 次均值）| 2115ms | 5.50s | 0.385 | MP3 24kHz |
| 比值 | **14×** 更快 | | | |

- Piper 首次调用（含模型加载）约 0.2–1.6s，之后稳态 113–177ms；CPU 时间 ≈0.18×音频时长（onnxruntime 多线程，wall 远小于 CPU）。
- 与任务背景里的 Azure `RTF=9.84`（短句固定延迟占主导）相比，本地 RTF 0.036 **远低于 0.3 的目标**。
- `rate="slow"` 用 `length_scale=1.35` 拉长音素，给孩子的示范可放慢。

**B. 本地 ASR（faster-whisper small.en，int8，CPU）**：真实儿童录音 40 条 →
WER **mean 0.295 / median 0.171**，RTF mean **0.371**（max 1.2）；词级时间戳正常。
其中 29/40 条 WER≤0.5；WER=1.0 的几条是环境噪声大/几乎无声的录音。

**C. 本地评测（GOP）**：RTF **0.131**（630ms/条，6s 音频），音素级输出落在 canonical-v1 空间。

### 13.4 GOP 的质量结论：**不可用（不能替代 Azure 做薄弱音素判定）**

对照实验（`scripts/gop_eval.py`，只读 `web/data/` 与 `app.db`，全量 40 条真实录音，不挑样本）：

| 指标 | 数值 |
|---|---|
| 样本 | 40 条 attempt（39 条成功配对），**634** 个音素配对 |
| Pearson r | **0.350** |
| Spearman ρ | **0.360**（阈值 0.4）|
| 每句"最差 5 个音素"重合 | **1.85/5**（n=34，随机期望≈1.4）|
| 按音素符号聚合（30 个符号）| r=0.245, ρ=0.195（**不能**排出"哪些音最弱"）|
| 本地分 vs Azure 分 | 58.4±40.8 vs 79.4±27.0 |

判定：**ρ < 0.4 → 不可用**。原因分析（我们做了 4 种打分公式的对照，r 都落在 0.23–0.38，
说明不是公式没调好）：
1. **模型不是为打分训练的**：`wav2vec2-lv-60-espeak-cv-ft` 是 60 语言 espeak 音素的**识别**模型，
   词表 392 个符号、后验分布很宽；它不是英语专用、也不是发音错误导向的模型（对比：Azure 是专门的 PA 模型）。
2. **帧级对齐很粗**：强制对齐后很多音素只占 1 帧（20ms），单帧后验噪声大；儿童语音的停顿/拖音让对齐更容易错。
3. **儿童语音 + 录音质量**：40 条里有 11 条 ASR WER>0.5（环境噪声/几乎没声），任何后验方法都会退化。
4. **Azure 分数高度偏斜**（mean 79、大量 100），可区分的方差本来就小。

**结论与建议**：`gop` 保留为**可选、默认不启用**的 provider（代码、对齐、打分、canonical-v1 集成都完成并有测试；
启用方式：`VOICE_PA_PROVIDER=gop`），但**不要**用它写 `phoneme_mastery`/`srs_cards`。
`PROVIDER_MODE=local` 的默认 PA 仍是**词级** local（可靠），不会静默换成 GOP。若确实要本地音素评测，正确方向是：
(a) 换**英语专用、为发音评分训练**的音素模型（如 Kaldi/GOP 的 librispeech chain、或英语专用 wav2vec2 音素模型 + 词典强制对齐），
(b) 用**时长/能量先验**改进对齐，(c) 用真实的"人工标注错误音素"做校准，而不是拿 Azure 分数当唯一真值。
在那之前，`local` 模式下 PA 会自动回退到词级（`gop` 失败/关闭时），或直接用 `hybrid` 走 Azure。

## 14. 拍照 OCR：`POST /v1/ocr`（task-25/27 · 契约 v1.5/v1.6）

连读模式的入口之一：拍书页照片 → 识别英文 → 前端切句 → 逐句跟读+异步评分。
默认走 **DeepSeek 多模态（LLM 视觉）**；本地 `rapidocr` 仅作**可选离线兜底**（默认不安装）。
**不落盘**：照片只在内存里识别，不留任何文件（可能涉及孩子隐私）。

### 14.1 请求与响应

`multipart/form-data`：`image`（必填，JPEG/PNG/WebP…，≤10MB）。

```json
{
  "provider": "deepseek vision",
  "text": "Hello! My name is Lily.\nI like drawing cats and dogs.\nCan you see three birds in the tree?",
  "lines": [
    {"text": "Hello! My name is Lily.", "confidence": null},
    {"text": "I like drawing cats and dogs.", "confidence": null},
    {"text": "Can you see three birds in the tree?", "confidence": null}
  ],
  "width": 900, "height": 400,
  "elapsed_ms": 1307,
  "warnings": []
}
```

- `text` 按**行序**用 `\n` 连接（前端可直接 `split("\n")` 切句），`lines` 是同一批行。
- `lines[].confidence`：LLM 视觉**没有置信度 → `null`**（诚实，不编造）；本地 rapidocr 兜底时给真实分数。
- `capabilities.heic`（`/v1/health`）：bool，是否支持 HEIC/HEIF 解码（前端据此决定相册是否允许选 HEIC）。
- `warnings`：`image_downscaled`（缩放）、`no_text_found`（没识别到英文）、`llm_vision_failed`（LLM 失败已降级本地）、`image_encode_failed`（请求了返回图但编码失败）、`llm_empty_retried`（首次空、宽容提示词重试后仍空）、`llm_truncated`（重试后输出仍被 max_tokens 截断，返回的是部分内容）。
- **空结果重试**（task-35）：模型首次返回空时，会用更宽容的提示词 `OCR_PROMPT_RETRY` 再试一次
  （明确允许封面大标题/标签/装饰字，只有整张图完全没有英文字母才允许空），第二次的耗时计入 `elapsed_ms`；
  首次就非空则**只调用一次**。每次空返回都会打 WARNING 日志（含模型原始返回的长度与前 200 字符 `repr`，不含图片/base64），
  便于排查"真空串 / 只有空白 / 拒答话术"。
  另外两条防御（实测发现）：模型对"没有文字"的图**不会返回真正的空串**，而是返回字面量占位符
  （`<empty string>`、`（空字符串）`）或中文解释（"（注：由于原图几乎为空白…）"）——这些一律按空处理
  （占位符归一化 + **只保留含拉丁字母的行**），再触发宽容重试；否则会被 web 当成书页文字展示。
- **可选返回预处理图**（task-28）：请求加 `return_image=1`（或 `true`）时，响应多一个 `image_jpeg_b64`
  ——**纯 base64（不含 `data:` 前缀）**，就是实际送去识别的那张图（EXIF 已转正、长边 ≤1280、JPEG q85，fixture 900×400 约 100KB）。
  用于 web 存"我的书页"反复复读，避免存 3–8MB 手机原图。未请求时字段**缺失**（不是 `null`）；
  编码失败时给 `warnings:["image_encode_failed"]` 且不返回该字段。
- `width`/`height` 是**发送给识别引擎前**的尺寸（EXIF 转正 + 缩放后）。

### 14.2 Provider 链与预处理

`VOICE_OCR_PROVIDER=auto|llm|local`（默认 `auto`）：

| 值 | 行为 |
|---|---|
| `auto` | LLM 已配置 → `llm`；否则本地依赖可用 → `local`；都不可用 → 503 |
| `llm` | LLM 视觉为主；失败/超时（30s）→ 降级本地（若已装） |
| `local` | 只用本地 rapidocr（完全离线） |

- 发给 LLM 前：`ImageOps.exif_transpose` → RGB → **长边缩到 ≤1280**（1600→1280 约省 40% token）→ JPEG q85 → base64 data URL
  （900×400 实测 data URL 仅 26KB）。
- 发本地 rapidocr 前：EXIF 转正 → RGB → 长边 ≤1600（CPU 与精度都不需要更高）。
- 提示词要求"逐行输出英文原文、不编号不解释、保留标点、无英文返回空"，并防御性去掉模型自带的编号。
- 错误：非图片 → **400 `bad_request`**；>10MB → **413 `payload_too_large`**；LLM 失败且无本地兜底 → **503 `provider_unavailable`**。

#### 14.2.1 推理模型（`deepseek-flash`）的坑：reasoning 吃光 max_tokens（task-36）

`deepseek-flash` 是推理模型：先输出 `reasoning_content` 再输出 `content`。默认配置下（`max_tokens=800`）
思考会吃光全部额度 → `finish_reason=length`、`content` 为空/残缺 → 表现为"拍照识别返回空文字"。
实测同一张真实绘本照片（4160×3120）：

| 配置 | finish_reason | content | 耗时 |
|---|---|---|---|
| max_tokens=800（旧默认）| length | `"By the time they got"`（截断）| — |
| max_tokens=1500 + `thinking:disabled`（**新默认**）| stop | 完整 8 行 | **≈0.8–1.2s** |

所以 OCR 默认：
- `OCR_DISABLE_THINKING=1`：请求体带 `"thinking": {"type": "disabled"}`（实测 1010ms vs 5.9s，token 也更少）；
  若端点不认这个参数返回 **400**，自动降级为"不带该参数"重试一次，不报 500。
- `OCR_MAX_TOKENS=1500`（reasoning-off 后正文 + 余量）。
- **截断检测**：`finish_reason == "length"` 时打 WARNING（含 `completion_tokens` / `reasoning_tokens` / `content_len`），
  自动重试一次（`max_tokens` ×3、上限 4000、强制关思考）；仍截断 → `warnings:["llm_truncated"]` 并返回已拿到的部分内容。

### 14.3 依赖与体积（task-27 精简）

OCR 专用依赖已从**生产 `requirements.txt` 移除**（`rapidocr-onnxruntime` / `opencv-python` / `onnxruntime`；
`pillow` 保留，因为 LLM 路径也要用它做 EXIF/缩放/JPEG 编码）：

| 组合 | 额外体积 | 说明 |
|---|---|---|
| 默认（LLM 视觉）| 基础依赖含 `pillow` + `pillow-heif`（≈26MB，libheif）| 只需要 `.env` 配 `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` |
| 加离线兜底 | **≈ +157MB 镜像 / +165MB 常驻内存** | `pip install -r requirements-ocr-local.txt` 或 `uv sync --extra ocr-local` |

#### 14.3.1 实测（本机，真实 key，`deepseek-flash`）

| 场景 | provider | 耗时 | 结果 |
|---|---|---|---|
| `/v1/ocr`（fixture 900×400，3 行）| `deepseek vision` | HTTP 总 1.48s / 识别 1307ms | 3/3 全对，data URL 26KB |
| **屏蔽本地 OCR 依赖**（rapidocr/cv2/onnxruntime 不可 import）+ 真 key | `deepseek vision` | 897ms | 3/3 全对，本地模块一个都没 import |
| 生产依赖干净 venv（只装 `requirements.txt`）起服务 | — | — | `capabilities.ocr=false, ocr_provider=null`（无 LLM 配置时），服务正常启动 |
| 本地 rapidocr 兜底（LLM 失败时）| `rapidocr` | ~0.5–0.8s | 3/3 全对，带真实 confidence |

## 15. 当前采用的服务组合与预热（2026-10-25 决定）

### 15.1 结论：全部走 Azure，本地只做离线兜底

| 能力 | 采用 | 理由 |
|---|---|---|
| ASR | **azure** | 识别质量优先 |
| 发音评测 PA | **azure** | **本地 GOP 经对照实验判定不可用**（§13.4：Pearson r=0.350、Spearman ρ=0.360、最差 5 音素重合 1.85/5，4 种打分公式均 <0.4）。音素级质量是产品核心，本地替代不了 |
| TTS | **azure** | 本地 Piper 虽快 20–30 倍（RTF 0.030 vs 0.385），但用户接受 Azure 成本，优先取**音色一致性与质量**；且预热缓存成熟后延迟已被吸收 |
| LLM | **deepseek（远程）** | 对话质量与稳定性最好；本地 7B 需额外显存与运维成本 |

本地 provider（`piper` / `local` / `gop`）**全部保留但不在默认路径上**，作为断网兜底与实验开关：

```bash
# 想切回本地合成（需 .local-models/，见 §13.1）
VOICE_TTS_PROVIDER=piper
# 想启用本地 GOP 音素评测（已实测相关性不达标，仅建议做实验）
VOICE_PA_PROVIDER=gop
```

hybrid 模式下调用链仍是 `azure → 本地兜底 → mock`，**断网时不会哑掉**。

### 15.2 预热：Azure 慢，所以必须提前合成

Azure 合成新文本实测 **1–11 秒且波动极大**（服务端曾报 `RTF=9.84` 合成超时）。
把 300 句语料提前合成进本地缓存后，练习页「只听示范」/「跟我读」从 2–7 秒降到 **10–30ms**。

**一键预热（两种语速都要，别只预热 normal）**：

```bash
./scripts/warm-corpus.sh                 # normal + slow
./scripts/warm-corpus.sh --rate slow     # 只补儿童用的慢速
```

- `normal` —— 成人的示范音 + `pronounce` 参考音分析（内部固定用 normal）
- `slow` —— **儿童的示范音**（儿童模式默认 slow）。只预热 normal 的话，孩子那边每次仍要现合成
- 幂等：已缓存的句子会跳过，可随时重跑补缺失
- 缓存 key 含 `tts_provider`，**切换 provider 会导致原有缓存不可命中**（这是有意的：避免把本地合成音当 Azure 音色复用）

### 15.3 一个容易踩的坑：`DATA_DIR` 是相对当前工作目录解析的

`DATA_DIR=./data` 会按**进程的 cwd** 解析。从仓库根目录跑脚本会读到一个空目录，
看起来像"缓存全丢了"（作者本人就误判过一次）。跑任何直接读缓存的脚本前先 `cd voice`，
或显式传绝对路径 `DATA_DIR=/abs/path/to/voice/data`。

## 16. 已知限制 / 遗留

1. `azure` 代码路径**未做真机联调**（本机无 Azure 订阅、无 key）：SDK 调用逻辑按官方 API 编写并全部惰性导入，
   但首次接入云环境时需要按实际返回核对一次 phoneme/nbest 字段。
2. `local` provider 的模型仅在真正调用时加载；pytest 用 monkeypatch 覆盖，未做 tiny 模型的端到端推理验证。
3. provider 超时用线程池 `future.result(timeout)` 实现：超时后请求立即降级，但被丢弃的线程会自然结束（V1 可接受）。
4. `stress_misplaced` 目前是"斜率差异较大"的启发式，未做重音（能量/时长）建模。
5. `unscripted` 模式下 `pron/accuracy/completeness` 为 `null`（无参考文本，不臆造分数）。

---

## 17. 禁止静默降级 + 镜像依赖断言（task-44 线上事故）

**事故**：`requirements.txt` 是 `uv export` 生成的，但漏了 `--extra azure` → 线上镜像里没有
`azure-cognitiveservices-speech` → TTS/ASR/PA 全部**静默回落到 mock**并返回 200：
用户听到的"浑浊"其实是 mock 单音（16kHz、>4kHz 零能量），这几天的跟读评分也全是假的；
`/v1/health` 还显示 `providers.tts=azure`（谎报）。

修复（三层防回归）：

1. **依赖必须重新导出并带 azure extra**：
   ```bash
   uv export --frozen --no-dev --extra azure --no-emit-project --format requirements-txt --no-hashes \
     --index-url https://mirrors.aliyun.com/pypi/simple/ > requirements.txt
   ```
   产出必须包含 `azure-cognitiveservices-speech==1.52.0`（及其传递依赖 `azure-core`）。
2. **Dockerfile 构建期硬断言**：`uv pip install` 之后执行
   `RUN python -c "import azure.cognitiveservices.speech"` —— SDK 缺失时**镜像构建直接失败**，
   不会再产出"能用但全部降级"的镜像。
3. **禁止静默降级**：`PROVIDER_MODE` 为 `cloud` / `hybrid` / `local`（非 mock）时，若实际产出者是
   `mock` 或 `degraded`，TTS/ASR/PA 一律返回 **503 `provider_unavailable`**，message 明确提示
   「请重建镜像（docker compose build voice）或修复 .env 配置」。只有 `PROVIDER_MODE=mock` 才允许 mock。
   （hybrid 下回落到 `local`/`piper`/`gop` 等**真实** provider 仍允许 200——那不是假声音。）

**`/v1/health` 字段（task-44 新增，契约 v1.7）**：

```json
{
  "providers": {"asr": "azure", "pa": "azure", "tts": "azure", "llm": "deepseek"},   // 配置值（语义不变）
  "providers_effective": {"asr": "none", "pa": "none", "tts": "none", "llm": "template"}, // 实际可用
  "degraded": {
    "tts": {"configured": "azure", "effective": "none",
            "reason": "azure-cognitiveservices-speech is not installed; run `uv sync --extra azure`"}
  }
}
```

- `degraded`：空对象 `{}` = 健康；非空时按 kind（`asr`/`pa`/`tts`）给出配置值、实际可用值与原因。
- `providers` 语义保持不变（配置值）；**判断是否真的可用请看 `degraded`**（web/自检脚本用）。

**缓存污染结论**：旧代码的 `/v1/tts` 缓存 key 用"配置的 primary provider 名"，而写缓存的字节可能是
mock/local 兜底产出 → 理论上会把 mock 音频写进 `<azure-key>.wav`（线上那些 16kHz 文件即是此类或旧 SDK bug 产物）。
现已加两道防线：① 只有**实际产出者 == key 里的 provider** 才写缓存；② task-42 的低采样率自愈会在命中时
清掉 `<azure-key>` 下 16k/22.05k 的坏条目并重新合成 24k（详见 §8.4、§9.4）。历史污染文件无需手工处理。

