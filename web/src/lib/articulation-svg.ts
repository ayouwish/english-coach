/**
 * 参数化口型动画的 SVG 生成器（task-16 D 的核心）。
 *
 * 输入是 `articulation.ts` 里的 10 个发音参数（0..1），输出一段可 SSR 的内联 SVG：
 * 同一个渲染器既能画任意单音，也能并排对比两个音并高亮差异。
 *
 * 为什么是"生成字符串"而不是纯 JSX：
 *   1) 服务端就能渲染出有意义的静态帧（HTML 里可断言、无 JS 也不空白）；
 *   2) 自测脚本可以直接 import 本文件、对几何与 data-* 属性做断言（Node 原生跑 TS）。
 * SVG 内容全部由数值与固定文案生成，标签文本经过转义，无注入面。
 *
 * 坐标约定（与 articulation.ts 文件头一致，0..1）：
 *   tongueHigh 0=最低 1=最高；tongueBack 0=最前 1=最后；lipOpen/lipRound/airflow 同理。
 */
import type { Articulation, ArticulationArt, Constriction } from "./articulation";

export interface FigureOptions {
  isChild?: boolean;
  /** 是否输出动画（false = 只输出静态目标帧，用于 prefers-reduced-motion / 不可见时） */
  animated?: boolean;
  /** 对比模式下的差异提示（例如"舌尖伸出 vs 藏在齿后"） */
  compareNote?: string | null;
  /** 对比模式下高亮差异点 */
  highlightDiff?: boolean;
  size?: number;
}

const W = 260;
const H = 190;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** 气流最受阻的位置（"阻碍点"）在剖面里的坐标 */
export function constrictionPoint(art: ArticulationArt): { x: number; y: number } {
  const lipShift = clamp01(art.lipOpen) * 6;
  switch (art.constriction) {
    case "lips":
      return { x: 200 + lipShift, y: 88 };
    case "teeth":
      return { x: 186, y: 86 };
    case "dental":
      return { x: 194, y: 88 };
    case "alveolar":
      return { x: 176, y: 82 };
    case "postalveolar":
      return { x: 167, y: 78 };
    case "palatal":
      return { x: 145, y: 70 };
    case "velar":
      return { x: 116, y: 74 };
    case "glottal":
      return { x: 62, y: 146 };
    default:
      // 元音：无阻碍，取口腔中部作为"气流经过"的示意点
      return { x: 150, y: 90 - clamp01(art.tongueHigh) * 14 };
  }
}

/** 舌尖位置：由 constriction 决定落点，再按 tongueHigh/tongueBack 微调 */
export function tongueTipPoint(art: ArticulationArt): { x: number; y: number } {
  const high = clamp01(art.tongueHigh);
  const back = clamp01(art.tongueBack);
  const base: Record<Constriction, { x: number; y: number }> = {
    lips: { x: 196, y: 92 },
    teeth: { x: 190, y: 90 },
    dental: { x: 198, y: 88 }, // 舌尖伸到上下齿之间（θ/ð 的关键差异点）
    alveolar: { x: 178, y: 84 },
    postalveolar: { x: 170, y: 79 },
    palatal: { x: 150, y: 72 },
    velar: { x: 128, y: 86 },
    glottal: { x: 172, y: 104 },
    none: { x: 174, y: 100 },
  };
  const p = base[art.constriction] ?? base.none;
  return { x: r1(p.x + (0.5 - back) * 8), y: r1(p.y - (high - 0.5) * 12) };
}

/** 舌头 path：从舌根到舌尖的连续曲线 */
export function tonguePath(art: ArticulationArt): string {
  const tip = tongueTipPoint(art);
  const high = clamp01(art.tongueHigh);
  const back = clamp01(art.tongueBack);
  const bodyX = 150 - back * 26;
  const bodyY = 138 - high * 46;
  return (
    `M 92 148 C 108 ${r1(bodyY + 18)} ${r1(bodyX - 18)} ${r1(bodyY)} ${r1(tip.x - 14)} ${r1(tip.y + 10)} ` +
    `L ${r1(tip.x)} ${r1(tip.y)} C ${r1(tip.x - 12)} ${r1(tip.y + 10)} ${r1(bodyX + 6)} ${r1(bodyY + 26)} 108 150 Z`
  );
}

/** 中性（静止）舌尖位置：用于"循环教学动作"的起止帧以及差异对比 */
function neutralTip(art: ArticulationArt): { x: number; y: number } {
  return tongueTipPoint({ ...art, constriction: "none", tongueHigh: 0.42, tongueBack: 0.42 });
}

function lipsGeometry(art: ArticulationArt) {
  const open = 4 + clamp01(art.lipOpen) * 26;
  const round = clamp01(art.lipRound);
  const protrude = round * 12;
  const cy = 88;
  return {
    upper: { x: 190 + protrude, y: cy - open / 2 },
    lower: { x: 190 + protrude, y: cy + open / 2 },
    open,
    round,
    protrude,
  };
}

/**
 * 生成一个音素的侧面剖面 SVG（静态帧 + 可选 CSS 动画）。
 */
export function buildArticulationSvg(info: Articulation, options: FigureOptions = {}): string {
  const { art } = info;
  const isChild = Boolean(options.isChild);
  const animated = options.animated !== false;
  const size = options.size ?? 300;
  const tip = tongueTipPoint(art);
  const neutral = neutralTip(art);
  const dx = r1(tip.x - neutral.x);
  const dy = r1(tip.y - neutral.y);
  const cp = constrictionPoint(art);
  const lips = lipsGeometry(art);
  const airflow = clamp01(art.airflow);
  // 塞音与鼻音都有"闭锁"阶段（鼻音只是气流改从鼻腔出）
  const hasClosure = art.manner === "stop" || art.manner === "nasal";
  const label = isChild ? info.childLabel : info.ipa;
  // 文案本身可能已带句号，拼进 desc 前去掉尾部标点，避免出现「。。」
  const tipText = (isChild ? info.tipChildZh : info.tipZh).replace(/[。.]+$/, "");

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${W} ${H}" width="${size}" height="${Math.round((size * H) / W)}" role="img" ` +
      `data-testid="articulation-svg" data-ipa="${esc(info.ipa)}" data-constriction="${art.constriction}" ` +
      `data-manner="${art.manner}" data-voiced="${art.voiced ? 1 : 0}" data-nasal="${art.nasal ? 1 : 0}" ` +
      `data-tongue-high="${clamp01(art.tongueHigh)}" data-tongue-back="${clamp01(art.tongueBack)}" ` +
      `data-lip-open="${clamp01(art.lipOpen)}" data-lip-round="${clamp01(art.lipRound)}" ` +
      `data-airflow="${airflow}" data-duration="${art.durationHint}" ` +
      `xmlns="http://www.w3.org/2000/svg" class="art-figure${animated ? " art-anim" : ""}">`,
  );
  parts.push(`<title>${esc(label)} 的发音口型剖面</title>`);
  parts.push(
    `<desc>${esc(
      (isChild ? "" : `音素 ${info.ipa}。`) +
        `发音要点：${tipText}。阻碍位置：${art.constriction}。` +
        (art.voiced ? "声带振动。" : "声带不振动。") +
        (art.nasal ? "气流从鼻腔出。" : ""),
    )}</desc>`,
  );

  // 动画样式（仅在 animated 时附加 .art-anim 才会动；静态帧就是"目标口型"）
  parts.push(`<style>
.art-figure .art-tongue-motion{transform:translate(0,0)}
.art-figure.art-anim .art-tongue-motion{animation:artTongueLoop 4.2s ease-in-out infinite}
.art-figure.art-anim .art-flow{animation:artFlow 0.9s linear infinite}
.art-figure.art-anim .art-folds{animation:artFoldPulse 0.7s ease-in-out infinite}
.art-figure.art-anim .art-nasal-path{animation:artNasal 1.6s ease-in-out infinite}
.art-figure.art-anim .art-burst{animation:artBurst 1.6s ease-out infinite}
@keyframes artTongueLoop{0%,14%{transform:translate(0,0)}44%,66%{transform:translate(var(--art-dx),var(--art-dy))}100%{transform:translate(0,0)}}
@keyframes artFlow{to{stroke-dashoffset:-28}}
@keyframes artFoldPulse{0%,100%{opacity:.35}50%{opacity:1}}
@keyframes artNasal{0%,100%{opacity:.35}50%{opacity:.95}}
@keyframes artBurst{0%,38%{opacity:0;transform:scale(.2)}52%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.2)}}
</style>`);

  // 鼻腔通道（鼻音时高亮）
  parts.push(
    `<path data-part="nasal" class="${art.nasal ? "art-nasal-path" : ""}" d="M 150 34 C 128 34 108 44 96 60" ` +
      `fill="none" stroke="${art.nasal ? "#7fb3ff" : "#dbe2f5"}" stroke-width="${art.nasal ? 9 : 6}" stroke-linecap="round" opacity="${art.nasal ? 0.8 : 0.5}" />`,
  );

  // 头部轮廓（简化侧面）
  parts.push(
    `<path data-part="head" d="M 34 166 C 26 120 34 66 66 36 C 96 12 140 12 160 34 C 172 46 180 56 196 62 ` +
      `C 204 66 204 72 196 74 C 190 76 186 78 184 80 C 180 96 186 100 184 106 C 180 120 168 132 146 140 ` +
      `C 120 150 84 158 60 168 Z" fill="#fdf7f2" stroke="#c9b8ad" stroke-width="2" />`,
  );

  // 硬腭 + 软腭（鼻音时软腭下降）
  parts.push(
    `<path data-part="palate" d="M 184 78 C 160 70 132 64 112 62" fill="none" stroke="#c9b8ad" stroke-width="5" stroke-linecap="round" />`,
  );
  parts.push(
    `<path data-part="velum" d="${
      art.nasal ? "M 112 62 C 104 72 100 82 96 90" : "M 112 62 C 104 64 98 68 92 72"
    }" fill="none" stroke="#c9b8ad" stroke-width="5" stroke-linecap="round" />`,
  );

  // 上齿 / 下齿（下齿随 lipOpen 张开）
  parts.push(
    `<rect data-part="teeth-upper" x="172" y="${r1(lips.upper.y - 8)}" width="12" height="9" rx="2" fill="#fff" stroke="#b9c2d6" />`,
  );
  parts.push(
    `<rect data-part="teeth-lower" x="170" y="${r1(lips.lower.y - 1)}" width="12" height="9" rx="2" fill="#fff" stroke="#b9c2d6" />`,
  );

  // 舌：中性位置（虚线，起止帧）+ 目标位置（实心，可循环移动）
  parts.push(
    `<path data-part="tongue-neutral" d="${tonguePath({ ...art, constriction: "none", tongueHigh: 0.42, tongueBack: 0.42 })}" ` +
      `fill="none" stroke="#f0b9a8" stroke-width="1.6" stroke-dasharray="4 4" opacity="0.85" />`,
  );
  parts.push(
    `<g class="art-tongue-motion" style="--art-dx:${dx}px;--art-dy:${dy}px">` +
      `<path data-part="tongue" d="${tonguePath(art)}" fill="#f7a58c" stroke="#d9734f" stroke-width="2" />` +
      `</g>`,
  );

  // 唇（lipOpen 控制开合，lipRound 控制前突/圆展）
  if (lips.round > 0.55) {
    parts.push(
      `<ellipse data-part="lips" cx="${r1(194 + lips.protrude)}" cy="88" rx="${r1(5 + lips.round * 5)}" ry="${r1(
        4 + lips.open / 2,
      )}" fill="none" stroke="#e0796f" stroke-width="3" />`,
    );
  }
  parts.push(
    `<path data-part="lips" d="M 182 ${r1(lips.upper.y - 3)} C 192 ${r1(lips.upper.y - 4)} ${r1(198 + lips.protrude)} ${r1(
      lips.upper.y,
    )} ${r1(196 + lips.protrude)} ${r1(lips.upper.y + 2)}" fill="none" stroke="#e0796f" stroke-width="3.5" stroke-linecap="round" />`,
  );
  parts.push(
    `<path data-part="lips" d="M 180 ${r1(lips.lower.y + 3)} C 190 ${r1(lips.lower.y + 4)} ${r1(198 + lips.protrude)} ${r1(
      lips.lower.y,
    )} ${r1(196 + lips.protrude)} ${r1(lips.lower.y - 2)}" fill="none" stroke="#e0796f" stroke-width="3.5" stroke-linecap="round" />`,
  );

  // 声门 / 声带（voiced 时脉动）
  parts.push(
    `<g data-part="vocal-folds" class="art-folds" opacity="${art.voiced ? 0.9 : 0.35}">` +
      `<path d="M 58 150 L 66 144 M 58 158 L 66 152" stroke="${art.voiced ? "#5b5bd6" : "#9aa0bb"}" stroke-width="3" stroke-linecap="round" />` +
      `</g>`,
  );

  // 气流：从声门经口腔到阻碍点；强摩擦加"摩擦标记"
  if (airflow > 0.05) {
    const width = r1(1.2 + airflow * 2.6);
    const dash = r1(6 + airflow * 8);
    parts.push(
      `<path data-part="airflow" class="art-flow" d="M 62 150 C 84 132 104 116 ${r1(cp.x - 34)} ${r1(
        cp.y + 12,
      )} C ${r1(cp.x - 10)} ${r1(cp.y + 4)} ${r1(cp.x)} ${r1(cp.y)} ${r1(cp.x + 12)} ${r1(
        cp.y - 2,
      )}" fill="none" stroke="#5b8def" stroke-width="${width}" stroke-dasharray="${dash} ${dash}" stroke-linecap="round" opacity="${r1(
        0.35 + airflow * 0.55,
      )}" />`,
    );
    if (airflow > 0.5) {
      parts.push(
        `<g data-part="friction">` +
          `<path d="M ${r1(cp.x - 6)} ${r1(cp.y - 8)} l 6 -6 M ${r1(cp.x - 2)} ${r1(cp.y - 4)} l 6 -6 ` +
          `M ${r1(cp.x + 2)} ${r1(cp.y)} l 6 -6" stroke="#5b8def" stroke-width="1.6" stroke-linecap="round" opacity="0.85" />` +
          `</g>`,
      );
    }
  } else if (hasClosure) {
    // 塞音/鼻音：闭锁（实心阻碍块）；塞音还有爆破（星形）
    parts.push(
      `<rect data-part="closure" x="${r1(cp.x - 3)}" y="${r1(cp.y - 8)}" width="7" height="16" rx="2" fill="#5b5bd6" opacity="0.85" />`,
    );
    if (art.manner === "stop") {
      parts.push(
        `<g data-part="burst" class="art-burst" style="transform-origin:${r1(cp.x + 8)}px ${r1(cp.y)}px">` +
          `<path d="M ${r1(cp.x + 2)} ${r1(cp.y)} l 9 -6 l -2 7 l 8 1 l -7 4 l 4 6 l -8 -3" fill="#f59e0b" opacity="0.9" />` +
          `</g>`,
      );
    }
  }

  // 阻碍点标记（教学上"气流在这里被挡住"）
  parts.push(
    `<circle data-part="constriction" cx="${r1(cp.x)}" cy="${r1(cp.y)}" r="4.5" fill="none" ` +
      `stroke="${art.constriction === "none" ? "#c7c9f2" : "#5b5bd6"}" stroke-width="2" stroke-dasharray="${
        art.constriction === "none" ? "3 3" : "0"
      }" />`,
  );

  // 对比模式：高亮差异点（舌尖位置 + 一句文字）
  if (options.highlightDiff) {
    parts.push(
      `<circle data-part="diff-highlight" cx="${r1(tip.x)}" cy="${r1(tip.y)}" r="12" fill="none" stroke="#ef4444" ` +
        `stroke-width="2" stroke-dasharray="4 3" />`,
    );
    if (options.compareNote) {
      parts.push(
        `<text data-part="diff-note" x="8" y="182" font-size="${isChild ? 13 : 11}" fill="#ef4444">${esc(
          options.compareNote,
        )}</text>`,
      );
    }
  }

  // 文字标注：音素/儿童名 + 时长提示
  parts.push(
    `<text data-part="label" x="${W - 8}" y="16" text-anchor="end" font-size="${isChild ? 15 : 13}" font-weight="700" fill="#1b1f3b">${esc(
      label,
    )}</text>`,
  );
  parts.push(
    `<text data-part="duration" x="8" y="16" font-size="${isChild ? 13 : 11}" fill="#6b7290">${
      art.durationHint === "long" ? "长音" : art.durationHint === "diphthong" ? "双元音（滑动）" : "短音"
    }</text>`,
  );
  parts.push(`</svg>`);
  return parts.join("");
}

/** 文本等价描述（无障碍 + 自测用：关键动作必须能读出来） */
export function describeArticulation(info: Articulation, isChild = false): string {
  const { art } = info;
  const mannerZh: Record<string, string> = {
    vowel: "元音",
    diphthong: "双元音",
    stop: "塞音（先闭锁再爆破）",
    fricative: "擦音（气流摩擦）",
    affricate: "塞擦音（先闭锁再摩擦）",
    nasal: "鼻音（气从鼻腔出）",
    liquid: "流音",
    glide: "滑音",
  };
  const where: Record<string, string> = {
    none: "口腔中部（无阻碍）",
    lips: "双唇",
    teeth: "唇齿",
    dental: "上下齿之间",
    alveolar: "上齿龈",
    postalveolar: "齿龈后",
    palatal: "硬腭",
    velar: "软腭",
    glottal: "声门",
  };
  return [
    isChild ? info.childLabel : `音素 ${info.ipa}`,
    mannerZh[art.manner] ?? art.manner,
    `舌位：${art.tongueHigh > 0.66 ? "高" : art.tongueHigh < 0.34 ? "低" : "中"}、${
      art.tongueBack > 0.66 ? "靠后" : art.tongueBack < 0.34 ? "靠前" : "居中"
    }`,
    `唇形：${art.lipRound > 0.6 ? "圆唇" : art.lipOpen > 0.6 ? "张大" : art.lipOpen < 0.25 ? "闭合" : "自然"}`,
    `阻碍位置：${where[art.constriction] ?? art.constriction}`,
    art.voiced ? "声带振动" : "声带不振动",
    art.airflow > 0.5 ? "强气流摩擦" : art.airflow > 0.05 ? "弱气流" : art.manner === "stop" ? "闭锁后爆破" : "无明显气流",
    art.nasal ? "气流同时从鼻腔出" : "",
  ]
    .filter(Boolean)
    .join("；");
}
